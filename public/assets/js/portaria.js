// public/assets/js/portaria.js
// Portaria Offline-First (PRD_EVENTOS.md, item 4.3).
//
// Como funciona:
//  1. ANTES da festa, com internet: "Baixar lista" traz a chave do evento
//     (Worker) e todos os ingressos (Firestore) para o IndexedDB do aparelho.
//  2. NA festa: cada QR e conferido localmente (assinatura HMAC + lista), sem
//     depender de rede. A entrada e gravada no aparelho na hora.
//  3. Cada leitura entra numa fila (syncQueue) que sobe para o Firestore assim
//     que houver conexao. Se dois aparelhos liberarem o mesmo ingresso sem
//     rede, o segundo vira um "conflito" visivel na aba Registro.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
    getFirestore, collection, doc, getDoc, getDocs, onSnapshot, query, where,
    runTransaction, Timestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { APP_ID, firebaseConfig, esc, toDate, pad2, shortDateTime, callWorker } from "./fz-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
auth.languageCode = "pt-BR";

const IS_LOCAL = ["localhost", "127.0.0.1"].indexOf(location.hostname) !== -1;
const TOKEN_REGEX = /^(v1|k1):([A-Za-z0-9-]{8,64}):([a-z0-9][a-z0-9-]{1,60}):([A-Za-z0-9]{6,128}):(\d{6,12})\.([A-Za-z0-9_-]{20,64})$/;
const JSQR_URL = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
const JSQR_SRI = "sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx";
const RESCAN_GAP_MS = 2500;
const OK_AUTOCLOSE_MS = 1300;
const STATUS_LABEL = { valid: "Válido", used: "Já entrou", reserved: "Não pago", cancelled: "Cancelado", refunded: "Estornado", expired: "Expirado" };

const state = {
    user: null,
    role: null,
    events: [],
    eventId: null,
    eventKey: null,
    syncedAt: 0,
    tickets: new Map(),
    queue: [],
    conflicts: [],
    log: [],
    unsubTickets: null,
    stream: null,
    detector: null,
    scanning: false,
    busy: false,
    resultOpen: false,
    resultTimer: null,
    lastRaw: "",
    lastAt: 0,
    flushing: false,
    soundOn: true,
    audio: null,
    wakeLock: null,
    tab: "scan"
};

const byId = function (id) { return document.getElementById(id); };
const ticketsCol = function () { return collection(db, "artifacts", APP_ID, "public", "data", "tickets"); };
const ticketRef = function (id) { return doc(db, "artifacts", APP_ID, "public", "data", "tickets", id); };

function toast(message, type) {
    const container = byId("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "toast" + (type === "error" ? " !bg-red-600" : "");
    el.textContent = String(message);
    container.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
}

function show(id) {
    ["pt-loading", "pt-login", "pt-denied", "pt-app"].forEach(function (x) {
        byId(x).classList.toggle("hidden", x !== id);
    });
    byId("pt-menu-btn").classList.toggle("hidden", id !== "pt-app");
}

function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* sem espaco */ } }
function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* ignorar */ } }

function norm(text) {
    return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function timeLabel(ms) {
    if (!ms) return "horário não registrado";
    const d = new Date(ms);
    const today = new Date();
    const hhmm = pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    if (d.toDateString() === today.toDateString()) return hhmm;
    return hhmm + " de " + pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1);
}

// ============================================================================
// INDEXEDDB
// ============================================================================
const DB_NAME = "fz-portaria";
let idbPromise = null;

function idb() {
    if (!idbPromise) {
        idbPromise = new Promise(function (resolve, reject) {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function () {
                const d = req.result;
                if (!d.objectStoreNames.contains("tickets")) {
                    d.createObjectStore("tickets", { keyPath: "id" }).createIndex("eventId", "eventId", { unique: false });
                }
                if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "id" });
                if (!d.objectStoreNames.contains("queue")) d.createObjectStore("queue", { keyPath: "qid", autoIncrement: true });
                if (!d.objectStoreNames.contains("conflicts")) d.createObjectStore("conflicts", { keyPath: "cid", autoIncrement: true });
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }
    return idbPromise;
}

function reqP(req) {
    return new Promise(function (resolve, reject) {
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
    });
}

async function idbGet(store, key) { return reqP((await idb()).transaction(store).objectStore(store).get(key)); }
async function idbAll(store) { return reqP((await idb()).transaction(store).objectStore(store).getAll()); }
async function idbPut(store, value) { return reqP((await idb()).transaction(store, "readwrite").objectStore(store).put(value)); }
async function idbAdd(store, value) { return reqP((await idb()).transaction(store, "readwrite").objectStore(store).add(value)); }
async function idbDel(store, key) { return reqP((await idb()).transaction(store, "readwrite").objectStore(store).delete(key)); }

async function idbTicketsOf(eventId) {
    return reqP((await idb()).transaction("tickets").objectStore("tickets").index("eventId").getAll(eventId));
}

async function idbPutTickets(rows, removeIds) {
    const d = await idb();
    return new Promise(function (resolve, reject) {
        const tx = d.transaction("tickets", "readwrite");
        const st = tx.objectStore("tickets");
        (removeIds || []).forEach(function (id) { st.delete(id); });
        rows.forEach(function (r) { st.put(r); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
    });
}

// ============================================================================
// ASSINATURA (HMAC-SHA256 com a chave do evento)
// ============================================================================
function b64urlToBytes(text) {
    const b64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function importEventKey(rawBytes) {
    // Nao exportavel: a chave fica utilizavel no aparelho, mas nao pode ser lida de volta
    return crypto.subtle.importKey("raw", rawBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
}

async function verifyToken(payload, macB64) {
    try {
        return await crypto.subtle.verify("HMAC", state.eventKey, b64urlToBytes(macB64), new TextEncoder().encode(payload));
    } catch (e) {
        return false;
    }
}

// ============================================================================
// ACESSO
// ============================================================================
async function resolveRole(user) {
    const cacheKey = "fz-portaria-role:" + user.uid;
    const cached = lsGet(cacheKey);
    const check = async function () {
        const adminSnap = await getDoc(doc(db, "artifacts", APP_ID, "admins", user.uid));
        if (adminSnap.exists()) return "admin";
        const staffSnap = await getDoc(doc(db, "artifacts", APP_ID, "staff", user.uid));
        return staffSnap.exists() ? "staff" : "none";
    };
    if (cached === "admin" || cached === "staff") {
        // Abre na hora (funciona sem rede) e confere de novo em segundo plano
        if (navigator.onLine) {
            check().then(function (role) {
                lsSet(cacheKey, role);
                if (role === "none" && state.user && state.user.uid === user.uid) { stopCamera(); showDenied(user); }
            }).catch(function () { /* sem rede: mantem o acesso em cache */ });
        }
        return cached;
    }
    try {
        const role = await check();
        lsSet(cacheKey, role);
        return role;
    } catch (e) {
        return "offline";
    }
}

function showDenied(user) {
    byId("pt-denied-email").textContent = user.email || "(sem e-mail)";
    byId("pt-denied-uid").textContent = user.uid;
    show("pt-denied");
}

onAuthStateChanged(auth, async function (user) {
    stopTicketListener();
    state.user = user && !user.isAnonymous ? user : null;
    if (!state.user) { stopCamera(); show("pt-login"); return; }
    show("pt-loading");
    const role = await resolveRole(state.user);
    if (role === "offline") {
        byId("pt-loading").innerHTML = '<i class="fa-solid fa-wifi mr-2"></i> Sem internet. Conecte uma vez para liberar este aparelho.';
        window.addEventListener("online", function () { location.reload(); }, { once: true });
        return;
    }
    if (role !== "admin" && role !== "staff") { showDenied(state.user); return; }
    state.role = role;
    byId("pt-user").textContent = (state.user.email || "") + (role === "admin" ? " · diretoria" : " · equipe da portaria");
    byId("pt-admin-link").classList.toggle("hidden", role !== "admin");
    show("pt-app");
    await startApp();
});

byId("pt-login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const errEl = byId("pt-login-error");
    errEl.classList.add("hidden");
    try {
        await signInWithEmailAndPassword(auth, byId("pt-email").value.trim(), byId("pt-pass").value);
    } catch (err) {
        errEl.textContent = navigator.onLine ? "E-mail ou senha incorretos." : "Sem internet: o primeiro acesso precisa de conexão.";
        errEl.classList.remove("hidden");
    }
});

byId("pt-logout-denied").addEventListener("click", function () { signOut(auth); });
byId("pt-copy-uid").addEventListener("click", async function () {
    try {
        await navigator.clipboard.writeText(byId("pt-denied-uid").textContent);
        toast("Código copiado.");
    } catch (e) {
        toast("Não deu para copiar. Selecione o código manualmente.", "error");
    }
});

// ============================================================================
// EVENTOS E SINCRONIZACAO
// ============================================================================
async function startApp() {
    state.soundOn = lsGet("fz-portaria-sound") !== "0";
    byId("pt-sound").checked = state.soundOn;
    try { state.log = JSON.parse(lsGet("fz-portaria-log") || "[]"); } catch (e) { state.log = []; }
    state.queue = await idbAll("queue");
    state.conflicts = await idbAll("conflicts");

    const cached = await idbGet("meta", "events");
    state.events = cached && Array.isArray(cached.list) ? cached.list : [];
    renderEventSelect();
    const saved = lsGet("fz-portaria-event");
    if (saved && state.events.some(function (e) { return e.id === saved; })) await selectEvent(saved);
    else if (state.events.length) await selectEvent(state.events[0].id);
    else renderAll();

    refreshEvents();
    flushQueue();
    if (!("BarcodeDetector" in window)) loadJsQR().catch(function () { /* tenta de novo ao ligar a camera */ });
}

async function refreshEvents() {
    if (!navigator.onLine) return;
    try {
        const snap = await getDocs(collection(db, "artifacts", APP_ID, "public", "data", "events"));
        const list = [];
        snap.forEach(function (d) {
            const v = d.data();
            if (v.status === "draft" && state.role !== "admin") return;
            const starts = toDate(v.startsAt);
            list.push({ id: d.id, title: String(v.title || d.id), status: String(v.status || ""), startsAtMs: starts ? starts.getTime() : 0 });
        });
        // Mais proximos de agora primeiro (festas futuras antes das passadas)
        const now = Date.now() - 12 * 3600 * 1000;
        list.sort(function (a, b) {
            const fa = a.startsAtMs >= now, fb = b.startsAtMs >= now;
            if (fa !== fb) return fa ? -1 : 1;
            return fa ? a.startsAtMs - b.startsAtMs : b.startsAtMs - a.startsAtMs;
        });
        state.events = list;
        await idbPut("meta", { id: "events", list: list });
        renderEventSelect();
        if (!state.eventId && list.length) await selectEvent(list[0].id);
    } catch (e) {
        console.error(e);
    }
}

function renderEventSelect() {
    const sel = byId("pt-event");
    if (!state.events.length) {
        sel.innerHTML = '<option value="">Nenhum evento encontrado</option>';
        return;
    }
    sel.innerHTML = state.events.map(function (e) {
        const when = e.startsAtMs ? " · " + shortDateTime(new Date(e.startsAtMs)) : "";
        return '<option value="' + esc(e.id) + '"' + (e.id === state.eventId ? " selected" : "") + ">" + esc(e.title) + esc(when) + "</option>";
    }).join("");
}

function currentEvent() {
    return state.events.find(function (e) { return e.id === state.eventId; }) || null;
}

async function selectEvent(eventId) {
    stopTicketListener();
    state.eventId = eventId;
    lsSet("fz-portaria-event", eventId);
    byId("pt-event").value = eventId;

    const meta = await idbGet("meta", "event:" + eventId);
    state.eventKey = meta && meta.key ? meta.key : null;
    state.syncedAt = meta && meta.syncedAt ? meta.syncedAt : 0;

    state.tickets = new Map();
    const rows = await idbTicketsOf(eventId);
    rows.forEach(function (r) { state.tickets.set(r.id, r); });
    applyPendingOverlay();
    renderAll();
    if (state.eventKey && navigator.onLine) startTicketListener();
}

byId("pt-event").addEventListener("change", function (e) {
    if (e.target.value) selectEvent(e.target.value);
});

function normalizeTicket(id, v) {
    const checked = toDate(v.checkedInAt);
    const kitAt = toDate(v.comboRedeemedAt);
    const cpf = String(v.ownerCpf || "");
    const mat = String(v.ownerMatricula || "");
    return {
        id: id,
        eventId: String(v.eventId || ""),
        ownerName: String(v.ownerName || ""),
        ownerCpf: cpf,
        ownerMatricula: mat,
        batchName: String(v.batchName || ""),
        courtesy: v.courtesy === true,
        status: String(v.status || ""),
        qrSignature: String(v.qrSignature || ""),
        kitSignature: String(v.kitSignature || ""),
        isCombo: v.isCombo === true,
        comboItems: Array.isArray(v.comboItems) ? v.comboItems.map(String) : [],
        comboRedeemed: v.comboRedeemed === true,
        comboRedeemedAtMs: kitAt ? kitAt.getTime() : 0,
        checkedInAtMs: checked ? checked.getTime() : 0,
        searchName: norm(v.ownerName),
        searchDigits: (cpf + " " + mat).replace(/[^0-9 ]/g, "")
    };
}

// Leituras que ainda nao subiram valem mais que a copia vinda do servidor
function overlayOne(t) {
    for (const q of state.queue) {
        if (q.ticketId !== t.id) continue;
        if (q.type === "checkin" && t.status === "valid") { t.status = "used"; t.checkedInAtMs = q.atMs; }
        if (q.type === "kit" && !t.comboRedeemed) { t.comboRedeemed = true; t.comboRedeemedAtMs = q.atMs; }
    }
    return t;
}

function applyPendingOverlay() {
    state.tickets.forEach(function (t) { overlayOne(t); });
}

async function syncEvent() {
    const ev = currentEvent();
    if (!ev) { toast("Escolha um evento.", "error"); return; }
    if (!navigator.onLine) { toast("Sem internet. A lista já baixada continua valendo.", "error"); return; }
    const btn = byId("pt-sync");
    btn.disabled = true;
    btn.querySelector("span").textContent = "Baixando...";
    try {
        const res = await callWorker(state.user, "/api/events/" + encodeURIComponent(ev.id) + "/portaria-key", "GET", null);
        if (!res.ok || !res.data || !res.data.key) {
            throw new Error(res.data && res.data.message ? res.data.message : "Não foi possível baixar a chave do evento.");
        }
        const key = await importEventKey(b64urlToBytes(res.data.key));

        const snap = await getDocs(query(ticketsCol(), where("eventId", "==", ev.id)));
        const rows = [];
        snap.forEach(function (d) { rows.push(overlayOne(normalizeTicket(d.id, d.data()))); });

        const keep = new Set(rows.map(function (r) { return r.id; }));
        const stale = Array.from(state.tickets.keys()).filter(function (id) { return !keep.has(id); });
        await idbPutTickets(rows, stale);
        state.syncedAt = Date.now();
        await idbPut("meta", { id: "event:" + ev.id, key: key, syncedAt: state.syncedAt, count: rows.length });

        state.eventKey = key;
        state.tickets = new Map(rows.map(function (r) { return [r.id, r]; }));
        renderAll();
        startTicketListener();
        toast("Lista baixada: " + countSold() + " ingressos.");
        cacheShell();
    } catch (err) {
        console.error(err);
        toast(err && err.message ? err.message : "Falha ao baixar a lista.", "error");
    } finally {
        btn.disabled = false;
        btn.querySelector("span").textContent = state.syncedAt ? "Atualizar lista" : "Baixar lista";
    }
}

byId("pt-sync").addEventListener("click", syncEvent);

// Com internet, a lista se mantem atualizada sozinha (vendas de ultima hora,
// transferencias e entradas feitas em outros aparelhos)
function startTicketListener() {
    stopTicketListener();
    if (!state.eventId) return;
    const eventId = state.eventId;
    state.unsubTickets = onSnapshot(query(ticketsCol(), where("eventId", "==", eventId)), function (snap) {
        if (state.eventId !== eventId) return;
        const puts = [], removes = [];
        snap.docChanges().forEach(function (ch) {
            if (ch.type === "removed") {
                state.tickets.delete(ch.doc.id);
                removes.push(ch.doc.id);
            } else {
                const t = overlayOne(normalizeTicket(ch.doc.id, ch.doc.data()));
                state.tickets.set(t.id, t);
                puts.push(t);
            }
        });
        if (!puts.length && !removes.length) return;
        idbPutTickets(puts, removes).catch(function (e) { console.error(e); });
        state.syncedAt = Date.now();
        idbGet("meta", "event:" + eventId).then(function (meta) {
            if (meta) { meta.syncedAt = state.syncedAt; meta.count = state.tickets.size; return idbPut("meta", meta); }
        }).catch(function () { /* ignorar */ });
        renderAll();
    }, function (err) {
        console.error(err);
    });
}

function stopTicketListener() {
    if (state.unsubTickets) {
        try { state.unsubTickets(); } catch (e) { /* ja encerrado */ }
        state.unsubTickets = null;
    }
}

// ============================================================================
// VALIDACAO DE UMA LEITURA
// ============================================================================
function addLog(kind, title, name) {
    state.log.unshift({ kind: kind, title: title, name: name || "", atMs: Date.now() });
    state.log = state.log.slice(0, 40);
    lsSet("fz-portaria-log", JSON.stringify(state.log));
    byId("pt-last").textContent = title + (name ? " · " + name : "") + " · " + timeLabel(Date.now());
    if (state.tab === "log") renderLog();
}

async function enqueue(type, ticketId, token) {
    const item = { type: type, ticketId: ticketId, eventId: state.eventId, token: token, atMs: Date.now(), byUid: state.user.uid };
    item.qid = await idbAdd("queue", item);
    state.queue.push(item);
    return item;
}

async function markCheckin(t, token) {
    const item = await enqueue("checkin", t.id, token);
    t.status = "used";
    t.checkedInAtMs = item.atMs;
    await idbPut("tickets", t);
    renderCounters();
    flushQueue();
}

async function markKit(t, token) {
    const item = await enqueue("kit", t.id, token);
    t.comboRedeemed = true;
    t.comboRedeemedAtMs = item.atMs;
    await idbPut("tickets", t);
    renderCounters();
    flushQueue();
}

function bad(title, name, detail) {
    addLog("bad", title, name);
    showResult({ kind: "bad", title: title, name: name, detail: detail });
}

async function handleToken(raw) {
    if (state.busy) return;
    state.busy = true;
    try {
        const token = String(raw || "").trim();
        if (!state.eventId || !state.eventKey) {
            showResult({ kind: "warn", title: "Lista não baixada", detail: "Baixe a lista do evento (com internet) antes de ler ingressos." });
            return;
        }
        const m = TOKEN_REGEX.exec(token);
        if (!m) { bad("QR não reconhecido", "", "Este código não é um ingresso da FurioZOs."); return; }

        const kind = m[1], ticketId = m[2], eventId = m[3];
        if (eventId !== state.eventId) {
            bad("Outro evento", "", "Este ingresso é de outra festa. Confira o evento selecionado no aparelho.");
            return;
        }
        const dot = token.lastIndexOf(".");
        if (!(await verifyToken(token.slice(0, dot), token.slice(dot + 1)))) {
            bad("Assinatura inválida", "", "Possível ingresso falsificado. NÃO libere a entrada e avise a diretoria.");
            return;
        }

        let t = state.tickets.get(ticketId);
        if (!t && navigator.onLine) t = await fetchTicketOnline(ticketId);
        if (!t) {
            addLog("warn", "Fora da lista", "");
            showResult({
                kind: "warn",
                title: "Fora da lista",
                detail: "A assinatura é verdadeira, mas este ingresso não está na lista baixada (pode ter sido vendido depois). Atualize a lista assim que houver internet.",
                actions: kind === "v1" ? [{ label: "Liberar mesmo assim", run: function () { return overrideCheckin(ticketId, token); } }] : []
            });
            return;
        }

        if (t.status !== "valid" && t.status !== "used") {
            bad("Ingresso " + (STATUS_LABEL[t.status] || "inválido").toLowerCase(), t.ownerName, "Este ingresso não dá direito à entrada.");
            return;
        }
        if ((kind === "v1" ? t.qrSignature : t.kitSignature) !== token) {
            bad("QR antigo", t.ownerName, "Este ingresso foi transferido. Só vale o QR novo, na conta de " + (t.ownerName || "quem recebeu") + ".");
            return;
        }

        if (kind === "v1") {
            if (t.status === "used") {
                bad("Já entrou", t.ownerName, "Entrada registrada às " + timeLabel(t.checkedInAtMs) + ". Não libere de novo.");
                return;
            }
            await markCheckin(t, token);
            addLog("ok", "Entrada liberada", t.ownerName);
            showResult({
                kind: "ok", title: "Entrada liberada", name: t.ownerName,
                detail: (t.courtesy ? "Cortesia" : t.batchName) + (t.isCombo && !t.comboRedeemed ? " · tem kit para retirar" : "")
            });
            return;
        }

        // QR do kit (combo)
        if (t.comboRedeemed) {
            bad("Kit já retirado", t.ownerName, "Retirada registrada às " + timeLabel(t.comboRedeemedAtMs) + ".");
            return;
        }
        await markKit(t, token);
        addLog("ok", "Kit liberado", t.ownerName);
        showResult({ kind: "ok", title: "Kit liberado", name: t.ownerName, detail: t.comboItems.join(" + ") || "Entregar o kit do combo" });
    } catch (err) {
        console.error(err);
        showResult({ kind: "warn", title: "Erro na leitura", detail: "Tente ler de novo. Se continuar, use a aba Busca." });
    } finally {
        state.busy = false;
    }
}

function fetchTicketOnline(ticketId) {
    // Ingresso vendido depois do ultimo download: tenta buscar, sem travar a fila
    const timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 2500); });
    const load = getDoc(ticketRef(ticketId)).then(async function (snap) {
        if (!snap.exists()) return null;
        const t = overlayOne(normalizeTicket(snap.id, snap.data()));
        if (t.eventId !== state.eventId) return null;
        state.tickets.set(t.id, t);
        await idbPut("tickets", t);
        return t;
    }).catch(function () { return null; });
    return Promise.race([load, timeout]);
}

async function overrideCheckin(ticketId, token) {
    const t = {
        id: ticketId, eventId: state.eventId, ownerName: "(fora da lista)", ownerCpf: "", ownerMatricula: "",
        batchName: "", courtesy: false, status: "valid", qrSignature: token, kitSignature: "", isCombo: false,
        comboItems: [], comboRedeemed: false, comboRedeemedAtMs: 0, checkedInAtMs: 0, searchName: "", searchDigits: ""
    };
    state.tickets.set(ticketId, t);
    await markCheckin(t, token);
    addLog("ok", "Liberado fora da lista", "");
    showResult({ kind: "ok", title: "Entrada liberada", detail: "Liberação manual. Será conferida quando a lista atualizar." });
}

// ============================================================================
// TELA DE RESULTADO + SOM
// ============================================================================
function beep(kind) {
    if (navigator.vibrate) navigator.vibrate(kind === "ok" ? 80 : [120, 60, 120]);
    if (!state.soundOn) return;
    try {
        if (!state.audio) state.audio = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = state.audio;
        if (ctx.state === "suspended") ctx.resume();
        const tones = kind === "ok" ? [[1040, 0, 0.13]] : kind === "warn" ? [[520, 0, 0.18]] : [[200, 0, 0.18], [160, 0.22, 0.28]];
        tones.forEach(function (tone) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = kind === "ok" ? "sine" : "square";
            osc.frequency.value = tone[0];
            gain.gain.setValueAtTime(0.0001, ctx.currentTime + tone[1]);
            gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + tone[1] + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + tone[1] + tone[2]);
            osc.connect(gain).connect(ctx.destination);
            osc.start(ctx.currentTime + tone[1]);
            osc.stop(ctx.currentTime + tone[1] + tone[2] + 0.02);
        });
    } catch (e) { /* sem audio neste aparelho */ }
}

function showResult(opts) {
    clearTimeout(state.resultTimer);
    state.resultOpen = true;
    const el = byId("pt-result");
    el.className = "pt-result pt-result--" + opts.kind;
    byId("pt-result-icon").className = "fa-solid " + (opts.kind === "ok" ? "fa-circle-check" : opts.kind === "warn" ? "fa-triangle-exclamation" : "fa-circle-xmark");
    byId("pt-result-title").textContent = opts.title || "";
    byId("pt-result-name").textContent = opts.name || "";
    byId("pt-result-detail").textContent = opts.detail || "";
    const actions = byId("pt-result-actions");
    actions.innerHTML = "";
    (opts.actions || []).forEach(function (a) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pt-result__btn";
        b.textContent = a.label;
        b.addEventListener("click", function (e) {
            e.stopPropagation();
            b.disabled = true;
            Promise.resolve(a.run()).catch(function (err) { console.error(err); closeResult(); });
        });
        actions.appendChild(b);
    });
    byId("pt-result-hint").textContent = opts.kind === "ok" ? "" : "Toque para continuar";
    beep(opts.kind);
    if (opts.kind === "ok") state.resultTimer = setTimeout(closeResult, OK_AUTOCLOSE_MS);
}

function closeResult() {
    clearTimeout(state.resultTimer);
    byId("pt-result").classList.add("hidden");
    state.resultOpen = false;
    state.lastAt = Date.now();
    if (state.tab === "busca") renderSearch();
}

byId("pt-result").addEventListener("click", closeResult);

// ============================================================================
// CAMERA
// ============================================================================
function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    return new Promise(function (resolve, reject) {
        const s = document.createElement("script");
        s.src = JSQR_URL;
        s.integrity = JSQR_SRI;
        s.crossOrigin = "anonymous";
        s.onload = function () { resolve(); };
        s.onerror = function () { s.remove(); reject(new Error("Leitor de QR indisponível")); };
        document.head.appendChild(s);
    });
}

async function startCamera() {
    if (state.scanning) return;
    const msg = byId("pt-cam-msg");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        msg.textContent = "Este navegador não libera a câmera. Use o Chrome (Android) ou o Safari (iPhone), ou a aba Busca.";
        return;
    }
    try {
        // Destrava o som dentro do toque do usuario
        if (!state.audio) state.audio = new (window.AudioContext || window.webkitAudioContext)();
        if (state.audio.state === "suspended") state.audio.resume();
    } catch (e) { /* sem audio */ }

    try {
        state.detector = null;
        if ("BarcodeDetector" in window) {
            const formats = await window.BarcodeDetector.getSupportedFormats();
            if (formats.indexOf("qr_code") !== -1) state.detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        }
        if (!state.detector) await loadJsQR();

        state.stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        const video = byId("pt-video");
        video.srcObject = state.stream;
        await video.play();
        state.scanning = true;
        byId("pt-cam-off").classList.add("hidden");
        byId("pt-cam-stop").classList.remove("hidden");

        const track = state.stream.getVideoTracks()[0];
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        byId("pt-torch").classList.toggle("hidden", !caps.torch);
        byId("pt-torch").dataset.on = "0";

        if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (l) { state.wakeLock = l; }).catch(function () { /* opcional */ });
        scanLoop();
    } catch (err) {
        console.error(err);
        stopCamera();
        const name = err && err.name ? err.name : "";
        msg.textContent = name === "NotAllowedError"
            ? "Câmera bloqueada. Libere a câmera para este site nas configurações do navegador e tente de novo."
            : name === "NotFoundError" ? "Nenhuma câmera encontrada neste aparelho. Use a aba Busca."
                : "Não foi possível abrir a câmera" + (navigator.onLine ? "." : " (o leitor ainda não foi baixado: conecte uma vez).");
    }
}

function stopCamera() {
    state.scanning = false;
    if (state.stream) {
        state.stream.getTracks().forEach(function (t) { t.stop(); });
        state.stream = null;
    }
    const video = byId("pt-video");
    if (video) video.srcObject = null;
    if (state.wakeLock) { state.wakeLock.release().catch(function () { /* ignorar */ }); state.wakeLock = null; }
    byId("pt-cam-off").classList.remove("hidden");
    byId("pt-cam-stop").classList.add("hidden");
    byId("pt-torch").classList.add("hidden");
}

let scanCanvas = null;
function readFrame(video) {
    if (state.detector) {
        return state.detector.detect(video).then(function (codes) { return codes.length ? codes[0].rawValue : ""; });
    }
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !window.jsQR) return Promise.resolve("");
    // Recorta o quadrado central e reduz: mais rapido e suficiente para o QR
    const side = Math.min(vw, vh);
    const size = Math.min(side, 560);
    if (!scanCanvas) scanCanvas = document.createElement("canvas");
    scanCanvas.width = size;
    scanCanvas.height = size;
    const ctx = scanCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    const code = window.jsQR(img.data, size, size, { inversionAttempts: "dontInvert" });
    return Promise.resolve(code && code.data ? code.data : "");
}

async function scanLoop() {
    const video = byId("pt-video");
    while (state.scanning) {
        await new Promise(function (r) { setTimeout(r, 70); });
        if (!state.scanning) break;
        if (state.resultOpen || state.busy || state.tab !== "scan" || document.hidden || video.readyState < 2) continue;
        let raw = "";
        try { raw = await readFrame(video); } catch (e) { raw = ""; }
        if (!raw) continue;
        const now = Date.now();
        if (raw === state.lastRaw && now - state.lastAt < RESCAN_GAP_MS) continue;
        state.lastRaw = raw;
        state.lastAt = now;
        await handleToken(raw);
    }
}

byId("pt-cam-start").addEventListener("click", startCamera);
byId("pt-cam-stop").addEventListener("click", stopCamera);
byId("pt-torch").addEventListener("click", function () {
    const btn = byId("pt-torch");
    const track = state.stream ? state.stream.getVideoTracks()[0] : null;
    if (!track) return;
    const on = btn.dataset.on !== "1";
    track.applyConstraints({ advanced: [{ torch: on }] }).then(function () {
        btn.dataset.on = on ? "1" : "0";
        btn.classList.toggle("!border-neon", on);
        btn.classList.toggle("!text-neon", on);
    }).catch(function () { /* sem lanterna */ });
});

// Ao voltar para o app, a tela pode ter apagado: religa o bloqueio de descanso
document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.scanning && navigator.wakeLock && !state.wakeLock) {
        navigator.wakeLock.request("screen").then(function (l) { state.wakeLock = l; }).catch(function () { /* opcional */ });
    }
    if (document.hidden) state.wakeLock = null;
});

// ============================================================================
// FILA DE SINCRONIZACAO (syncQueue)
// ============================================================================
function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(function (resolve, reject) {
        setTimeout(function () { reject(Object.assign(new Error("timeout"), { code: "timeout" })); }, ms);
    })]);
}

async function pushOne(item) {
    return runTransaction(db, async function (tx) {
        const ref = ticketRef(item.ticketId);
        const snap = await tx.get(ref);
        if (!snap.exists()) return { conflict: "O ingresso não existe mais no sistema." };
        const d = snap.data();
        const who = String(d.ownerName || "");

        if (item.type === "checkin") {
            if (d.status === "used") {
                const at = toDate(d.checkedInAt);
                if (d.checkedInBy === item.byUid && at && Math.abs(at.getTime() - item.atMs) < 1500) return { ok: true };
                return { conflict: "Entrada duplicada: já constava entrada às " + timeLabel(at ? at.getTime() : 0) + " em outro aparelho.", name: who };
            }
            if (d.status !== "valid") return { conflict: "O ingresso estava " + (STATUS_LABEL[d.status] || d.status).toLowerCase() + " quando a entrada foi liberada.", name: who };
            if (String(d.qrSignature || "") !== item.token) return { conflict: "Entrada liberada com QR antigo: o ingresso tinha sido transferido para " + (who || "outra pessoa") + ".", name: who };
            tx.update(ref, { status: "used", checkedInAt: Timestamp.fromMillis(item.atMs), checkedInBy: item.byUid });
            return { ok: true };
        }

        if (d.comboRedeemed === true) {
            const at = toDate(d.comboRedeemedAt);
            if (d.comboRedeemedBy === item.byUid && at && Math.abs(at.getTime() - item.atMs) < 1500) return { ok: true };
            return { conflict: "Kit entregue em dobro: já constava retirada às " + timeLabel(at ? at.getTime() : 0) + ".", name: who };
        }
        if (d.status !== "valid" && d.status !== "used") return { conflict: "Kit entregue para ingresso " + (STATUS_LABEL[d.status] || d.status).toLowerCase() + ".", name: who };
        if (String(d.kitSignature || "") !== item.token) return { conflict: "Kit entregue com QR antigo (ingresso transferido).", name: who };
        tx.update(ref, { comboRedeemed: true, comboRedeemedAt: Timestamp.fromMillis(item.atMs), comboRedeemedBy: item.byUid });
        return { ok: true };
    });
}

async function flushQueue() {
    if (state.flushing || !navigator.onLine || !state.user || !state.queue.length) return;
    state.flushing = true;
    try {
        for (const item of state.queue.slice()) {
            let outcome;
            try {
                outcome = await withTimeout(pushOne(item), 12000);
            } catch (err) {
                const code = err && err.code ? String(err.code) : "";
                if (["permission-denied", "invalid-argument", "not-found", "failed-precondition"].indexOf(code) === -1) break; // rede: tenta depois
                outcome = { conflict: "O servidor recusou esta leitura (" + code + ")." };
            }
            await idbDel("queue", item.qid);
            state.queue = state.queue.filter(function (q) { return q.qid !== item.qid; });
            if (outcome && outcome.conflict) {
                const c = { type: item.type, ticketId: item.ticketId, eventId: item.eventId, atMs: item.atMs, name: outcome.name || "", message: outcome.conflict };
                c.cid = await idbAdd("conflicts", c);
                state.conflicts.push(c);
            }
            renderCounters();
        }
    } catch (e) {
        console.error(e);
    } finally {
        state.flushing = false;
        renderCounters();
        if (state.tab === "log") renderLog();
    }
}

setInterval(flushQueue, 15000);
window.addEventListener("online", function () {
    renderNet();
    flushQueue();
    refreshEvents();
    if (state.user && state.eventKey && !state.unsubTickets) startTicketListener();
});
window.addEventListener("offline", renderNet);

// ============================================================================
// TELAS
// ============================================================================
function countSold() {
    let n = 0;
    state.tickets.forEach(function (t) { if (t.status === "valid" || t.status === "used") n++; });
    return n;
}

function renderNet() {
    const el = byId("pt-net");
    const on = navigator.onLine;
    el.classList.toggle("is-on", on);
    el.querySelector("b").textContent = on ? "Online" : "Offline";
}

function renderCounters() {
    let used = 0;
    state.tickets.forEach(function (t) { if (t.status === "used") used++; });
    const total = countSold();
    byId("pt-count-in").textContent = String(used);
    byId("pt-count-total").textContent = String(total);
    const q = byId("pt-count-queue");
    q.textContent = String(state.queue.length);
    q.classList.toggle("text-amber-300", state.queue.length > 0);
    byId("pt-progress").style.width = (total ? Math.min(100, Math.round(used / total * 100)) : 0) + "%";

    const badge = byId("pt-conflict-badge");
    badge.textContent = String(state.conflicts.length);
    badge.classList.toggle("hidden", !state.conflicts.length);
}

function renderSyncInfo() {
    const ev = currentEvent();
    byId("pt-event-name").textContent = ev ? ev.title : "FurioZOs";
    const info = byId("pt-sync-info");
    const btnLabel = byId("pt-sync").querySelector("span");
    if (!ev) {
        info.textContent = navigator.onLine ? "Nenhum evento disponível para esta conta." : "Sem internet e nenhum evento baixado neste aparelho.";
        byId("pt-sync").disabled = true;
        return;
    }
    byId("pt-sync").disabled = false;
    if (state.eventKey && state.syncedAt) {
        info.innerHTML = '<span class="text-bone">' + countSold() + " ingressos</span> neste aparelho · atualizado " + esc(shortDateTime(new Date(state.syncedAt)));
        btnLabel.textContent = "Atualizar lista";
    } else {
        info.textContent = "Lista ainda não baixada neste aparelho. Baixe com internet antes de abrir os portões.";
        btnLabel.textContent = "Baixar lista";
    }
    byId("pt-cam-msg").textContent = state.eventKey
        ? "Aponte a câmera para o QR Code do ingresso."
        : "Baixe a lista do evento e ligue a câmera para ler os ingressos.";
}

function renderAll() {
    renderNet();
    renderSyncInfo();
    renderCounters();
    if (state.tab === "busca") renderSearch();
    if (state.tab === "log") renderLog();
}

function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll("[data-pt-tab]").forEach(function (b) { b.classList.toggle("is-active", b.dataset.ptTab === tab); });
    ["scan", "busca", "log"].forEach(function (t) { byId("pt-tab-" + t).classList.toggle("hidden", t !== tab); });
    if (tab === "busca") { renderSearch(); byId("pt-search").focus(); }
    if (tab === "log") renderLog();
}

document.querySelectorAll("[data-pt-tab]").forEach(function (b) {
    b.addEventListener("click", function () { setTab(b.dataset.ptTab); });
});

// ---- Busca manual ----------------------------------------------------------
function statusChip(t) {
    if (t.status === "used") return '<span class="label border border-red-400/60 text-red-300 px-2 py-0.5">Entrou ' + esc(timeLabel(t.checkedInAtMs)) + "</span>";
    if (t.status === "valid") return '<span class="label bg-neon text-ink px-2 py-0.5">Válido</span>';
    return '<span class="label border border-ash text-smoke px-2 py-0.5">' + esc(STATUS_LABEL[t.status] || t.status) + "</span>";
}

function renderSearch() {
    const box = byId("pt-search-results");
    const term = byId("pt-search").value;
    const q = norm(term);
    if (!state.eventKey) { box.innerHTML = '<p class="text-sm text-smoke">Baixe a lista do evento para buscar.</p>'; return; }
    if (q.length < 2) { box.innerHTML = '<p class="text-sm text-smoke">Digite pelo menos 2 letras ou números.</p>'; return; }
    const digits = q.replace(/\D/g, "");
    const onlyDigits = digits.length >= 2 && /^[\d.\-\s]+$/.test(q);

    const found = [];
    state.tickets.forEach(function (t) {
        if (t.status !== "valid" && t.status !== "used") return;
        const hit = onlyDigits ? t.searchDigits.indexOf(digits) !== -1 : t.searchName.indexOf(q) !== -1;
        if (hit) found.push(t);
    });
    found.sort(function (a, b) { return a.searchName.localeCompare(b.searchName); });

    if (!found.length) { box.innerHTML = '<p class="text-sm text-smoke">Nenhum ingresso encontrado para "' + esc(term) + '".</p>'; return; }
    box.innerHTML = found.slice(0, 40).map(function (t) {
        const sub = [t.courtesy ? "Cortesia" : t.batchName, t.ownerCpf, t.ownerMatricula ? "Mat. " + t.ownerMatricula : ""].filter(Boolean).join(" · ");
        const kit = t.isCombo
            ? (t.comboRedeemed
                ? '<span class="label border border-ash text-smoke px-2 py-0.5">Kit retirado</span>'
                : '<button type="button" data-kit="' + esc(t.id) + '" class="label border border-neon text-neon px-3 py-2">Entregar kit</button>')
            : "";
        const enter = t.status === "valid"
            ? '<button type="button" data-enter="' + esc(t.id) + '" class="label bg-neon text-ink border border-neon px-3 py-2 font-bold">Dar entrada</button>'
            : "";
        return '<div class="fz-panel p-3 space-y-2">' +
            '<div class="flex items-start justify-between gap-2"><div class="min-w-0"><p class="font-semibold truncate">' + esc(t.ownerName || "(sem nome)") + '</p>' +
            '<p class="text-xs text-smoke truncate">' + esc(sub) + "</p></div>" + statusChip(t) + "</div>" +
            (enter || kit ? '<div class="flex flex-wrap justify-end gap-2">' + kit + enter + "</div>" : "") +
            "</div>";
    }).join("") + (found.length > 40 ? '<p class="text-xs text-smoke">Mostrando 40 de ' + found.length + ". Refine a busca.</p>" : "");
}

byId("pt-search").addEventListener("input", renderSearch);

// Dois toques: o primeiro pede confirmacao, o segundo grava
byId("pt-search-results").addEventListener("click", async function (e) {
    const btn = e.target.closest("button[data-enter], button[data-kit]");
    if (!btn) return;
    if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.textContent = btn.dataset.enter ? "Confirmar entrada" : "Confirmar kit";
        setTimeout(function () { if (btn.isConnected) renderSearch(); }, 4000);
        return;
    }
    const isEnter = !!btn.dataset.enter;
    const t = state.tickets.get(isEnter ? btn.dataset.enter : btn.dataset.kit);
    if (!t) return;
    btn.disabled = true;
    try {
        if (isEnter) {
            if (t.status !== "valid") { renderSearch(); return; }
            await markCheckin(t, t.qrSignature);
            addLog("ok", "Entrada manual", t.ownerName);
            showResult({ kind: "ok", title: "Entrada liberada", name: t.ownerName, detail: "Liberada pela busca manual" });
        } else {
            if (t.comboRedeemed) { renderSearch(); return; }
            await markKit(t, t.kitSignature);
            addLog("ok", "Kit manual", t.ownerName);
            showResult({ kind: "ok", title: "Kit liberado", name: t.ownerName, detail: t.comboItems.join(" + ") });
        }
    } catch (err) {
        console.error(err);
        toast("Não foi possível gravar. Tente de novo.", "error");
        renderSearch();
    }
});

// ---- Registro --------------------------------------------------------------
function renderLog() {
    const cBox = byId("pt-conflicts");
    if (state.conflicts.length) {
        cBox.innerHTML = '<span class="fz-label !text-red-300">Conferir com a diretoria (' + state.conflicts.length + ")</span>" +
            '<div class="space-y-2">' + state.conflicts.slice().reverse().map(function (c) {
                return '<div class="border border-red-400/50 bg-red-400/10 p-3 text-sm space-y-1">' +
                    '<p class="font-semibold">' + esc(c.name || "Ingresso " + String(c.ticketId).slice(0, 8)) + "</p>" +
                    '<p class="text-red-200">' + esc(c.message) + "</p>" +
                    '<div class="flex items-center justify-between gap-2"><span class="text-xs text-smoke">Lido aqui às ' + esc(timeLabel(c.atMs)) + "</span>" +
                    '<button type="button" data-conflict="' + esc(String(c.cid)) + '" class="label border border-ash text-bone px-2 py-1">Marcar como visto</button></div></div>';
            }).join("") + "</div>";
    } else {
        cBox.innerHTML = "";
    }

    const box = byId("pt-log");
    if (!state.log.length) { box.innerHTML = '<p class="text-sm text-smoke">Nenhuma leitura ainda.</p>'; return; }
    const color = { ok: "text-neon", bad: "text-red-300", warn: "text-amber-300" };
    box.innerHTML = state.log.map(function (l) {
        return '<div class="flex items-center justify-between gap-3 border-b border-ash/60 py-2 text-sm">' +
            '<span class="min-w-0 truncate"><b class="' + (color[l.kind] || "") + '">' + esc(l.title) + "</b>" + (l.name ? " · " + esc(l.name) : "") + "</span>" +
            '<span class="font-mono text-xs text-smoke shrink-0">' + esc(timeLabel(l.atMs)) + "</span></div>";
    }).join("");
}

byId("pt-conflicts").addEventListener("click", async function (e) {
    const btn = e.target.closest("button[data-conflict]");
    if (!btn) return;
    const cid = Number(btn.dataset.conflict);
    await idbDel("conflicts", cid);
    state.conflicts = state.conflicts.filter(function (c) { return c.cid !== cid; });
    renderCounters();
    renderLog();
});

// ---- Opcoes ----------------------------------------------------------------
byId("pt-menu-btn").addEventListener("click", function () { byId("pt-menu").classList.remove("hidden"); });
byId("pt-menu-close").addEventListener("click", function () { byId("pt-menu").classList.add("hidden"); });
byId("pt-menu").addEventListener("click", function (e) { if (e.target === byId("pt-menu")) byId("pt-menu").classList.add("hidden"); });

byId("pt-sound").addEventListener("change", function (e) {
    state.soundOn = e.target.checked;
    lsSet("fz-portaria-sound", state.soundOn ? "1" : "0");
    if (state.soundOn) beep("ok");
});

byId("pt-force-sync").addEventListener("click", async function () {
    if (!navigator.onLine) { toast("Sem internet agora. As leituras estão guardadas no aparelho.", "error"); return; }
    await flushQueue();
    toast(state.queue.length ? "Ainda há " + state.queue.length + " leitura(s) para enviar." : "Tudo enviado.");
});

function pendingBlock(action) {
    if (!state.queue.length) return false;
    toast("Há " + state.queue.length + " leitura(s) ainda não enviada(s). Conecte à internet antes de " + action + ".", "error");
    return true;
}

let wipeArmed = false;
byId("pt-wipe").addEventListener("click", async function () {
    if (pendingBlock("apagar")) return;
    const btn = byId("pt-wipe");
    if (!wipeArmed) {
        wipeArmed = true;
        btn.textContent = "Toque de novo para apagar tudo";
        setTimeout(function () { wipeArmed = false; btn.textContent = "Apagar dados deste aparelho"; }, 4000);
        return;
    }
    stopCamera();
    stopTicketListener();
    try { (await idb()).close(); } catch (e) { /* ignorar */ }
    idbPromise = null;
    await new Promise(function (resolve) {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
    });
    ["fz-portaria-log", "fz-portaria-event"].forEach(lsDel);
    location.reload();
});

byId("pt-logout").addEventListener("click", function () {
    if (pendingBlock("sair")) return;
    stopCamera();
    byId("pt-menu").classList.add("hidden");
    signOut(auth);
});

// ============================================================================
// APP OFFLINE (service worker guarda a casca da pagina)
// ============================================================================
function cacheShell() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then(function (reg) {
        if (!reg.active) return;
        const urls = performance.getEntriesByType("resource").map(function (e) { return e.name; });
        urls.push(JSQR_URL);
        urls.push(location.origin + location.pathname);
        reg.active.postMessage({ type: "precache", urls: Array.from(new Set(urls)) });
    }).catch(function () { /* sem suporte */ });
}

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (e) {
        if (e.data && e.data.type === "precache-done") byId("pt-offline-ready").classList.remove("hidden");
    });
    window.addEventListener("load", function () {
        navigator.serviceWorker.register("/portaria-sw.js", { scope: "/portaria" })
            .then(function () { setTimeout(cacheShell, 2500); })
            .catch(function (err) { console.error("Service worker da portaria:", err); });
    });
}

renderNet();

// ============================================================================
// Gancho de teste: so existe em localhost (o Worker nao aceita essa origem,
// entao a lista e a chave sao simuladas para validar a interface e o leitor)
// ============================================================================
if (IS_LOCAL) {
    window.__fzPortariaDebug = {
        state: state,
        handleToken: handleToken,
        async load(eventId, rawKeyBytes, tickets) {
            state.user = state.user || { uid: "debugstaff0000000000000001", email: "portaria@teste.local" };
            state.role = "admin";
            state.events = [{ id: eventId, title: "Festa de Teste", status: "published", startsAtMs: Date.now() + 3600000 }];
            state.eventId = eventId;
            state.eventKey = await importEventKey(rawKeyBytes);
            state.syncedAt = Date.now();
            state.queue = [];
            state.tickets = new Map(tickets.map(function (t) { const n = normalizeTicket(t.id, t); return [n.id, n]; }));
            show("pt-app");
            renderEventSelect();
            renderAll();
        }
    };
}
