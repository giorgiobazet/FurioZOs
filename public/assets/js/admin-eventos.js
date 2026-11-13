// public/assets/js/admin-eventos.js
// Painel da Diretoria: eventos, lotes, break-even, portaria ao vivo,
// cortesias, equipe da portaria e socios (PRD_EVENTOS.md, item 4.4).
// As regras do Firestore garantem que so administradores leem e gravam aqui.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
    getFirestore, collection, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
    onSnapshot, query, where, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { APP_ID, SITE_URL, firebaseConfig, esc, money, toDate, pad2, shortDateTime, callWorker } from "./fz-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
auth.languageCode = "pt-BR";

const STATUS_LABEL = { draft: "Rascunho", published: "Publicado", paused: "Pausado", finished: "Encerrado" };
const STATUS_CLASS = { draft: "border-ash text-smoke", published: "bg-neon text-ink border-neon", paused: "border-amber-400/60 text-amber-300", finished: "border-ash text-smoke line-through" };
const ORDER_LABEL = { paid: "Pago", reserved: "Aguardando PIX", expired: "Expirado", cancelled: "Cancelado", refunded: "Estornado", review: "Em análise" };
const DEFAULT_FEE_PERCENT = 0.99; // taxa do PIX no Mercado Pago (ajustavel no painel)

const state = {
    user: null,
    events: [],
    products: [],
    selectedId: null,
    creating: false,
    tab: "painel",
    batches: [],
    orders: [],
    tickets: [],
    finance: { costs: [], feePercent: DEFAULT_FEE_PERCENT },
    costsDraft: null,
    editingBatchId: null,
    courtesyLinks: [],
    staff: [],
    members: [],
    unsubs: [],
    globalUnsubs: []
};

const byId = function (id) { return document.getElementById(id); };
const dataCol = function (name) { return collection(db, "artifacts", APP_ID, "public", "data", name); };
const eventRef = function (id) { return doc(db, "artifacts", APP_ID, "public", "data", "events", id); };
const batchesCol = function (id) { return collection(eventRef(id), "batches"); };
const financeRef = function (id) { return doc(eventRef(id), "private", "finance"); };

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
    ["adm-loading", "adm-login", "adm-denied", "adm-app"].forEach(function (x) {
        byId(x).classList.toggle("hidden", x !== id);
    });
}

function inputDateValue(d) {
    if (!d) return "";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function slugify(text) {
    return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

function num(v) {
    const n = Number(String(v === undefined || v === null ? "" : v).replace(",", "."));
    return isFinite(n) ? n : NaN;
}

function selectedEvent() {
    return state.events.find(function (e) { return e.id === state.selectedId; }) || null;
}

function firestoreError(err) {
    console.error(err);
    const code = err && err.code ? String(err.code) : "";
    if (code.indexOf("permission-denied") !== -1) return "Sem permissão ou dados inválidos. Confira os campos.";
    return "Não foi possível salvar agora. Tente de novo.";
}

// ============================================================================
// ACESSO
// ============================================================================
onAuthStateChanged(auth, async function (user) {
    stopListeners(state.unsubs);
    stopListeners(state.globalUnsubs);
    state.user = user && !user.isAnonymous ? user : null;
    byId("adm-user").textContent = state.user ? (state.user.email || "") : "";

    if (!state.user) { show("adm-login"); return; }
    show("adm-loading");
    try {
        const snap = await getDoc(doc(db, "artifacts", APP_ID, "admins", state.user.uid));
        if (!snap.exists()) { show("adm-denied"); return; }
    } catch (e) {
        show("adm-denied");
        return;
    }
    show("adm-app");
    startGlobalListeners();
});

byId("adm-login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const errEl = byId("adm-login-error");
    errEl.classList.add("hidden");
    try {
        await signInWithEmailAndPassword(auth, byId("adm-email").value.trim(), byId("adm-pass").value);
    } catch (err) {
        errEl.textContent = "E-mail ou senha incorretos.";
        errEl.classList.remove("hidden");
    }
});

byId("adm-logout-denied").addEventListener("click", function () { signOut(auth); });

function stopListeners(list) {
    while (list.length) {
        const u = list.pop();
        try { u(); } catch (e) { /* ja encerrado */ }
    }
}

function startGlobalListeners() {
    const onErr = function (label) {
        return function (err) { console.warn(label, err && err.code ? err.code : err); };
    };
    state.globalUnsubs.push(onSnapshot(dataCol("events"), function (snap) {
        state.events = [];
        snap.forEach(function (d) { state.events.push(Object.assign({ id: d.id }, d.data())); });
        state.events.sort(function (a, b) {
            const da = toDate(a.startsAt), dbb = toDate(b.startsAt);
            return (dbb ? dbb.getTime() : 0) - (da ? da.getTime() : 0);
        });
        if (!state.selectedId && !state.creating && state.events.length) selectEvent(state.events[0].id);
        renderEventList();
        renderDetail();
    }, onErr("Eventos:")));

    state.globalUnsubs.push(onSnapshot(dataCol("products"), function (snap) {
        state.products = [];
        snap.forEach(function (d) { state.products.push({ id: String(d.data().id || d.id), name: String(d.data().name || d.id) }); });
        if (state.tab === "lotes") renderDetail();
    }, onErr("Produtos:")));

    state.globalUnsubs.push(onSnapshot(collection(db, "artifacts", APP_ID, "staff"), function (snap) {
        state.staff = [];
        snap.forEach(function (d) { state.staff.push(Object.assign({ uid: d.id }, d.data())); });
        renderTeam();
    }, onErr("Equipe:")));

    state.globalUnsubs.push(onSnapshot(collection(db, "artifacts", APP_ID, "members"), function (snap) {
        state.members = [];
        snap.forEach(function (d) { state.members.push(Object.assign({ uid: d.id }, d.data())); });
        renderTeam();
    }, onErr("Sócios:")));
}

function selectEvent(eventId) {
    stopListeners(state.unsubs);
    state.selectedId = eventId;
    state.creating = false;
    state.batches = [];
    state.orders = [];
    state.tickets = [];
    state.finance = { costs: [], feePercent: DEFAULT_FEE_PERCENT };
    state.costsDraft = null;
    state.editingBatchId = null;
    state.courtesyLinks = [];
    if (!eventId) return;

    const onErr = function (err) { console.warn("Evento:", err && err.code ? err.code : err); };
    state.unsubs.push(onSnapshot(batchesCol(eventId), function (snap) {
        state.batches = [];
        snap.forEach(function (d) { state.batches.push(Object.assign({ id: d.id }, d.data())); });
        state.batches.sort(function (a, b) { return Number(a.order || 0) - Number(b.order || 0); });
        renderDetail();
    }, onErr));
    state.unsubs.push(onSnapshot(query(dataCol("ticketOrders"), where("eventId", "==", eventId)), function (snap) {
        state.orders = [];
        snap.forEach(function (d) { state.orders.push(Object.assign({ id: d.id }, d.data())); });
        state.orders.sort(function (a, b) { return String(b.createdAtISO || "").localeCompare(String(a.createdAtISO || "")); });
        renderDetail();
    }, onErr));
    state.unsubs.push(onSnapshot(query(dataCol("tickets"), where("eventId", "==", eventId)), function (snap) {
        state.tickets = [];
        snap.forEach(function (d) { state.tickets.push(Object.assign({ id: d.id }, d.data())); });
        renderDetail();
    }, onErr));
    state.unsubs.push(onSnapshot(financeRef(eventId), function (snap) {
        const d = snap.exists() ? snap.data() : {};
        state.finance = {
            costs: Array.isArray(d.costs) ? d.costs : [],
            feePercent: typeof d.feePercent === "number" ? d.feePercent : DEFAULT_FEE_PERCENT
        };
        renderDetail();
    }, onErr));
}

// ============================================================================
// LISTA DE EVENTOS
// ============================================================================
function renderEventList() {
    const el = byId("adm-event-list");
    if (!state.events.length) {
        el.innerHTML = '<p class="text-sm text-smoke border border-dashed border-ash p-4">Nenhum evento ainda. Crie o primeiro.</p>';
        return;
    }
    el.innerHTML = state.events.map(function (e) {
        const active = e.id === state.selectedId && !state.creating;
        return '<button type="button" data-select-event="' + esc(e.id) + '" class="w-full text-left p-3 border ' + (active ? "border-neon bg-neon/[0.06]" : "border-ash hover:border-neon/50") + ' transition-colors">' +
            '<span class="label inline-block border px-1.5 py-0.5 ' + (STATUS_CLASS[e.status] || STATUS_CLASS.draft) + '">' + esc(STATUS_LABEL[e.status] || e.status) + '</span>' +
            '<span class="block font-sport font-black uppercase text-2xl leading-none mt-2 break-words">' + esc(e.title) + '</span>' +
            '<span class="block text-xs text-smoke mt-1">' + esc(shortDateTime(toDate(e.startsAt))) + '</span></button>';
    }).join("");
}

// ============================================================================
// METRICAS
// ============================================================================
function metrics() {
    const paidOrders = state.orders.filter(function (o) { return o.status === "paid"; });
    const gross = paidOrders.reduce(function (s, o) { return s + Number(o.total || 0); }, 0);
    const fee = gross * (Number(state.finance.feePercent || 0) / 100);
    const net = gross - fee;
    const costs = state.finance.costs.reduce(function (s, c) { return s + Number(c.amount || 0); }, 0);
    const live = state.tickets.filter(function (t) { return t.status === "valid" || t.status === "used"; });
    const checkedIn = live.filter(function (t) { return t.status === "used"; }).length;
    const combos = live.filter(function (t) { return t.isCombo; });
    return {
        gross: gross, fee: fee, net: net, costs: costs, balance: net - costs,
        breakEvenPct: costs > 0 ? Math.min(100, Math.round((net / costs) * 100)) : (net > 0 ? 100 : 0),
        totalSold: live.length,
        paidTickets: live.filter(function (t) { return !t.courtesy; }).length,
        courtesies: live.filter(function (t) { return t.courtesy; }).length,
        checkedIn: checkedIn,
        checkInPct: live.length ? Math.round((checkedIn / live.length) * 100) : 0,
        combos: combos.length,
        combosRedeemed: combos.filter(function (t) { return t.comboRedeemed; }).length,
        reviewOrders: state.orders.filter(function (o) { return o.status === "review" || o.adminNote; }).length
    };
}

function kpi(label, value, sub, tone) {
    return '<div class="border border-ash p-4 bg-coal"><span class="fz-label">' + label + '</span>' +
        '<span class="font-mono font-semibold text-2xl tracking-tight ' + (tone || "text-bone") + '">' + value + '</span>' +
        (sub ? '<span class="block text-xs text-smoke mt-1">' + sub + '</span>' : "") + '</div>';
}

function bar(pct, tone) {
    return '<div class="ev-bar !h-3"><span style="width:' + Math.max(0, Math.min(100, pct)) + '%' + (tone ? ";background:" + tone : "") + '"></span></div>';
}

// ============================================================================
// DETALHE DO EVENTO
// ============================================================================
function renderDetail() {
    const el = byId("adm-event-detail");
    // Nao redesenha enquanto a pessoa digita num formulario desta area
    const focused = document.activeElement;
    if (focused && el.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) return;

    if (state.creating) { el.innerHTML = eventFormHtml(null); return; }
    const ev = selectedEvent();
    if (!ev) {
        el.innerHTML = '<div class="border border-dashed border-ash p-10 text-center text-smoke">Selecione um evento ao lado ou crie um novo.</div>';
        return;
    }

    const tabs = [["painel", "fa-gauge-high", "Painel"], ["dados", "fa-pen", "Dados"], ["lotes", "fa-layer-group", "Lotes"], ["cortesias", "fa-gift", "Cortesias"], ["vendas", "fa-receipt", "Vendas"]];
    const head =
        '<div class="flex flex-wrap items-start justify-between gap-4 mb-5">' +
            '<div class="min-w-0"><span class="label inline-block border px-1.5 py-0.5 ' + (STATUS_CLASS[ev.status] || "") + '">' + esc(STATUS_LABEL[ev.status] || ev.status) + '</span>' +
                '<h1 class="font-sport font-black uppercase text-5xl leading-[0.9] mt-2 break-words">' + esc(ev.title) + '</h1>' +
                '<p class="text-sm text-smoke mt-2">' + esc(shortDateTime(toDate(ev.startsAt))) + (ev.location ? " • " + esc(ev.location) : "") + '</p></div>' +
            '<div class="flex flex-wrap gap-2">' +
                (ev.status !== "published" ? '<button type="button" data-set-status="published" class="label bg-neon text-ink px-3 py-2 font-bold hover:bg-bone transition-colors"><i class="fa-solid fa-bullhorn mr-1"></i> Publicar</button>' : "") +
                (ev.status === "published" ? '<button type="button" data-set-status="paused" class="label border border-amber-400/60 text-amber-300 px-3 py-2 hover:bg-amber-400 hover:text-ink transition-colors"><i class="fa-solid fa-pause mr-1"></i> Pausar vendas</button>' : "") +
                (ev.status !== "finished" ? '<button type="button" data-set-status="finished" class="label border border-ash text-smoke px-3 py-2 hover:border-bone hover:text-bone transition-colors">Encerrar</button>' : "") +
                (ev.status === "published" || ev.status === "paused" ? '<a href="' + SITE_URL + '/?evento=' + encodeURIComponent(ev.id) + '" target="_blank" rel="noopener noreferrer" class="label border border-ash text-bone px-3 py-2 hover:border-neon hover:text-neon transition-colors">Ver no site ↗</a>' : "") +
            '</div>' +
        '</div>' +
        '<div class="flex overflow-x-auto mb-6">' + tabs.map(function (t) {
            return '<button type="button" data-tab="' + t[0] + '" class="seg-tab whitespace-nowrap px-4' + (state.tab === t[0] ? " is-active" : "") + '"><i class="fa-solid ' + t[1] + ' mr-1"></i> ' + t[2] + '</button>';
        }).join("") + '</div>';

    let bodyHtml = "";
    if (state.tab === "dados") bodyHtml = eventFormHtml(ev);
    else if (state.tab === "lotes") bodyHtml = batchesHtml(ev);
    else if (state.tab === "cortesias") bodyHtml = courtesyHtml(ev);
    else if (state.tab === "vendas") bodyHtml = salesHtml(ev);
    else bodyHtml = dashboardHtml(ev);

    el.innerHTML = head + bodyHtml;
}

// ---------------------------------------------------------------- Painel
function dashboardHtml(ev) {
    const m = metrics();
    const costs = state.costsDraft || state.finance.costs;
    const reached = m.costs > 0 && m.net >= m.costs;

    const batchRows = state.batches.map(function (b) {
        const total = Number(b.totalQuantity || 0);
        const sold = Number(b.soldQuantity || 0);
        const reserved = Number(b.reservedQuantity || 0);
        const active = ev.activeBatchId === b.id;
        return '<div class="border ' + (active ? "border-neon" : "border-ash") + ' p-3 space-y-2">' +
            '<div class="flex items-center justify-between gap-3">' +
                '<span class="min-w-0"><span class="label ' + (active ? "text-neon" : "text-smoke") + '">' + (active ? "Lote ativo" : "Lote " + esc(b.order)) + '</span>' +
                '<span class="block font-semibold truncate">' + esc(b.name) + ' • ' + money(b.price) + '</span></span>' +
                (active ? '<span class="label text-neon shrink-0"><i class="fa-solid fa-circle-check"></i></span>'
                    : '<button type="button" data-activate-batch="' + esc(b.id) + '" class="label border border-neon/60 text-neon px-3 py-2 hover:bg-neon hover:text-ink transition-colors shrink-0">Virar para este</button>') +
            '</div>' + bar(total ? ((sold + reserved) / total) * 100 : 0) +
            '<p class="text-xs text-smoke">' + sold + ' vendidos • ' + reserved + ' aguardando PIX • ' + Math.max(0, total - sold - reserved) + ' livres de ' + total + '</p></div>';
    }).join("") || '<p class="text-sm text-smoke border border-dashed border-ash p-4">Nenhum lote. Crie na aba Lotes para abrir as vendas.</p>';

    return '<div class="space-y-6">' +
        (m.reviewOrders ? '<p class="text-sm border border-amber-400/40 bg-amber-400/10 text-amber-200 px-4 py-3"><i class="fa-solid fa-triangle-exclamation mr-1"></i> ' + m.reviewOrders + ' pedido(s) com aviso para conferir na aba Vendas.</p>' : "") +
        '<div class="grid grid-cols-2 xl:grid-cols-4 gap-3">' +
            kpi("Ingressos emitidos", String(m.totalSold), m.paidTickets + " pagos • " + m.courtesies + " cortesias") +
            kpi("Receita bruta", money(m.gross), "PIX confirmados") +
            kpi("Receita líquida", money(m.net), "após " + String(state.finance.feePercent).replace(".", ",") + "% de taxa (" + money(m.fee) + ")", "text-neon") +
            kpi("Resultado", money(m.balance), "líquido − custos", m.balance >= 0 ? "text-neon" : "text-red-300") +
        '</div>' +

        '<div class="border border-ash p-5 bg-coal space-y-3">' +
            '<div class="flex items-end justify-between gap-3"><div><span class="fz-label !mb-0">Break-even em tempo real</span>' +
                '<span class="font-sport font-black uppercase text-3xl leading-none">' + (m.costs <= 0 ? "Cadastre os custos" : (reached ? 'Festa <span class="text-neon">paga</span>' : "Faltam " + money(m.costs - m.net))) + '</span></div>' +
                '<span class="font-mono font-semibold text-3xl ' + (reached ? "text-neon" : "text-bone") + '">' + m.breakEvenPct + '%</span></div>' +
            bar(m.breakEvenPct, reached ? "" : "#fbbf24") +
            '<p class="text-xs text-smoke">Receita líquida ' + money(m.net) + ' de ' + money(m.costs) + ' em custos.</p>' +
        '</div>' +

        '<div class="border border-ash p-5 bg-coal space-y-3">' +
            '<div class="flex items-end justify-between gap-3"><div><span class="fz-label !mb-0">Portaria ao vivo</span>' +
                '<span class="font-sport font-black uppercase text-3xl leading-none">' + m.checkedIn + ' <span class="text-smoke">de</span> ' + m.totalSold + ' <span class="text-neon">dentro</span></span></div>' +
                '<span class="font-mono font-semibold text-3xl text-bone">' + m.checkInPct + '%</span></div>' +
            bar(m.checkInPct) +
            '<p class="text-xs text-smoke">' + (m.combos ? "Kits retirados: " + m.combosRedeemed + " de " + m.combos + ". " : "") + 'Atualiza sozinho conforme a portaria lê os ingressos.</p>' +
        '</div>' +

        '<div class="grid xl:grid-cols-2 gap-6 items-start">' +
            '<div class="space-y-3"><span class="fz-label">Lotes • virada manual com 1 clique</span>' + batchRows + '</div>' +
            '<form id="costs-form" class="space-y-3"><span class="fz-label">Custos da festa</span>' +
                '<div id="costs-rows" class="space-y-2">' + (costs.length ? costs : [{ label: "", amount: "" }]).map(costRowHtml).join("") + '</div>' +
                '<button type="button" id="cost-add" class="label text-neon hover:underline"><i class="fa-solid fa-plus mr-1"></i> Adicionar custo</button>' +
                '<div class="flex items-center gap-3 pt-2 border-t border-dashed border-ash"><label for="fee-percent" class="fz-label !mb-0 shrink-0">Taxa do PIX (%)</label>' +
                    '<input type="text" id="fee-percent" inputmode="decimal" class="fz-input !w-24 font-mono" value="' + esc(String(state.finance.feePercent).replace(".", ",")) + '"></div>' +
                '<button type="submit" class="btn-razor btn-razor--ghost w-full !text-base"><span>Salvar custos</span><span class="arrow">→</span></button>' +
            '</form>' +
        '</div>' +
    '</div>';
}

function costRowHtml(c) {
    return '<div class="flex gap-2 cost-row"><input type="text" maxlength="60" placeholder="Ex.: DJ, som, bebida" class="fz-input cost-label" value="' + esc(c.label || "") + '">' +
        '<input type="text" inputmode="decimal" placeholder="R$" class="fz-input !w-32 font-mono cost-amount" value="' + esc(c.amount === "" || c.amount === undefined ? "" : String(c.amount).replace(".", ",")) + '">' +
        '<button type="button" data-cost-remove aria-label="Remover" class="fz-close shrink-0 !w-11 !h-auto"><i class="fa-solid fa-trash text-sm"></i></button></div>';
}

function readCostRows() {
    const rows = [];
    document.querySelectorAll("#costs-rows .cost-row").forEach(function (row) {
        const label = row.querySelector(".cost-label").value.trim();
        const amount = num(row.querySelector(".cost-amount").value);
        if (label || !isNaN(amount)) rows.push({ label: label, amount: isNaN(amount) ? "" : amount });
    });
    return rows;
}

// ---------------------------------------------------------------- Dados
function eventFormHtml(ev) {
    const isNew = !ev;
    const e = ev || { status: "draft" };
    const hasTickets = !isNew && state.tickets.length > 0;
    return '<form id="event-form" class="space-y-4 max-w-3xl">' +
        (isNew ? '<h1 class="font-sport font-black uppercase text-5xl leading-none">Novo <span class="text-neon">evento</span></h1>' : "") +
        '<div><label for="ef-title" class="fz-label">Nome do evento</label><input type="text" id="ef-title" required maxlength="120" class="fz-input" value="' + esc(e.title || "") + '"></div>' +
        (isNew ? '<div><label for="ef-slug" class="fz-label">Endereço do evento (não muda depois)</label><div class="flex items-center gap-2"><span class="label text-smoke normal-case tracking-normal shrink-0">/?evento=</span><input type="text" id="ef-slug" required maxlength="50" pattern="[a-z0-9][a-z0-9-]{1,49}" class="fz-input font-mono" placeholder="festa-do-sapo"></div></div>' : "") +
        '<div class="grid sm:grid-cols-2 gap-3">' +
            '<div><label for="ef-start" class="fz-label">Início</label><input type="datetime-local" id="ef-start" required class="fz-input" value="' + esc(inputDateValue(toDate(e.startsAt))) + '"></div>' +
            '<div><label for="ef-end" class="fz-label">Fim</label><input type="datetime-local" id="ef-end" required class="fz-input" value="' + esc(inputDateValue(toDate(e.endsAt))) + '"></div>' +
        '</div>' +
        '<div class="grid sm:grid-cols-2 gap-3">' +
            '<div><label for="ef-location" class="fz-label">Local</label><input type="text" id="ef-location" maxlength="300" class="fz-input" value="' + esc(e.location || "") + '"></div>' +
            '<div><label for="ef-map" class="fz-label">Link do mapa (https://)</label><input type="url" id="ef-map" maxlength="500" class="fz-input" value="' + esc(e.mapUrl || "") + '"></div>' +
        '</div>' +
        '<div><label for="ef-banner" class="fz-label">Imagem de capa (link https:// ou assets/img/arquivo.jpg)</label><input type="text" id="ef-banner" maxlength="500" class="fz-input" value="' + esc(e.bannerUrl || "") + '"><p class="text-xs text-smoke mt-1">Em branco, o site mostra o trevo na prancheta.</p></div>' +
        '<div><label for="ef-desc" class="fz-label">Descrição (atrações, open bar, regras)</label><textarea id="ef-desc" rows="6" maxlength="5000" class="fz-input">' + esc(e.description || "") + '</textarea></div>' +
        '<div><label for="ef-status" class="fz-label">Situação</label><select id="ef-status" class="fz-input">' +
            Object.keys(STATUS_LABEL).map(function (k) { return '<option value="' + k + '"' + (e.status === k ? " selected" : "") + '>' + STATUS_LABEL[k] + '</option>'; }).join("") + '</select>' +
            '<p class="text-xs text-smoke mt-1">Rascunho não aparece no site. Publicado abre as vendas do lote ativo.</p></div>' +
        '<p id="event-form-error" class="hidden text-sm text-red-300 border border-red-400/40 bg-red-400/10 px-3 py-2"></p>' +
        '<div class="flex flex-wrap gap-3">' +
            '<button type="submit" class="btn-razor btn-razor--solid !text-base"><span>' + (isNew ? "Criar evento" : "Salvar alterações") + '</span><span class="arrow">→</span></button>' +
            (isNew ? '<button type="button" id="event-cancel" class="label border border-ash text-smoke px-4 hover:text-bone transition-colors">Cancelar</button>' : "") +
            (!isNew && !hasTickets ? '<button type="button" id="event-delete" class="label border border-red-400/40 text-red-300 px-4 hover:bg-red-500 hover:text-white transition-colors"><i class="fa-solid fa-trash mr-1"></i> Excluir evento</button>' : "") +
        '</div>' +
        (hasTickets ? '<p class="text-xs text-smoke">Evento com ingressos emitidos não pode ser excluído; use Encerrar.</p>' : "") +
    '</form>';
}

async function saveEvent() {
    const errEl = byId("event-form-error");
    const fail = function (m) { errEl.textContent = m; errEl.classList.remove("hidden"); };
    errEl.classList.add("hidden");

    const title = byId("ef-title").value.trim();
    const start = new Date(byId("ef-start").value);
    const end = new Date(byId("ef-end").value);
    const mapUrl = byId("ef-map").value.trim();
    const bannerUrl = byId("ef-banner").value.trim();
    if (!title) return fail("Informe o nome do evento.");
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return fail("Informe início e fim.");
    if (end <= start) return fail("O fim precisa ser depois do início.");
    if (mapUrl && !/^https:\/\//i.test(mapUrl)) return fail("O link do mapa precisa começar com https://");
    if (bannerUrl && !/^https:\/\//i.test(bannerUrl) && !/^assets\//.test(bannerUrl)) return fail("A imagem precisa ser um link https:// ou um caminho assets/…");

    const data = {
        title: title,
        description: byId("ef-desc").value.trim(),
        location: byId("ef-location").value.trim(),
        mapUrl: mapUrl,
        bannerUrl: bannerUrl,
        status: byId("ef-status").value,
        startsAt: Timestamp.fromDate(start),
        endsAt: Timestamp.fromDate(end),
        updatedAt: serverTimestamp()
    };

    try {
        if (state.creating) {
            const slug = slugify(byId("ef-slug").value);
            if (!/^[a-z0-9][a-z0-9-]{1,49}$/.test(slug)) return fail("Endereço inválido: use letras minúsculas, números e hífen.");
            const exists = await getDoc(eventRef(slug));
            if (exists.exists()) return fail("Já existe um evento com esse endereço. Escolha outro.");
            data.activeBatchId = "";
            data.createdAt = serverTimestamp();
            await setDoc(eventRef(slug), data);
            state.tab = "lotes";
            selectEvent(slug);
            toast("Evento criado. Agora cadastre os lotes.");
        } else {
            await updateDoc(eventRef(state.selectedId), data);
            toast("Evento salvo.");
        }
        document.activeElement && document.activeElement.blur();
        renderEventList();
        renderDetail();
    } catch (err) {
        fail(firestoreError(err));
    }
}

// ---------------------------------------------------------------- Lotes
function batchesHtml(ev) {
    const editing = state.batches.find(function (b) { return b.id === state.editingBatchId; }) || null;
    const b = editing || { order: state.batches.length + 1, autoTurn: true };
    const combo = Array.isArray(b.comboItems) ? b.comboItems.map(String) : [];

    const list = state.batches.map(function (x) {
        const active = ev.activeBatchId === x.id;
        const sold = Number(x.soldQuantity || 0), reserved = Number(x.reservedQuantity || 0), total = Number(x.totalQuantity || 0);
        return '<div class="border ' + (active ? "border-neon" : "border-ash") + ' p-4 space-y-2">' +
            '<div class="flex flex-wrap items-start justify-between gap-3"><div class="min-w-0">' +
                '<span class="label ' + (active ? "text-neon" : "text-smoke") + '">' + esc(x.order) + 'º na ordem' + (active ? " • ativo" : "") + (x.autoTurn ? " • vira sozinho" : "") + '</span>' +
                '<span class="block font-sport font-black uppercase text-2xl leading-none mt-1 break-words">' + esc(x.name) + '</span>' +
                '<span class="block text-sm text-smoke mt-1">' + money(x.price) +
                    (Number(x.memberPrice) > 0 ? " • sócio " + money(x.memberPrice) : "") +
                    (Array.isArray(x.comboItems) && x.comboItems.length ? " • combo " + money(x.comboPrice || x.price) : "") + '</span></div>' +
                '<div class="flex gap-2 shrink-0">' +
                    (!active ? '<button type="button" data-activate-batch="' + esc(x.id) + '" class="label border border-neon/60 text-neon px-3 py-2 hover:bg-neon hover:text-ink transition-colors">Ativar</button>' : "") +
                    '<button type="button" data-edit-batch="' + esc(x.id) + '" class="label border border-ash text-bone px-3 py-2 hover:border-neon hover:text-neon transition-colors">Editar</button>' +
                    (sold === 0 && reserved === 0 ? '<button type="button" data-delete-batch="' + esc(x.id) + '" aria-label="Excluir lote" class="label border border-ash text-smoke px-3 py-2 hover:border-red-400 hover:text-red-300 transition-colors"><i class="fa-solid fa-trash"></i></button>' : "") +
                '</div></div>' +
            bar(total ? ((sold + reserved) / total) * 100 : 0) +
            '<p class="text-xs text-smoke">' + sold + ' vendidos • ' + reserved + ' aguardando PIX • limite ' + total + '</p></div>';
    }).join("") || '<p class="text-sm text-smoke border border-dashed border-ash p-4">Nenhum lote ainda.</p>';

    const products = state.products.map(function (p) {
        return '<label class="flex items-center gap-2 text-sm border border-ash px-3 py-2 cursor-pointer hover:border-neon/50"><input type="checkbox" class="bf-combo accent-[#ccff00]" value="' + esc(p.id) + '"' + (combo.indexOf(p.id) !== -1 ? " checked" : "") + '> ' + esc(p.name) + '</label>';
    }).join("");

    return '<div class="grid xl:grid-cols-2 gap-6 items-start">' +
        '<div class="space-y-3">' + list + '</div>' +
        '<form id="batch-form" class="border border-ash bg-coal p-5 space-y-3">' +
            '<h2 class="font-sport font-black uppercase text-3xl leading-none">' + (editing ? "Editar lote" : "Novo lote") + '</h2>' +
            '<div class="grid grid-cols-[1fr_6rem] gap-3">' +
                '<div><label for="bf-name" class="fz-label">Nome</label><input type="text" id="bf-name" required maxlength="80" placeholder="1º Lote" class="fz-input" value="' + esc(b.name || "") + '"></div>' +
                '<div><label for="bf-order" class="fz-label">Ordem</label><input type="number" id="bf-order" required min="1" max="100" class="fz-input font-mono" value="' + esc(b.order || 1) + '"></div>' +
            '</div>' +
            '<div class="grid grid-cols-2 gap-3">' +
                '<div><label for="bf-price" class="fz-label">Preço (R$)</label><input type="text" id="bf-price" required inputmode="decimal" class="fz-input font-mono" value="' + esc(b.price !== undefined ? String(b.price).replace(".", ",") : "") + '"></div>' +
                '<div><label for="bf-total" class="fz-label">Limite de ingressos</label><input type="number" id="bf-total" required min="0" max="100000" class="fz-input font-mono" value="' + esc(b.totalQuantity !== undefined ? b.totalQuantity : "") + '"></div>' +
            '</div>' +
            '<div><label for="bf-member" class="fz-label">Preço de sócio (opcional)</label><input type="text" id="bf-member" inputmode="decimal" class="fz-input font-mono" value="' + esc(Number(b.memberPrice) > 0 ? String(b.memberPrice).replace(".", ",") : "") + '"></div>' +
            '<div class="border-t border-dashed border-ash pt-3 space-y-2"><span class="fz-label !mb-0">Combo festa (opcional)</span>' +
                '<p class="text-xs text-smoke">Marque os produtos da loja que acompanham o combo. Cada combo vendido baixa 1 unidade do estoque de pronta entrega.</p>' +
                '<div class="grid sm:grid-cols-2 gap-2">' + (products || '<span class="text-xs text-smoke">Nenhum produto cadastrado.</span>') + '</div>' +
                '<div><label for="bf-combo-price" class="fz-label">Preço do combo (R$)</label><input type="text" id="bf-combo-price" inputmode="decimal" class="fz-input font-mono" value="' + esc(Number(b.comboPrice) > 0 ? String(b.comboPrice).replace(".", ",") : "") + '"></div></div>' +
            '<label class="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" id="bf-auto" class="accent-[#ccff00]"' + (b.autoTurn ? " checked" : "") + '> Virar para o próximo lote automaticamente ao esgotar</label>' +
            '<p id="batch-form-error" class="hidden text-sm text-red-300 border border-red-400/40 bg-red-400/10 px-3 py-2"></p>' +
            '<div class="flex gap-3"><button type="submit" class="btn-razor btn-razor--solid flex-1 !text-base"><span>' + (editing ? "Salvar lote" : "Criar lote") + '</span><span class="arrow">→</span></button>' +
                (editing ? '<button type="button" id="batch-cancel" class="label border border-ash text-smoke px-4 hover:text-bone transition-colors">Cancelar</button>' : "") + '</div>' +
        '</form></div>';
}

async function saveBatch() {
    const errEl = byId("batch-form-error");
    const fail = function (m) { errEl.textContent = m; errEl.classList.remove("hidden"); };
    errEl.classList.add("hidden");
    const ev = selectedEvent();
    if (!ev) return;

    const price = num(byId("bf-price").value);
    const memberRaw = byId("bf-member").value.trim();
    const comboRaw = byId("bf-combo-price").value.trim();
    const memberPrice = memberRaw ? num(memberRaw) : 0;
    const comboPrice = comboRaw ? num(comboRaw) : 0;
    const total = Number(byId("bf-total").value);
    const order = Number(byId("bf-order").value);
    const comboItems = Array.from(document.querySelectorAll(".bf-combo:checked")).map(function (c) { return c.value; });

    if (!byId("bf-name").value.trim()) return fail("Informe o nome do lote.");
    if (!(price > 0) || price > 10000) return fail("Preço inválido.");
    if (isNaN(memberPrice) || memberPrice < 0 || memberPrice >= price && memberPrice > 0) return fail("O preço de sócio precisa ser menor que o preço normal.");
    if (isNaN(comboPrice) || comboPrice < 0) return fail("Preço do combo inválido.");
    if (comboItems.length && !(comboPrice > 0)) return fail("Informe o preço do combo.");
    if (!Number.isInteger(total) || total < 0) return fail("Limite de ingressos inválido.");
    if (!Number.isInteger(order) || order < 1 || order > 100) return fail("Ordem inválida.");

    const editing = state.batches.find(function (b) { return b.id === state.editingBatchId; }) || null;
    if (editing && total < Number(editing.soldQuantity || 0) + Number(editing.reservedQuantity || 0)) {
        return fail("O limite não pode ficar abaixo do que já foi vendido ou reservado.");
    }

    const data = {
        name: byId("bf-name").value.trim(),
        order: order,
        price: price,
        memberPrice: memberPrice,
        comboPrice: comboItems.length ? comboPrice : 0,
        comboItems: comboItems,
        totalQuantity: total,
        autoTurn: byId("bf-auto").checked
    };

    try {
        if (editing) {
            await updateDoc(doc(batchesCol(ev.id), editing.id), data);
            toast("Lote salvo.");
        } else {
            data.soldQuantity = 0;
            data.reservedQuantity = 0;
            const ref = await addDoc(batchesCol(ev.id), data);
            // O primeiro lote ja nasce ativo
            if (!ev.activeBatchId) await updateDoc(eventRef(ev.id), { activeBatchId: ref.id, updatedAt: serverTimestamp() });
            toast("Lote criado.");
        }
        state.editingBatchId = null;
        document.activeElement && document.activeElement.blur();
        renderDetail();
    } catch (err) {
        fail(firestoreError(err));
    }
}

// ---------------------------------------------------------------- Cortesias
function courtesyHtml() {
    const issued = state.tickets.filter(function (t) { return t.courtesy && (t.status === "valid" || t.status === "used"); });
    const links = state.courtesyLinks.map(function (l, i) {
        return '<div class="flex gap-2"><input type="text" readonly class="fz-input !text-xs font-mono select-all" value="' + esc(l) + '">' +
            '<button type="button" data-copy="' + esc(l) + '" class="bg-neon text-ink px-4 label font-bold shrink-0 hover:bg-bone transition-colors" aria-label="Copiar link ' + (i + 1) + '"><i class="fa-solid fa-copy"></i></button></div>';
    }).join("");

    return '<div class="grid xl:grid-cols-2 gap-6 items-start">' +
        '<form id="courtesy-form" class="border border-ash bg-coal p-5 space-y-3">' +
            '<h2 class="font-sport font-black uppercase text-3xl leading-none">Emitir <span class="text-neon">cortesia</span></h2>' +
            '<p class="text-xs text-smoke">Cada cortesia gera um link. Envie para o convidado: ele entra na conta dele, confirma os dados e o ingresso passa para o nome dele. Enquanto ninguém aceitar, a cortesia fica na sua carteira.</p>' +
            '<div class="grid grid-cols-[1fr_6rem] gap-3">' +
                '<div><label for="cf-name" class="fz-label">Convidado (opcional)</label><input type="text" id="cf-name" maxlength="80" placeholder="DJ, patrocinador, atleta..." class="fz-input"></div>' +
                '<div><label for="cf-qty" class="fz-label">Qtd.</label><input type="number" id="cf-qty" required min="1" max="20" value="1" class="fz-input font-mono"></div>' +
            '</div>' +
            '<div><label for="cf-note" class="fz-label">Observação interna (opcional)</label><input type="text" id="cf-note" maxlength="200" class="fz-input"></div>' +
            '<button type="submit" id="cf-submit" class="btn-razor btn-razor--solid w-full !text-base"><span>Emitir</span><span class="arrow">→</span></button>' +
            (links ? '<div class="border-t border-dashed border-ash pt-3 space-y-2"><span class="fz-label !mb-0">Links gerados agora (copie antes de sair desta tela)</span>' + links + '</div>' : "") +
        '</form>' +
        '<div class="space-y-2"><span class="fz-label">Cortesias emitidas (' + issued.length + ')</span>' +
            (issued.map(function (t) {
                return '<div class="border border-ash p-3 flex items-center justify-between gap-3 text-sm"><span class="min-w-0"><span class="font-semibold block truncate">' + esc(t.ownerName || "Cortesia") + '</span>' +
                    '<span class="text-xs text-smoke">#' + esc(String(t.id).slice(0, 8).toUpperCase()) + (t.courtesyNote ? " • " + esc(t.courtesyNote) : "") + '</span></span>' +
                    '<span class="label shrink-0 ' + (t.status === "used" ? "text-smoke" : (Number(t.transferDeadlineMs || 0) > Date.now() ? "text-amber-300" : "text-neon")) + '">' +
                    (t.status === "used" ? "Entrou" : (Number(t.transferDeadlineMs || 0) > Date.now() ? "Aguardando aceite" : "Aceita")) + '</span></div>';
            }).join("") || '<p class="text-sm text-smoke border border-dashed border-ash p-4">Nenhuma cortesia emitida.</p>') +
        '</div></div>';
}

async function issueCourtesy() {
    const ev = selectedEvent();
    const btn = byId("cf-submit");
    btn.disabled = true;
    try {
        const res = await callWorker(state.user, "/api/events/courtesy", "POST", {
            eventId: ev.id,
            quantity: Number(byId("cf-qty").value),
            guestName: byId("cf-name").value.trim(),
            note: byId("cf-note").value.trim()
        });
        if (!res.ok) { toast(res.data && res.data.message ? res.data.message : "Não foi possível emitir.", "error"); return; }
        state.courtesyLinks = res.data.tickets.map(function (t) { return SITE_URL + "/#transferir=" + t.code; }).concat(state.courtesyLinks);
        toast(res.data.tickets.length + " cortesia(s) emitida(s).");
        document.activeElement && document.activeElement.blur();
        renderDetail();
    } catch (e) {
        toast("Falha de conexão.", "error");
    } finally {
        btn.disabled = false;
    }
}

// ---------------------------------------------------------------- Vendas
function salesHtml() {
    const rows = state.orders.map(function (o) {
        const tone = o.status === "paid" ? "text-neon" : (o.status === "review" ? "text-amber-300" : "text-smoke");
        return '<tr class="border-b border-ash/60 align-top">' +
            '<td class="py-2 pr-3 font-mono text-xs">' + esc(o.orderId || o.id) + '<span class="block text-smoke">' + esc(shortDateTime(toDate(o.createdAtISO))) + '</span></td>' +
            '<td class="py-2 pr-3"><span class="font-semibold">' + esc(o.customerName || "") + '</span><span class="block text-xs text-smoke break-all">' + esc(o.customerEmail || "") + (o.customerPhone ? " • " + esc(o.customerPhone) : "") + '</span>' +
                (o.adminNote ? '<span class="block text-xs text-amber-300 mt-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>' + esc(o.adminNote) + '</span>' : "") + '</td>' +
            '<td class="py-2 pr-3 text-sm">' + esc(o.quantity) + '× ' + (o.kind === "combo" ? "Combo" : "Avulso") + '<span class="block text-xs text-smoke">' + esc(o.batchName || "") + (o.memberPrice ? " • sócio" : "") + '</span></td>' +
            '<td class="py-2 pr-3 font-mono text-sm whitespace-nowrap">' + money(o.total) + '</td>' +
            '<td class="py-2 label ' + tone + ' whitespace-nowrap">' + esc(ORDER_LABEL[o.status] || o.status) + '</td></tr>';
    }).join("");

    return '<div class="space-y-4">' +
        '<div class="flex flex-wrap items-center justify-between gap-3"><span class="fz-label !mb-0">' + state.orders.length + ' pedido(s) • ' + state.tickets.filter(function (t) { return t.status === "valid" || t.status === "used"; }).length + ' ingresso(s) emitido(s)</span>' +
            '<button type="button" id="export-csv" class="label border border-ash text-bone px-3 py-2 hover:border-neon hover:text-neon transition-colors"><i class="fa-solid fa-file-csv mr-1"></i> Exportar lista de ingressos (CSV)</button></div>' +
        (rows ? '<div class="overflow-x-auto"><table class="w-full text-left min-w-[640px]"><thead><tr class="border-b border-ash label text-smoke"><th class="py-2 pr-3 font-normal">Pedido</th><th class="py-2 pr-3 font-normal">Comprador</th><th class="py-2 pr-3 font-normal">Itens</th><th class="py-2 pr-3 font-normal">Total</th><th class="py-2 font-normal">Situação</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
            : '<p class="text-sm text-smoke border border-dashed border-ash p-4">Nenhuma venda ainda.</p>') +
    '</div>';
}

function exportCsv() {
    const ev = selectedEvent();
    const cell = function (v) { return '"' + String(v === null || v === undefined ? "" : v).replace(/"/g, '""') + '"'; };
    const lines = [["Ingresso", "Titular", "CPF", "Matricula", "Lote", "Tipo", "Situacao", "Entrada", "Kit retirado", "Pedido"].map(cell).join(";")];
    state.tickets
        .filter(function (t) { return t.status === "valid" || t.status === "used"; })
        .sort(function (a, b) { return String(a.ownerName || "").localeCompare(String(b.ownerName || "")); })
        .forEach(function (t) {
            lines.push([
                String(t.id).slice(0, 8).toUpperCase(), t.ownerName, t.ownerCpf, t.ownerMatricula, t.batchName,
                t.courtesy ? "Cortesia" : (t.isCombo ? "Combo" : "Avulso"),
                t.status === "used" ? "Utilizado" : "Valido",
                t.checkedInAt ? shortDateTime(toDate(t.checkedInAt)) : "",
                t.isCombo ? (t.comboRedeemed ? "Sim" : "Nao") : "",
                t.orderId
            ].map(cell).join(";"));
        });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ingressos-" + (ev ? ev.id : "evento") + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
}

// ============================================================================
// EQUIPE DA PORTARIA E SOCIOS
// ============================================================================
function renderTeam() {
    const el = byId("adm-tab-equipe");
    const focused = document.activeElement;
    if (focused && el.contains(focused) && focused.tagName === "INPUT") return;

    const block = function (role, title, hint, list, extraField) {
        return '<div class="border border-ash bg-coal p-5 space-y-4">' +
            '<div><h2 class="font-sport font-black uppercase text-3xl leading-none">' + title + '</h2><p class="text-xs text-smoke mt-2">' + hint + '</p></div>' +
            '<form data-role-form="' + role + '" class="space-y-2">' +
                '<input type="text" required maxlength="200" placeholder="E-mail da conta no site" class="fz-input role-identifier" autocomplete="off">' +
                '<input type="text" maxlength="120" placeholder="Nome (opcional)" class="fz-input role-name">' + (extraField || "") +
                '<button type="submit" class="btn-razor btn-razor--ghost w-full !text-base"><span class="flex items-center gap-2"><i class="fa-solid fa-user-plus"></i> Adicionar</span><span class="arrow">→</span></button>' +
            '</form>' +
            '<div class="space-y-2">' + (list.map(function (p) {
                return '<div class="border border-ash p-3 flex items-center justify-between gap-3 text-sm"><span class="min-w-0"><span class="font-semibold block truncate">' + esc(p.name || p.email || p.uid) + '</span>' +
                    '<span class="text-xs text-smoke block truncate">' + esc(p.email || p.uid) + (p.matricula ? " • " + esc(p.matricula) : "") + '</span></span>' +
                    '<button type="button" data-role-remove="' + role + '" data-uid="' + esc(p.uid) + '" aria-label="Remover" class="label border border-ash text-smoke px-3 py-2 hover:border-red-400 hover:text-red-300 transition-colors shrink-0"><i class="fa-solid fa-trash"></i></button></div>';
            }).join("") || '<p class="text-sm text-smoke border border-dashed border-ash p-4">Ninguém cadastrado.</p>') + '</div></div>';
    };

    el.innerHTML =
        block("staff", 'Equipe da <span class="text-neon">portaria</span>', "Quem pode abrir /portaria e ler ingressos. Administradores já têm acesso. A pessoa precisa ter conta no site.", state.staff) +
        block("member", '<span class="text-neon">Sócios</span>', "Contas que pagam o preço de sócio nos lotes que tiverem esse preço.", state.members,
            '<input type="text" maxlength="12" inputmode="numeric" placeholder="Matrícula (opcional)" class="fz-input font-mono role-matricula">');
}

async function addRole(form) {
    const role = form.getAttribute("data-role-form");
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
        const matriculaEl = form.querySelector(".role-matricula");
        const res = await callWorker(state.user, "/api/admin/roles", "POST", {
            role: role,
            identifier: form.querySelector(".role-identifier").value.trim(),
            name: form.querySelector(".role-name").value.trim(),
            matricula: matriculaEl ? matriculaEl.value : ""
        });
        if (!res.ok) { toast(res.data && res.data.message ? res.data.message : "Não foi possível cadastrar.", "error"); return; }
        toast((res.data.name || res.data.email || "Conta") + " adicionada.");
        form.reset();
        document.activeElement && document.activeElement.blur();
    } catch (e) {
        toast("Falha de conexão.", "error");
    } finally {
        btn.disabled = false;
    }
}

// ============================================================================
// EVENTOS DE TELA
// ============================================================================
document.addEventListener("click", async function (e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;

    const mainTab = t.closest("[data-main-tab]");
    if (mainTab) {
        const name = mainTab.getAttribute("data-main-tab");
        document.querySelectorAll("[data-main-tab]").forEach(function (b) { b.classList.toggle("is-active", b === mainTab); });
        byId("adm-tab-eventos").classList.toggle("hidden", name !== "eventos");
        byId("adm-tab-equipe").classList.toggle("hidden", name !== "equipe");
        if (name === "equipe") renderTeam();
        return;
    }

    if (t.closest("#adm-new-event")) {
        stopListeners(state.unsubs);
        state.creating = true;
        state.selectedId = null;
        renderEventList();
        renderDetail();
        return;
    }
    if (t.closest("#event-cancel")) {
        state.creating = false;
        if (state.events.length) selectEvent(state.events[0].id);
        renderEventList();
        renderDetail();
        return;
    }

    const sel = t.closest("[data-select-event]");
    if (sel) { state.tab = "painel"; selectEvent(sel.getAttribute("data-select-event")); renderEventList(); renderDetail(); return; }

    const tab = t.closest("[data-tab]");
    if (tab) { state.tab = tab.getAttribute("data-tab"); state.editingBatchId = null; state.costsDraft = null; renderDetail(); return; }

    const setStatus = t.closest("[data-set-status]");
    if (setStatus) {
        const ev = selectedEvent();
        const status = setStatus.getAttribute("data-set-status");
        if (status === "published" && !ev.activeBatchId) { toast("Crie um lote antes de publicar.", "error"); return; }
        if (status === "finished" && !window.confirm("Encerrar o evento? Ele sai da vitrine e as vendas param.")) return;
        try {
            await updateDoc(eventRef(ev.id), { status: status, updatedAt: serverTimestamp() });
            toast("Evento: " + STATUS_LABEL[status] + ".");
        } catch (err) { toast(firestoreError(err), "error"); }
        return;
    }

    const activate = t.closest("[data-activate-batch]");
    if (activate) {
        const ev = selectedEvent();
        try {
            await updateDoc(eventRef(ev.id), { activeBatchId: activate.getAttribute("data-activate-batch"), updatedAt: serverTimestamp() });
            toast("Lote virado. As vendas passam a usar o novo lote.");
        } catch (err) { toast(firestoreError(err), "error"); }
        return;
    }

    const editBatch = t.closest("[data-edit-batch]");
    if (editBatch) { state.editingBatchId = editBatch.getAttribute("data-edit-batch"); renderDetail(); return; }
    if (t.closest("#batch-cancel")) { state.editingBatchId = null; renderDetail(); return; }

    const delBatch = t.closest("[data-delete-batch]");
    if (delBatch) {
        const ev = selectedEvent();
        const id = delBatch.getAttribute("data-delete-batch");
        if (!window.confirm("Excluir este lote?")) return;
        try {
            await deleteDoc(doc(batchesCol(ev.id), id));
            if (ev.activeBatchId === id) await updateDoc(eventRef(ev.id), { activeBatchId: "", updatedAt: serverTimestamp() });
            toast("Lote excluído.");
        } catch (err) { toast(firestoreError(err), "error"); }
        return;
    }

    if (t.closest("#event-delete")) {
        const ev = selectedEvent();
        if (!window.confirm("Excluir o evento \"" + ev.title + "\" e seus lotes? Não dá para desfazer.")) return;
        try {
            for (const b of state.batches) await deleteDoc(doc(batchesCol(ev.id), b.id));
            await deleteDoc(financeRef(ev.id)).catch(function () { /* sem custos cadastrados */ });
            await deleteDoc(eventRef(ev.id));
            selectEvent(null);
            toast("Evento excluído.");
        } catch (err) { toast(firestoreError(err), "error"); }
        return;
    }

    if (t.closest("#cost-add")) {
        state.costsDraft = readCostRows().concat([{ label: "", amount: "" }]);
        byId("costs-rows").innerHTML = state.costsDraft.map(costRowHtml).join("");
        return;
    }
    if (t.closest("[data-cost-remove]")) {
        t.closest(".cost-row").remove();
        state.costsDraft = readCostRows();
        return;
    }

    const copy = t.closest("[data-copy]");
    if (copy) {
        try { await navigator.clipboard.writeText(copy.getAttribute("data-copy")); toast("Link copiado."); }
        catch (err) { toast("Não foi possível copiar. Selecione o texto.", "error"); }
        return;
    }

    if (t.closest("#export-csv")) { exportCsv(); return; }

    const removeRole = t.closest("[data-role-remove]");
    if (removeRole) {
        const col = removeRole.getAttribute("data-role-remove") === "member" ? "members" : "staff";
        if (!window.confirm("Remover este cadastro?")) return;
        try { await deleteDoc(doc(db, "artifacts", APP_ID, col, removeRole.getAttribute("data-uid"))); toast("Removido."); }
        catch (err) { toast(firestoreError(err), "error"); }
    }
});

document.addEventListener("submit", async function (e) {
    const form = e.target;
    if (!form || !form.id && !form.hasAttribute("data-role-form")) return;
    if (form.id === "adm-login-form") return;
    e.preventDefault();

    if (form.id === "event-form") return saveEvent();
    if (form.id === "batch-form") return saveBatch();
    if (form.id === "courtesy-form") return issueCourtesy();
    if (form.hasAttribute("data-role-form")) return addRole(form);

    if (form.id === "costs-form") {
        const ev = selectedEvent();
        const rows = readCostRows().filter(function (c) { return c.label && Number(c.amount) > 0; }).slice(0, 60);
        const fee = num(byId("fee-percent").value);
        if (isNaN(fee) || fee < 0 || fee > 30) { toast("Taxa inválida.", "error"); return; }
        try {
            await setDoc(financeRef(ev.id), { costs: rows, feePercent: fee, updatedAt: serverTimestamp() });
            state.costsDraft = null;
            document.activeElement && document.activeElement.blur();
            toast("Custos salvos.");
        } catch (err) { toast(firestoreError(err), "error"); }
    }
});

// Sugere o endereco do evento a partir do nome (so na criacao)
document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "ef-title" && state.creating) {
        const slugEl = byId("ef-slug");
        if (slugEl && !slugEl.dataset.touched) slugEl.value = slugify(e.target.value);
    }
    if (e.target && e.target.id === "ef-slug") e.target.dataset.touched = "1";
});

// So no ambiente local: permite simular dados para testar as telas
if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    window.__fzAdminDebug = { state: state, show: show, renderEventList: renderEventList, renderDetail: renderDetail, renderTeam: renderTeam };
}
