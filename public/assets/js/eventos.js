// public/assets/js/eventos.js
// Bilheteria da Atletica FurioZOs (PRD_EVENTOS.md, Milestone 2):
//   - vitrine de eventos e pagina do evento (barra de ocupacao do lote);
//   - compra por PIX com reserva de 10 minutos (o Worker define preco e vaga);
//   - carteira "Meus ingressos": QR Code, transferencia e PDF.
// Reaproveita login, mascaras e chamadas ao Worker da loja via window.FZ.
import {
    collection,
    doc,
    getDoc,
    onSnapshot,
    query,
    where
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const FZ = window.FZ;

const LIBS = {
    qrcode: {
        url: "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js",
        integrity: "sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k",
        ready: function () { return typeof window.qrcode === "function"; }
    },
    jspdf: {
        url: "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
        integrity: "sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk",
        ready: function () { return Boolean(window.jspdf && window.jspdf.jsPDF); }
    }
};

const MAX_TICKETS_PER_ORDER = 5;
const WEEKDAYS = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];
const MONTHS = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
const PENDING_TRANSFER_KEY = "fz_pending_transfer";

const state = {
    events: new Map(),      // eventId -> { id, data, batches: Map, unsubBatches }
    eventsReady: false,
    openEventId: null,
    selection: { kind: "avulso", quantity: 1 },
    isMember: false,
    tickets: [],
    ticketsReady: false,
    unsubTickets: null,
    openTicketId: null,
    ticketView: "entrada",
    offerCodes: new Map(),  // ticketId -> codigo gerado nesta sessao
    pix: null               // { orderId, expiresAtMs, timer, poll, unsub, done }
};

// ============================================================================
// UTILITARIOS
// ============================================================================
function byId(id) { return document.getElementById(id); }
function esc(v) { return FZ.esc(v); }
function money(v) { return FZ.formatPrice(v); }

function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === "function") return v.toDate();
    if (typeof v.seconds === "number") return new Date(v.seconds * 1000);
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

function pad2(n) { return String(n).padStart(2, "0"); }

function dateParts(d) {
    if (!d) return { weekday: "", day: "--", month: "", time: "", full: "Data a definir" };
    const time = pad2(d.getHours()) + "h" + pad2(d.getMinutes());
    return {
        weekday: WEEKDAYS[d.getDay()],
        day: pad2(d.getDate()),
        month: MONTHS[d.getMonth()],
        time: time,
        full: WEEKDAYS[d.getDay()] + " • " + pad2(d.getDate()) + " " + MONTHS[d.getMonth()] + " " + d.getFullYear() + " • " + time
    };
}

function safeUrl(u) {
    const s = String(u || "").trim();
    return /^https:\/\//i.test(s) || /^assets\//.test(s) ? s : "";
}

function loadLib(name) {
    const lib = LIBS[name];
    if (lib.ready()) return Promise.resolve();
    if (lib.promise) return lib.promise;
    lib.promise = new Promise(function (resolve, reject) {
        const s = document.createElement("script");
        s.src = lib.url;
        s.integrity = lib.integrity;
        s.crossOrigin = "anonymous";
        s.onload = function () { resolve(); };
        s.onerror = function () { lib.promise = null; reject(new Error("Falha ao carregar " + name)); };
        document.head.appendChild(s);
    });
    return lib.promise;
}

function openOverlay(id) {
    const el = byId(id);
    if (!el) return;
    el.classList.remove("hidden");
    el.classList.add("flex");
}

function closeOverlay(id) {
    const el = byId(id);
    if (!el || el.classList.contains("hidden")) return;
    el.classList.add("hidden");
    el.classList.remove("flex");
    if (id === "ticket-pix-modal") stopPix(true);
    if (id === "event-modal") {
        state.openEventId = null;
        setEventParam(null);
    }
    if (id === "ticket-modal") state.openTicketId = null;
}

function setEventParam(eventId) {
    try {
        const url = new URL(window.location.href);
        if (eventId) url.searchParams.set("evento", eventId);
        else url.searchParams.delete("evento");
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch (e) { /* sem History API: segue sem o link */ }
}

async function copyText(text, okMessage) {
    try {
        await navigator.clipboard.writeText(text);
        FZ.showToast(okMessage || "Copiado!");
    } catch (e) {
        FZ.showToast("Não foi possível copiar. Selecione o texto e copie manualmente.", "error");
    }
}

function cloverSvg(cls) {
    const leaf = "M0 -4 C-16 -10 -20 -34 -8 -38 C-2 -40 0 -34 0 -30 C0 -34 2 -40 8 -38 C20 -34 16 -10 0 -4Z";
    return '<svg class="' + cls + '" viewBox="-60 -60 120 120" aria-hidden="true">' +
        [0, 90, 180, 270].map(function (deg) { return '<path transform="rotate(' + deg + ')" d="' + leaf + '"/>'; }).join("") +
        '<path d="M4 6 C12 22 14 34 22 48"/></svg>';
}

// ============================================================================
// DADOS: EVENTOS E LOTES (tempo real)
// ============================================================================
function eventsCollection() {
    return collection(FZ.db, "artifacts", FZ.appId, "public", "data", "events");
}

function startEventsListener() {
    if (!FZ.db) return;
    const q = query(eventsCollection(), where("status", "in", ["published", "paused"]));
    onSnapshot(q, function (snap) {
        const seen = new Set();
        snap.forEach(function (d) {
            seen.add(d.id);
            let entry = state.events.get(d.id);
            if (!entry) {
                entry = { id: d.id, data: d.data(), batches: new Map(), unsubBatches: null };
                state.events.set(d.id, entry);
                entry.unsubBatches = onSnapshot(collection(eventsCollection(), d.id, "batches"), function (bs) {
                    entry.batches = new Map();
                    bs.forEach(function (b) { entry.batches.set(b.id, b.data()); });
                    renderEventsGrid();
                    if (state.openEventId === d.id) updateEventLive();
                }, function (err) { console.warn("Lotes:", err && err.code ? err.code : err); });
            } else {
                entry.data = d.data();
            }
        });
        Array.from(state.events.keys()).forEach(function (id) {
            if (!seen.has(id)) {
                const e = state.events.get(id);
                if (e.unsubBatches) e.unsubBatches();
                state.events.delete(id);
            }
        });
        state.eventsReady = true;
        renderEventsGrid();
        if (state.openEventId) {
            if (state.events.has(state.openEventId)) updateEventLive();
            else closeOverlay("event-modal");
        }
        openEventFromUrl();
    }, function (err) {
        console.warn("Eventos:", err && err.code ? err.code : err);
    });
}

function visibleEvents() {
    const now = Date.now();
    return Array.from(state.events.values())
        .filter(function (e) {
            const end = toDate(e.data.endsAt) || toDate(e.data.startsAt);
            return !end || end.getTime() > now;
        })
        .sort(function (a, b) {
            const da = toDate(a.data.startsAt), db = toDate(b.data.startsAt);
            return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
        });
}

// Situacao de venda do evento, a partir do lote ativo
function saleInfo(entry) {
    const ev = entry.data;
    const batch = ev.activeBatchId ? entry.batches.get(ev.activeBatchId) : null;
    const info = { batch: batch, batchId: ev.activeBatchId || "", canBuy: false, pct: 0, left: 0, label: "", note: "" };

    if (!batch) {
        info.label = "Em breve";
        info.note = "As vendas ainda não abriram.";
        return info;
    }
    const total = Number(batch.totalQuantity || 0);
    const taken = Number(batch.soldQuantity || 0) + Number(batch.reservedQuantity || 0);
    info.left = Math.max(0, total - taken);
    info.pct = total > 0 ? Math.min(100, Math.round((taken / total) * 100)) : 100;

    if (ev.status === "paused") {
        info.label = "Vendas pausadas";
        info.note = "A diretoria pausou as vendas por enquanto.";
    } else if (info.left <= 0) {
        info.label = "Lote esgotado";
        info.note = "Se alguém não pagar o PIX, a vaga volta em alguns minutos.";
    } else {
        info.canBuy = true;
        if (info.pct >= 90) info.label = "Últimos ingressos";
        else if (info.pct >= 50) info.label = info.pct + "% do lote vendido";
        else info.label = "Lote aberto";
    }
    return info;
}

function hasCombo(batch) {
    return Boolean(batch && Array.isArray(batch.comboItems) && batch.comboItems.length > 0);
}

function unitPrice(batch, kind) {
    if (!batch) return 0;
    const price = Number(batch.price || 0);
    const memberPrice = Number(batch.memberPrice || 0);
    const discount = (state.isMember && memberPrice > 0 && memberPrice < price) ? price - memberPrice : 0;
    let unit = price;
    if (kind === "combo" && Number(batch.comboPrice || 0) > 0) unit = Number(batch.comboPrice);
    return Math.max(0, Math.round((unit - discount) * 100) / 100);
}

function comboNames(batch) {
    if (!hasCombo(batch)) return [];
    return batch.comboItems.map(function (id) {
        const p = FZ.findProduct(String(id));
        return p && p.name ? String(p.name) : String(id);
    });
}

function occupancyBar(info) {
    return '<div class="ev-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + info.pct + '">' +
        '<span style="width:' + info.pct + '%"></span></div>';
}

// ============================================================================
// VITRINE
// ============================================================================
function bannerHtml(ev, extraClass) {
    const url = safeUrl(ev.bannerUrl);
    if (url) {
        return '<img src="' + esc(url) + '" alt="" class="absolute inset-0 w-full h-full object-cover ' + (extraClass || "") + '">';
    }
    return '<div class="soon-panel">' + cloverSvg("soon-clover ev-clover-static") + '</div>';
}

function renderEventsGrid() {
    const section = byId("eventos");
    const grid = byId("events-grid");
    if (!section || !grid) return;

    const list = visibleEvents();
    const show = list.length > 0;
    section.style.display = show ? "" : "none";
    ["nav-eventos", "nav-eventos-mobile"].forEach(function (id) {
        const el = byId(id);
        if (el) el.style.display = show ? "" : "none";
    });
    if (!show) { grid.innerHTML = ""; return; }

    grid.innerHTML = list.map(function (entry, i) {
        const ev = entry.data;
        const info = saleInfo(entry);
        const d = dateParts(toDate(ev.startsAt));
        const price = info.batch ? unitPrice(info.batch, "avulso") : 0;
        const eid = esc(entry.id);

        return '<article class="group bg-coal border border-ash hover:border-neon/50 transition-colors duration-500 flex flex-col sm:flex-row cursor-pointer" data-ev-open="' + eid + '">' +
            '<div class="relative sm:w-[42%] shrink-0 aspect-[4/3] sm:aspect-auto sm:min-h-[260px] overflow-hidden bg-soot">' +
                bannerHtml(ev, "group-hover:scale-105 transition-transform duration-700") +
                '<span class="absolute top-3 left-3 z-10 label bg-ink/80 text-bone px-2 py-1">' + String(i + 1).padStart(3, "0") + ' / Evento</span>' +
                '<div class="absolute bottom-0 left-0 z-10 bg-neon text-ink px-4 py-2 text-center">' +
                    '<span class="label font-bold block">' + esc(d.weekday) + '</span>' +
                    '<span class="font-sport font-black text-4xl leading-none block">' + esc(d.day) + '</span>' +
                    '<span class="label font-bold block">' + esc(d.month) + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="p-5 sm:p-6 flex flex-col gap-3 flex-1 min-w-0 border-t sm:border-t-0 sm:border-l border-dashed border-ash">' +
                '<span class="label ' + (info.canBuy ? "text-neon" : "text-smoke") + '">' + esc(info.batch ? (info.batch.name || "Lote") : "Bilheteria") + ' • ' + esc(info.label) + '</span>' +
                '<h3 class="font-sport font-black uppercase text-4xl leading-[0.9] text-bone group-hover:text-neon transition-colors break-words">' + esc(ev.title) + '</h3>' +
                '<p class="text-sm text-smoke flex flex-col gap-1">' +
                    '<span><i class="fa-regular fa-clock w-5 text-neon"></i>' + esc(d.time ? d.time : "Horário a definir") + '</span>' +
                    (ev.location ? '<span class="truncate"><i class="fa-solid fa-location-dot w-5 text-neon"></i>' + esc(ev.location) + '</span>' : "") +
                '</p>' +
                '<div class="mt-auto space-y-3">' +
                    occupancyBar(info) +
                    '<div class="flex items-center justify-between gap-3">' +
                        '<span>' + (price > 0
                            ? '<span class="label text-smoke block">A partir de</span><span class="font-mono font-semibold text-2xl text-neon tracking-tight">' + money(price) + '</span>'
                            : '<span class="label text-smoke">Em breve</span>') + '</span>' +
                        '<span class="bg-neon text-ink w-12 h-12 flex items-center justify-center group-hover:bg-bone transition-colors"><i class="fa-solid fa-arrow-right text-lg group-hover:-rotate-45 transition-transform duration-300"></i></span>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</article>';
    }).join("");
}

// ============================================================================
// PAGINA DO EVENTO
// ============================================================================
function openEventFromUrl() {
    if (state.openEventId) return;
    let id = "";
    try { id = new URL(window.location.href).searchParams.get("evento") || ""; } catch (e) { id = ""; }
    if (id && state.events.has(id)) openEvent(id);
}

function openEvent(eventId) {
    const entry = state.events.get(eventId);
    const body = byId("event-modal-body");
    if (!entry || !body) return;

    state.openEventId = eventId;
    state.selection = { kind: "avulso", quantity: 1 };
    const ev = entry.data;
    const start = dateParts(toDate(ev.startsAt));
    const end = toDate(ev.endsAt);
    const mapUrl = safeUrl(ev.mapUrl);
    const profile = FZ.profile || {};
    const user = FZ.user;
    const defaultName = profile.name || (user && user.displayName) || "";

    body.innerHTML =
        '<div class="grid md:grid-cols-[42%_1fr]">' +
            '<div class="relative min-h-[220px] md:min-h-[560px] bg-soot overflow-hidden">' +
                bannerHtml(ev, "") +
                '<div class="absolute inset-0 bg-gradient-to-t from-ink via-transparent to-transparent pointer-events-none"></div>' +
                '<button type="button" data-ev-close="event-modal" aria-label="Fechar" class="md:hidden absolute top-3 right-3 z-10 fz-close bg-ink/70"><i class="fa-solid fa-xmark"></i></button>' +
                '<div class="absolute bottom-0 left-0 z-10 bg-neon text-ink px-5 py-3 text-center">' +
                    '<span class="label font-bold block">' + esc(start.weekday) + '</span>' +
                    '<span class="font-sport font-black text-5xl leading-none block">' + esc(start.day) + '</span>' +
                    '<span class="label font-bold block">' + esc(start.month) + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="p-6 md:p-8 space-y-6 min-w-0">' +
                '<div class="flex justify-between items-start gap-4">' +
                    '<div class="min-w-0">' +
                        '<span class="label text-neon">Bilheteria oficial • FurioZOs</span>' +
                        '<h2 class="font-sport font-black uppercase text-5xl leading-[0.88] mt-1 break-words">' + esc(ev.title) + '</h2>' +
                    '</div>' +
                    '<button type="button" data-ev-close="event-modal" aria-label="Fechar" class="hidden md:flex fz-close shrink-0"><i class="fa-solid fa-xmark"></i></button>' +
                '</div>' +

                '<div class="grid sm:grid-cols-2 gap-3 text-sm">' +
                    '<div class="border border-ash p-3"><span class="fz-label">Quando</span><span class="text-bone font-semibold">' + esc(start.full) + '</span>' +
                        (end ? '<span class="block text-smoke text-xs mt-1">até ' + pad2(end.getHours()) + 'h' + pad2(end.getMinutes()) + '</span>' : "") + '</div>' +
                    '<div class="border border-ash p-3"><span class="fz-label">Onde</span><span class="text-bone font-semibold break-words">' + esc(ev.location || "Local a definir") + '</span>' +
                        (mapUrl ? '<a href="' + esc(mapUrl) + '" target="_blank" rel="noopener noreferrer" class="block text-neon text-xs mt-1 hover:underline">Abrir no mapa ↗</a>' : "") + '</div>' +
                '</div>' +

                (ev.description ? '<p class="text-sm text-bone/80 leading-relaxed whitespace-pre-line break-words">' + esc(ev.description) + '</p>' : "") +

                '<div class="border border-ash bg-ink/40 p-4 space-y-3">' +
                    '<div class="flex items-center justify-between gap-3"><span id="ev-batch-name" class="label text-neon"></span><span id="ev-batch-label" class="label text-smoke"></span></div>' +
                    '<div id="ev-bar-slot"></div>' +
                    '<p id="ev-batch-note" class="text-xs text-smoke"></p>' +
                '</div>' +

                '<div id="ev-buy-area" class="space-y-5">' +
                    '<div><span class="fz-label">Escolha seu ingresso</span><div id="ev-options" class="grid sm:grid-cols-2 gap-3"></div></div>' +

                    '<div class="flex items-center justify-between gap-4 border-y border-dashed border-ash py-4">' +
                        '<div><span class="fz-label !mb-1">Quantidade</span>' +
                            '<div class="flex items-center border border-ash w-max">' +
                                '<button type="button" data-ev-qty="-1" aria-label="Diminuir" class="w-11 h-11 text-bone hover:bg-neon hover:text-ink transition-colors"><i class="fa-solid fa-minus"></i></button>' +
                                '<span id="ev-qty" class="w-12 text-center font-mono font-semibold text-lg">1</span>' +
                                '<button type="button" data-ev-qty="1" aria-label="Aumentar" class="w-11 h-11 text-bone hover:bg-neon hover:text-ink transition-colors"><i class="fa-solid fa-plus"></i></button>' +
                            '</div></div>' +
                        '<div class="text-right"><span class="fz-label !mb-1">Total no PIX</span><span id="ev-total" class="font-mono font-semibold text-3xl text-neon tracking-tight"></span>' +
                            '<span id="ev-member-note" class="hidden label text-neon mt-1">Preço de sócio aplicado</span></div>' +
                    '</div>' +

                    '<form id="ev-buy-form" class="space-y-3" novalidate>' +
                        '<span class="fz-label">Titular do ingresso</span>' +
                        '<input type="text" id="ev-name" required maxlength="80" placeholder="Nome completo" autocomplete="name" class="fz-input" value="' + esc(defaultName) + '">' +
                        '<div class="grid sm:grid-cols-2 gap-3">' +
                            '<input type="text" id="ev-cpf" required inputmode="numeric" maxlength="14" placeholder="CPF" class="fz-input font-mono">' +
                            '<input type="text" id="ev-matricula" inputmode="numeric" maxlength="12" placeholder="Matrícula UERJ (opcional)" class="fz-input font-mono" value="' + esc(profile.matricula || "") + '">' +
                        '</div>' +
                        '<input type="tel" id="ev-phone" maxlength="15" placeholder="WhatsApp com DDD (opcional)" class="fz-input" value="' + esc(profile.phone || "") + '">' +
                        '<p class="text-xs text-smoke">O CPF vai só para o Mercado Pago gerar o PIX. No ingresso ele aparece mascarado. Comprando mais de um, todos saem no seu nome e você transfere depois.</p>' +
                        '<p id="ev-buy-error" class="hidden text-sm text-red-300 border border-red-400/40 bg-red-400/10 px-3 py-2"></p>' +
                        '<button type="submit" id="ev-buy-btn" class="btn-razor btn-razor--solid w-full">' +
                            '<span class="flex items-center gap-2"><i class="fa-brands fa-pix"></i> <span id="ev-buy-label">Gerar PIX</span></span><span class="arrow">→</span>' +
                        '</button>' +
                    '</form>' +
                '</div>' +

                '<button type="button" id="ev-share" class="label text-smoke hover:text-neon transition-colors"><i class="fa-solid fa-link mr-1"></i> Copiar link do evento</button>' +
            '</div>' +
        '</div>';

    updateEventLive();
    setEventParam(eventId);
    openOverlay("event-modal");
}

// Atualiza so o que muda em tempo real (sem apagar o que a pessoa digitou)
function updateEventLive() {
    const entry = state.events.get(state.openEventId);
    if (!entry || !byId("ev-options")) return;
    const info = saleInfo(entry);
    const batch = info.batch;

    byId("ev-batch-name").textContent = batch ? (batch.name || "Lote") : "Bilheteria";
    byId("ev-batch-label").textContent = info.label;
    byId("ev-batch-note").textContent = info.note || (info.canBuy && info.left <= 10 ? "Restam " + info.left + " ingresso(s) neste lote." : "A barra mostra o quanto do lote já foi garantido.");
    byId("ev-bar-slot").innerHTML = occupancyBar(info);

    const combo = hasCombo(batch);
    if (!combo && state.selection.kind === "combo") state.selection.kind = "avulso";
    const maxQty = Math.max(1, Math.min(MAX_TICKETS_PER_ORDER, info.left || 1));
    if (state.selection.quantity > maxQty) state.selection.quantity = maxQty;

    const opt = function (kind, title, desc, price) {
        const active = state.selection.kind === kind;
        return '<button type="button" data-ev-kind="' + kind + '" aria-pressed="' + active + '" class="ev-opt' + (active ? " is-active" : "") + '">' +
            '<span class="label ' + (active ? "text-neon" : "text-smoke") + '">' + title + '</span>' +
            '<span class="font-mono font-semibold text-2xl text-bone tracking-tight">' + money(price) + '</span>' +
            '<span class="text-xs text-smoke leading-snug">' + desc + '</span></button>';
    };
    let options = opt("avulso", "Ingresso avulso", "Entrada no evento.", unitPrice(batch, "avulso"));
    if (combo) {
        options += opt("combo", "Combo festa", "Entrada + " + esc(comboNames(batch).join(" + ")) + ". Retirada no estande.", unitPrice(batch, "combo"));
    }
    byId("ev-options").innerHTML = options;
    byId("ev-options").classList.toggle("sm:grid-cols-2", combo);

    byId("ev-qty").textContent = String(state.selection.quantity);
    const total = unitPrice(batch, state.selection.kind) * state.selection.quantity;
    byId("ev-total").textContent = money(total);
    const memberApplied = state.isMember && batch && Number(batch.memberPrice || 0) > 0 && Number(batch.memberPrice) < Number(batch.price || 0);
    byId("ev-member-note").classList.toggle("hidden", !memberApplied);

    const btn = byId("ev-buy-btn");
    const busy = btn.dataset.busy === "1";
    btn.disabled = !info.canBuy || busy;
    btn.classList.toggle("opacity-50", !info.canBuy);
    btn.classList.toggle("cursor-not-allowed", !info.canBuy);
    if (!busy) byId("ev-buy-label").textContent = info.canBuy ? (FZ.user ? "Gerar PIX" : "Entrar e comprar") : info.label;
}

function setBuyError(message) {
    const el = byId("ev-buy-error");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("hidden", !message);
}

async function submitPurchase() {
    const entry = state.events.get(state.openEventId);
    if (!entry) return;
    setBuyError("");

    if (!FZ.user) {
        FZ.showToast("Entre ou crie sua conta para comprar o ingresso.");
        FZ.openAuthModal();
        return;
    }

    const name = byId("ev-name").value.trim();
    const cpf = byId("ev-cpf").value.replace(/\D/g, "");
    const matricula = byId("ev-matricula").value.replace(/\D/g, "");
    const phone = byId("ev-phone").value.replace(/\D/g, "");
    if (name.length < 3) return setBuyError("Informe o nome completo do titular.");
    if (!FZ.isValidCpf(cpf)) return setBuyError("CPF inválido. Confira os números.");
    if (matricula && matricula.length !== 12) return setBuyError("A matrícula UERJ tem 12 números (ou deixe em branco).");
    if (phone && (phone.length < 10 || phone.length > 11)) return setBuyError("WhatsApp inválido. Informe o DDD (ou deixe em branco).");

    const btn = byId("ev-buy-btn");
    btn.dataset.busy = "1";
    btn.disabled = true;
    byId("ev-buy-label").textContent = "Reservando sua vaga...";

    try {
        if (!(await FZ.isEmailVerified())) {
            FZ.openVerifyModal();
            return;
        }
        const res = await FZ.callWorker("/api/events/checkout", "POST", {
            eventId: entry.id,
            quantity: state.selection.quantity,
            kind: state.selection.kind,
            customer: { name: name, cpf: cpf, matricula: matricula, phone: phone }
        });
        if (!res.ok) {
            setBuyError(res.data && res.data.message ? res.data.message : "Não foi possível reservar agora. Tente de novo.");
            return;
        }
        openPix(res.data);
    } catch (err) {
        console.error("Compra de ingresso:", err);
        setBuyError("Falha de conexão. Verifique sua internet e tente de novo.");
    } finally {
        delete btn.dataset.busy;
        updateEventLive();
    }
}

// ============================================================================
// PIX COM TIMER DE 10 MINUTOS
// ============================================================================
function stopPix(silent) {
    const p = state.pix;
    if (!p) return;
    if (p.timer) clearInterval(p.timer);
    if (p.poll) clearInterval(p.poll);
    if (p.unsub) p.unsub();
    state.pix = null;
    if (silent && !p.done) {
        FZ.showToast("Sua vaga continua reservada até o PIX expirar. Se pagar, o ingresso aparece em Meus ingressos.");
    }
}

function openPix(data) {
    stopPix(false);
    const body = byId("ticket-pix-body");
    if (!body) return;
    const order = data.order || {};
    const expiresAtMs = Number(data.expiresAtMs || Date.now() + 10 * 60 * 1000);
    const qrImg = data.pix && data.pix.qrCodeBase64 ? "data:image/png;base64," + data.pix.qrCodeBase64 : "";

    body.innerHTML =
        '<div id="pix-live" class="space-y-4">' +
            '<div class="flex items-center justify-between text-xs bg-amber-400/10 text-amber-300 px-3 py-2 border border-amber-400/30 font-bold">' +
                '<span class="flex items-center gap-2"><i class="fa-solid fa-spinner fa-spin"></i> Aguardando o pagamento...</span>' +
                '<span id="tpix-timer" class="font-mono text-base">10:00</span>' +
            '</div>' +
            '<div class="ev-bar ev-bar--thin"><span id="tpix-progress" style="width:100%"></span></div>' +
            (qrImg ? '<img src="' + esc(qrImg) + '" alt="QR Code do PIX" class="w-56 h-56 mx-auto p-3 bg-white border-4 border-neon">' : "") +
            '<div><label for="tpix-code" class="fz-label">PIX copia e cola</label>' +
                '<div class="flex gap-2"><input type="text" id="tpix-code" readonly class="fz-input !text-xs font-mono select-all" value="' + esc(data.pix ? data.pix.qrCode : "") + '">' +
                '<button type="button" id="tpix-copy" class="bg-neon text-ink px-4 label font-bold shrink-0 hover:bg-bone transition-colors"><i class="fa-solid fa-copy mr-1"></i> Copiar</button></div></div>' +
            '<div class="border border-ash p-3 text-sm flex justify-between gap-3"><span class="text-smoke min-w-0 break-words">' + esc(order.quantity || 1) + '× ' + esc(order.kind === "combo" ? "Combo festa" : "Ingresso") + ' • ' + esc(order.eventTitle || "") + '</span>' +
                '<span class="font-mono font-semibold text-neon shrink-0">' + money(data.total) + '</span></div>' +
            '<button type="button" id="tpix-check" class="w-full border border-teal-400/60 text-teal-300 hover:bg-teal-400 hover:text-ink py-3 label font-bold transition-colors"><i class="fa-solid fa-rotate mr-1"></i> Já paguei! Verificar agora</button>' +
            '<p class="text-xs text-smoke text-center">Sua vaga fica travada por 10 minutos. Depois disso ela volta para o lote.</p>' +
        '</div>';

    const p = { orderId: data.orderId, expiresAtMs: expiresAtMs, done: false, expiredShown: false, timer: null, poll: null, unsub: null };
    state.pix = p;

    const tick = function () {
        const left = Math.max(0, p.expiresAtMs - Date.now());
        const timerEl = byId("tpix-timer");
        const bar = byId("tpix-progress");
        if (timerEl) timerEl.textContent = pad2(Math.floor(left / 60000)) + ":" + pad2(Math.floor((left % 60000) / 1000));
        if (bar) bar.style.width = Math.max(0, Math.min(100, (left / (10 * 60 * 1000)) * 100)) + "%";
        if (left <= 0 && !p.done && !p.expiredShown) {
            p.expiredShown = true;
            checkTicketOrder(true);
            renderPixResult("expired");
        }
    };
    tick();
    p.timer = setInterval(tick, 1000);

    // Tempo real: o Worker marca o pedido como pago quando o webhook chega
    try {
        p.unsub = onSnapshot(doc(FZ.db, "artifacts", FZ.appId, "public", "data", "ticketOrders", data.orderId), function (snap) {
            if (snap.exists()) handleOrderStatus(snap.data().status);
        }, function (err) { console.warn("Pedido de ingresso:", err && err.code ? err.code : err); });
    } catch (e) { console.warn(e); }

    // Rede de seguranca: pede ao Worker para conferir no Mercado Pago
    p.poll = setInterval(function () { checkTicketOrder(true); }, 10000);

    openOverlay("ticket-pix-modal");
}

async function checkTicketOrder(silent) {
    const p = state.pix;
    if (!p) return;
    try {
        const res = await FZ.callWorker("/api/events/orders/" + encodeURIComponent(p.orderId), "GET");
        if (res.ok && res.data) {
            handleOrderStatus(res.data.status);
            if (!silent && res.data.status === "reserved") FZ.showToast("Ainda não recebemos o pagamento. Assim que cair, esta tela atualiza sozinha.");
        } else if (!silent) {
            FZ.showToast(res.data && res.data.message ? res.data.message : "Não foi possível verificar agora.", "error");
        }
    } catch (e) {
        if (!silent) FZ.showToast("Falha de conexão ao verificar o pagamento.", "error");
    }
}

function handleOrderStatus(status) {
    const p = state.pix;
    if (!p || p.done) return;
    if (status === "paid") {
        p.done = true;
        renderPixResult("paid");
    } else if (status === "review") {
        p.done = true;
        renderPixResult("review");
    } else if (status === "expired" || status === "cancelled") {
        if (!p.expiredShown) {
            p.expiredShown = true;
            renderPixResult("expired");
        }
    }
}

function renderPixResult(kind) {
    const body = byId("ticket-pix-body");
    const p = state.pix;
    if (!body || !p) return;
    if (kind !== "expired") {
        if (p.timer) clearInterval(p.timer);
        if (p.poll) clearInterval(p.poll);
    }
    const box = function (icon, tone, title, text, btnId, btnLabel) {
        return '<div class="text-center space-y-4 py-4">' +
            '<div class="w-16 h-16 ' + tone + ' flex items-center justify-center text-3xl mx-auto"><i class="fa-solid ' + icon + '"></i></div>' +
            '<h3 class="font-sport font-black uppercase text-4xl leading-none">' + title + '</h3>' +
            '<p class="text-sm text-bone/80 leading-relaxed">' + text + '</p>' +
            '<button type="button" id="' + btnId + '" class="btn-razor btn-razor--solid w-full !text-base"><span>' + btnLabel + '</span><span class="arrow">→</span></button>' +
        '</div>';
    };
    if (kind === "paid") {
        body.innerHTML = box("fa-check", "bg-neon text-ink", 'Ingresso <span class="text-neon">garantido</span>',
            "Pagamento confirmado. Seu QR Code já está na sua conta, em Meus ingressos.", "tpix-wallet", "Ver meus ingressos");
    } else if (kind === "review") {
        body.innerHTML = box("fa-magnifying-glass", "bg-amber-400 text-ink", "Pagamento em análise",
            "Recebemos um valor diferente do esperado. A diretoria vai conferir e falar com você.", "tpix-close", "Entendi");
    } else {
        body.innerHTML = box("fa-hourglass-end", "bg-ash text-bone", "O tempo acabou",
            "O PIX expirou e a vaga voltou para o lote. Se você pagou no último instante, o ingresso aparece em Meus ingressos em alguns minutos.", "tpix-close", "Tentar de novo");
    }
}

// ============================================================================
// CARTEIRA: MEUS INGRESSOS
// ============================================================================
function ticketsCollection() {
    return collection(FZ.db, "artifacts", FZ.appId, "public", "data", "tickets");
}

async function onAuthChanged() {
    if (state.unsubTickets) { state.unsubTickets(); state.unsubTickets = null; }
    state.tickets = [];
    state.ticketsReady = false;
    state.isMember = false;
    state.offerCodes.clear();
    const user = FZ.user;

    if (user && FZ.db) {
        state.unsubTickets = onSnapshot(query(ticketsCollection(), where("ownerUid", "==", user.uid)), function (snap) {
            const list = [];
            snap.forEach(function (d) { list.push(Object.assign({ id: d.id }, d.data())); });
            state.tickets = list;
            state.ticketsReady = true;
            renderWallet();
            if (state.openTicketId) renderTicketModal();
        }, function (err) {
            console.warn("Ingressos:", err && err.code ? err.code : err);
            state.ticketsReady = true;
            renderWallet();
        });
        try {
            const m = await getDoc(doc(FZ.db, "artifacts", FZ.appId, "members", user.uid));
            state.isMember = m.exists();
        } catch (e) { state.isMember = false; }
    } else {
        closeOverlay("ticket-modal");
        renderWallet();
    }

    renderEventsGrid();
    if (state.openEventId) updateEventLive();
    maybeOpenTransferAccept();
}

function walletTickets() {
    return state.tickets
        .filter(function (t) { return t.status === "valid" || t.status === "used"; })
        .sort(function (a, b) {
            if (a.status !== b.status) return a.status === "valid" ? -1 : 1;
            const da = toDate(a.eventStartsAt), db = toDate(b.eventStartsAt);
            return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
        });
}

function renderWallet() {
    const panel = byId("profile-tickets-panel");
    if (!panel) return;
    if (!FZ.user) { panel.innerHTML = ""; return; }
    if (!state.ticketsReady) {
        panel.innerHTML = '<p class="label text-smoke text-center py-8"><i class="fa-solid fa-spinner fa-spin mr-1"></i> Carregando ingressos...</p>';
        return;
    }
    const list = walletTickets();
    if (list.length === 0) {
        panel.innerHTML = '<div class="text-center py-10 space-y-3 border border-dashed border-ash">' +
            '<i class="fa-solid fa-ticket text-4xl text-smoke"></i>' +
            '<p class="font-sport font-black uppercase text-2xl">Sua carteira está vazia</p>' +
            '<p class="text-sm text-smoke max-w-xs mx-auto">Quando você comprar ou receber um ingresso, o QR Code aparece aqui.</p></div>';
        return;
    }
    panel.innerHTML = list.map(function (t) {
        const d = dateParts(toDate(t.eventStartsAt));
        const used = t.status === "used";
        const pendingOffer = Number(t.transferDeadlineMs || 0) > Date.now();
        return '<button type="button" data-ticket-open="' + esc(t.id) + '" class="w-full text-left flex items-stretch border ' + (used ? "border-ash opacity-60" : "border-ash hover:border-neon/60") + ' bg-ink/40 transition-colors group">' +
            '<span class="' + (used ? "bg-ash text-bone" : "bg-neon text-ink") + ' px-3 py-3 text-center flex flex-col justify-center shrink-0 w-[4.5rem]">' +
                '<span class="label font-bold block">' + esc(d.weekday) + '</span><span class="font-sport font-black text-3xl leading-none block">' + esc(d.day) + '</span><span class="label font-bold block">' + esc(d.month) + '</span></span>' +
            '<span class="flex-1 min-w-0 p-3 border-l border-dashed border-ash flex flex-col gap-1">' +
                '<span class="label ' + (used ? "text-smoke" : "text-neon") + '">' + (used ? "Utilizado" : "Válido") + ' • ' + esc(t.batchName || "Ingresso") + (t.isCombo ? " • Combo" : "") + (t.courtesy ? " • Cortesia" : "") + '</span>' +
                '<span class="font-sport font-black uppercase text-2xl leading-none truncate">' + esc(t.eventTitle || "Evento") + '</span>' +
                '<span class="text-xs text-smoke truncate">' + esc(t.ownerName || "") + (pendingOffer ? " • link de transferência ativo" : "") + '</span></span>' +
            '<span class="px-4 flex items-center text-neon shrink-0"><i class="fa-solid fa-qrcode text-2xl group-hover:scale-110 transition-transform"></i></span>' +
        '</button>';
    }).join("");
}

function currentTicket() {
    return state.tickets.find(function (t) { return t.id === state.openTicketId; }) || null;
}

function openTicket(ticketId) {
    state.openTicketId = ticketId;
    state.ticketView = "entrada";
    renderTicketModal();
    openOverlay("ticket-modal");
}

// QR em alta resolucao (>= 720 px) com margem branca
async function drawQr(canvas, text) {
    await loadLib("qrcode");
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 4;
    const scale = Math.max(4, Math.ceil(720 / (count + quiet * 2)));
    const size = (count + quiet * 2) * scale;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000000";
    for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
            if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
    }
}

function transferLink(code) {
    return window.location.origin + "/#transferir=" + code;
}

function renderTicketModal() {
    const body = byId("ticket-modal-body");
    const t = currentTicket();
    if (!body) return;
    if (!t || (t.status !== "valid" && t.status !== "used")) {
        closeOverlay("ticket-modal");
        return;
    }
    const d = dateParts(toDate(t.eventStartsAt));
    const used = t.status === "used";
    const isKit = state.ticketView === "kit" && t.isCombo && t.kitSignature;
    const token = isKit ? t.kitSignature : t.qrSignature;
    const checkedIn = toDate(t.checkedInAt);
    const kitDone = t.comboRedeemed === true;
    const offerCode = state.offerCodes.get(t.id);
    const offerActive = Number(t.transferDeadlineMs || 0) > Date.now();
    const deadline = offerActive ? new Date(Number(t.transferDeadlineMs)) : null;
    const dimmed = isKit ? kitDone : used;

    let statusLine;
    if (isKit) statusLine = kitDone ? "Kit já retirado" : "Mostre este QR no estande para retirar: " + esc((t.comboItems || []).join(" + "));
    else if (used) statusLine = "Entrada registrada" + (checkedIn ? " em " + pad2(checkedIn.getDate()) + "/" + pad2(checkedIn.getMonth() + 1) + " às " + pad2(checkedIn.getHours()) + "h" + pad2(checkedIn.getMinutes()) : "");
    else statusLine = "Mostre este QR na portaria. Aumente o brilho da tela.";

    let transferHtml = "";
    if (!used) {
        if (offerCode && offerActive) {
            transferHtml =
                '<p class="text-xs text-smoke">Envie este link para quem vai ficar com o ingresso. Vale até ' + pad2(deadline.getDate()) + "/" + pad2(deadline.getMonth() + 1) + " às " + pad2(deadline.getHours()) + "h" + pad2(deadline.getMinutes()) + '. Enquanto ninguém aceitar, o ingresso continua seu.</p>' +
                '<div class="flex gap-2"><input type="text" readonly id="tk-link" class="fz-input !text-xs font-mono select-all" value="' + esc(transferLink(offerCode)) + '">' +
                '<button type="button" data-tk-action="copy-link" class="bg-neon text-ink px-4 label font-bold shrink-0 hover:bg-bone transition-colors"><i class="fa-solid fa-copy"></i></button></div>' +
                '<div class="grid grid-cols-2 gap-2">' +
                    '<a href="https://wa.me/?text=' + encodeURIComponent("Seu ingresso para " + (t.eventTitle || "o evento") + ": " + transferLink(offerCode)) + '" target="_blank" rel="noopener noreferrer" class="border border-ash text-bone hover:border-neon hover:text-neon py-2 label font-bold text-center transition-colors"><i class="fa-brands fa-whatsapp mr-1"></i> WhatsApp</a>' +
                    '<button type="button" data-tk-action="cancel-offer" class="border border-ash text-smoke hover:border-red-400 hover:text-red-300 py-2 label font-bold transition-colors">Cancelar link</button>' +
                '</div>';
        } else if (offerActive) {
            transferHtml =
                '<p class="text-xs text-smoke">Já existe um link de transferência ativo para este ingresso. Por segurança ele só aparece no momento em que é criado.</p>' +
                '<div class="grid grid-cols-2 gap-2">' +
                    '<button type="button" data-tk-action="offer" class="border border-neon/60 text-neon hover:bg-neon hover:text-ink py-2 label font-bold transition-colors">Gerar novo link</button>' +
                    '<button type="button" data-tk-action="cancel-offer" class="border border-ash text-smoke hover:border-red-400 hover:text-red-300 py-2 label font-bold transition-colors">Cancelar link</button>' +
                '</div>';
        } else {
            transferHtml =
                '<p class="text-xs text-smoke">Não vai mais? Gere um link e envie para outra pessoa. Quando ela aceitar, o ingresso passa para o nome dela e este QR deixa de valer.</p>' +
                '<button type="button" data-tk-action="offer" class="w-full border border-neon/60 text-neon hover:bg-neon hover:text-ink py-2.5 label font-bold transition-colors"><i class="fa-solid fa-right-left mr-1"></i> Transferir ingresso</button>';
        }
        transferHtml = '<div class="border-t border-dashed border-ash pt-4 space-y-3"><span class="fz-label !mb-0">Transferência de titularidade</span>' + transferHtml + '</div>';
    }

    body.innerHTML =
        '<div class="px-6 py-5 flex justify-between items-start gap-3 border-b border-ash">' +
            '<div class="min-w-0"><span class="label ' + (used ? "text-smoke" : "text-neon") + '">' + (used ? "Utilizado" : "Ingresso válido") + ' • ' + esc(t.batchName || "") + '</span>' +
                '<h2 class="font-sport text-4xl font-black uppercase leading-[0.9] mt-1 break-words">' + esc(t.eventTitle || "Evento") + '</h2>' +
                '<p class="label text-smoke mt-2 normal-case tracking-normal">' + esc(d.full) + '</p></div>' +
            '<button type="button" data-ev-close="ticket-modal" aria-label="Fechar" class="fz-close shrink-0"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
        (t.isCombo && t.kitSignature
            ? '<div class="flex"><button type="button" data-tk-view="entrada" class="seg-tab' + (!isKit ? " is-active" : "") + '"><i class="fa-solid fa-door-open mr-1"></i> Entrada</button>' +
              '<button type="button" data-tk-view="kit" class="seg-tab' + (isKit ? " is-active" : "") + '"><i class="fa-solid fa-gift mr-1"></i> Retirada do kit</button></div>'
            : "") +
        '<div class="p-6 space-y-4">' +
            '<div class="bg-white p-2 mx-auto w-full max-w-[300px] border-4 ' + (dimmed ? "border-ash" : "border-neon") + '">' +
                '<canvas id="tk-qr" class="ev-qr' + (dimmed ? " opacity-30" : "") + '" aria-label="QR Code do ingresso"></canvas></div>' +
            '<p class="text-sm text-center ' + (dimmed ? "text-smoke" : "text-bone") + '">' + statusLine + '</p>' +
            '<dl class="grid grid-cols-2 gap-3 text-sm border border-ash p-3">' +
                '<div class="col-span-2"><dt class="fz-label !mb-0">Titular</dt><dd class="font-semibold break-words">' + esc(t.ownerName || "") + '</dd></div>' +
                '<div><dt class="fz-label !mb-0">CPF</dt><dd class="font-mono">' + esc(t.ownerCpf || "—") + '</dd></div>' +
                '<div><dt class="fz-label !mb-0">Ingresso</dt><dd class="font-mono">#' + esc(String(t.id).slice(0, 8).toUpperCase()) + '</dd></div>' +
            '</dl>' +
            '<button type="button" data-tk-action="pdf" class="w-full border border-ash text-bone hover:border-neon hover:text-neon py-2.5 label font-bold transition-colors"><i class="fa-solid fa-file-pdf mr-1"></i> Baixar em PDF</button>' +
            transferHtml +
        '</div>';

    const canvas = byId("tk-qr");
    if (canvas && token) {
        drawQr(canvas, token).catch(function () {
            FZ.showToast("Não foi possível desenhar o QR Code. Verifique sua internet.", "error");
        });
    }
}

async function ticketAction(action, btn) {
    const t = currentTicket();
    if (!t) return;

    if (action === "copy-link") {
        const code = state.offerCodes.get(t.id);
        if (code) copyText(transferLink(code), "Link de transferência copiado!");
        return;
    }
    if (action === "pdf") {
        btn.disabled = true;
        try { await exportTicketPdf(t); }
        catch (e) { console.error(e); FZ.showToast("Não foi possível gerar o PDF agora.", "error"); }
        finally { btn.disabled = false; }
        return;
    }
    if (action === "offer" || action === "cancel-offer") {
        btn.disabled = true;
        try {
            const res = await FZ.callWorker("/api/tickets/transfer", "POST", {
                action: action === "offer" ? "offer" : "cancel",
                ticketId: t.id
            });
            if (!res.ok) {
                FZ.showToast(res.data && res.data.message ? res.data.message : "Não foi possível concluir agora.", "error");
                return;
            }
            if (action === "offer") {
                state.offerCodes.set(t.id, res.data.code);
                // Mostra o link ja, sem esperar o Firestore avisar
                t.transferDeadlineMs = res.data.expiresAtMs;
                FZ.showToast("Link de transferência criado.");
            } else {
                state.offerCodes.delete(t.id);
                t.transferDeadlineMs = 0;
                FZ.showToast("Link de transferência cancelado.");
            }
            renderTicketModal();
            renderWallet();
        } catch (e) {
            FZ.showToast("Falha de conexão. Tente de novo.", "error");
        } finally {
            btn.disabled = false;
        }
    }
}

// ----------------------------------------------------------------------------
// PDF do ingresso (uma pagina por QR: entrada e, no combo, retirada do kit)
// ----------------------------------------------------------------------------
async function exportTicketPdf(t) {
    await Promise.all([loadLib("jspdf"), loadLib("qrcode")]);
    const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a5", orientation: "portrait" });
    const W = 148, H = 210;
    const d = dateParts(toDate(t.eventStartsAt));

    const page = async function (title, token, hint) {
        pdf.setFillColor(5, 11, 7);
        pdf.rect(0, 0, W, H, "F");
        pdf.setFillColor(204, 255, 0);
        pdf.rect(0, 0, W, 26, "F");
        pdf.setTextColor(5, 11, 7);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9);
        pdf.text("ATLÉTICA FURIOZOS • BILHETERIA OFICIAL", 10, 10);
        pdf.setFontSize(18);
        pdf.text(title, 10, 20);

        pdf.setTextColor(238, 241, 230);
        pdf.setFontSize(22);
        const titleLines = pdf.splitTextToSize(String(t.eventTitle || "Evento").toUpperCase(), W - 20);
        pdf.text(titleLines.slice(0, 2), 10, 40);
        let y = 40 + Math.min(2, titleLines.length) * 9;
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(11);
        pdf.setTextColor(204, 255, 0);
        pdf.text(d.full, 10, y);

        const canvas = document.createElement("canvas");
        await drawQr(canvas, token);
        const qrSize = 92;
        const qx = (W - qrSize) / 2;
        const qy = y + 8;
        pdf.setFillColor(255, 255, 255);
        pdf.rect(qx - 3, qy - 3, qrSize + 6, qrSize + 6, "F");
        pdf.addImage(canvas.toDataURL("image/png"), "PNG", qx, qy, qrSize, qrSize);

        y = qy + qrSize + 14;
        pdf.setTextColor(140, 154, 143);
        pdf.setFontSize(8);
        pdf.text("TITULAR", 10, y);
        pdf.text("CPF", 90, y);
        pdf.setTextColor(238, 241, 230);
        pdf.setFontSize(12);
        pdf.setFont("helvetica", "bold");
        pdf.text(pdf.splitTextToSize(String(t.ownerName || ""), 76).slice(0, 2), 10, y + 6);
        pdf.text(String(t.ownerCpf || "—"), 90, y + 6);

        y += 20;
        pdf.setFont("helvetica", "normal");
        pdf.setTextColor(140, 154, 143);
        pdf.setFontSize(8);
        pdf.text("LOTE", 10, y);
        pdf.text("INGRESSO", 90, y);
        pdf.setTextColor(238, 241, 230);
        pdf.setFontSize(12);
        pdf.text(String(t.batchName || "—") + (t.isCombo ? " • Combo" : ""), 10, y + 6);
        pdf.text("#" + String(t.id).slice(0, 8).toUpperCase(), 90, y + 6);

        pdf.setTextColor(140, 154, 143);
        pdf.setFontSize(8);
        pdf.text(pdf.splitTextToSize(hint, W - 20), 10, H - 16);
    };

    await page("ENTRADA", t.qrSignature, "Apresente este QR Code na portaria. Cada ingresso libera uma única entrada. Se o ingresso for transferido, este PDF deixa de valer.");
    if (t.isCombo && t.kitSignature) {
        pdf.addPage("a5", "portrait");
        await page("RETIRADA DO KIT", t.kitSignature, "Apresente este QR Code no estande para retirar: " + (t.comboItems || []).join(" + ") + ".");
    }
    const slug = String(t.eventId || "evento").replace(/[^a-z0-9-]/gi, "");
    pdf.save("ingresso-" + slug + "-" + String(t.id).slice(0, 8) + ".pdf");
}

// ============================================================================
// RECEBER INGRESSO TRANSFERIDO (link /#transferir=CODIGO)
// ============================================================================
function captureTransferCode() {
    const m = String(window.location.hash || "").match(/^#transferir=([0-9a-f-]{36}\.[A-Za-z0-9_-]{16,64})$/);
    if (!m) return;
    try { sessionStorage.setItem(PENDING_TRANSFER_KEY, m[1]); } catch (e) { /* segue so em memoria */ }
    state.pendingTransfer = m[1];
    try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch (e) { /* ok */ }
}

function pendingTransferCode() {
    if (state.pendingTransfer) return state.pendingTransfer;
    try { return sessionStorage.getItem(PENDING_TRANSFER_KEY) || ""; } catch (e) { return ""; }
}

function clearPendingTransfer() {
    state.pendingTransfer = "";
    try { sessionStorage.removeItem(PENDING_TRANSFER_KEY); } catch (e) { /* ok */ }
}

function maybeOpenTransferAccept() {
    const code = pendingTransferCode();
    if (!code) return;
    if (!FZ.user) {
        if (!state.transferLoginAsked) {
            state.transferLoginAsked = true;
            FZ.showToast("Entre ou crie sua conta para receber o ingresso.");
            FZ.openAuthModal();
        }
        return;
    }
    const profile = FZ.profile || {};
    byId("transfer-name").value = profile.name || FZ.user.displayName || "";
    byId("transfer-matricula").value = profile.matricula || "";
    byId("transfer-accept-error").classList.add("hidden");
    openOverlay("transfer-accept-modal");
}

async function submitTransferAccept(e) {
    e.preventDefault();
    const code = pendingTransferCode();
    const errEl = byId("transfer-accept-error");
    const fail = function (msg) { errEl.textContent = msg; errEl.classList.remove("hidden"); };
    errEl.classList.add("hidden");

    const name = byId("transfer-name").value.trim();
    const cpf = byId("transfer-cpf").value.replace(/\D/g, "");
    const matricula = byId("transfer-matricula").value.replace(/\D/g, "");
    if (name.length < 3) return fail("Informe seu nome completo.");
    if (!FZ.isValidCpf(cpf)) return fail("CPF inválido. Confira os números.");
    if (matricula && matricula.length !== 12) return fail("A matrícula UERJ tem 12 números (ou deixe em branco).");

    const btn = byId("btn-transfer-accept");
    btn.disabled = true;
    try {
        if (!(await FZ.isEmailVerified())) {
            FZ.openVerifyModal();
            return;
        }
        const res = await FZ.callWorker("/api/tickets/transfer", "POST", {
            action: "accept",
            code: code,
            customer: { name: name, cpf: cpf, matricula: matricula }
        });
        if (!res.ok) {
            fail(res.data && res.data.message ? res.data.message : "Não foi possível receber o ingresso agora.");
            if (res.status === 400) clearPendingTransfer();
            return;
        }
        clearPendingTransfer();
        closeOverlay("transfer-accept-modal");
        FZ.showToast("Ingresso recebido! Ele já está em Meus ingressos.");
        FZ.openProfileTab("ingressos");
    } catch (err) {
        fail("Falha de conexão. Tente de novo.");
    } finally {
        btn.disabled = false;
    }
}

// ============================================================================
// EVENTOS DE TELA
// ============================================================================
function bindEvents() {
    document.addEventListener("click", function (e) {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;

        const closer = target.closest("[data-ev-close]");
        if (closer) { closeOverlay(closer.getAttribute("data-ev-close")); return; }

        // Clique no fundo escuro fecha o modal
        if (target.classList.contains("ev-overlay")) { closeOverlay(target.id); return; }

        const opener = target.closest("[data-ev-open]");
        if (opener) { openEvent(opener.getAttribute("data-ev-open")); return; }

        const kindBtn = target.closest("[data-ev-kind]");
        if (kindBtn) { state.selection.kind = kindBtn.getAttribute("data-ev-kind"); updateEventLive(); return; }

        const qtyBtn = target.closest("[data-ev-qty]");
        if (qtyBtn) {
            const entry = state.events.get(state.openEventId);
            const left = entry ? saleInfo(entry).left : 1;
            const max = Math.max(1, Math.min(MAX_TICKETS_PER_ORDER, left));
            state.selection.quantity = Math.max(1, Math.min(max, state.selection.quantity + Number(qtyBtn.getAttribute("data-ev-qty"))));
            updateEventLive();
            return;
        }

        if (target.closest("#ev-share")) {
            copyText(window.location.origin + "/?evento=" + encodeURIComponent(state.openEventId || ""), "Link do evento copiado!");
            return;
        }
        if (target.closest("#tpix-copy")) { copyText(byId("tpix-code").value, "Código PIX copiado!"); return; }
        if (target.closest("#tpix-check")) { checkTicketOrder(false); return; }
        if (target.closest("#tpix-close")) { closeOverlay("ticket-pix-modal"); return; }
        if (target.closest("#tpix-wallet")) {
            closeOverlay("ticket-pix-modal");
            closeOverlay("event-modal");
            FZ.openProfileTab("ingressos");
            return;
        }

        const ticketBtn = target.closest("[data-ticket-open]");
        if (ticketBtn) { openTicket(ticketBtn.getAttribute("data-ticket-open")); return; }

        const viewBtn = target.closest("[data-tk-view]");
        if (viewBtn) { state.ticketView = viewBtn.getAttribute("data-tk-view"); renderTicketModal(); return; }

        const actionBtn = target.closest("[data-tk-action]");
        if (actionBtn) { ticketAction(actionBtn.getAttribute("data-tk-action"), actionBtn); return; }
    });

    document.addEventListener("submit", function (e) {
        if (e.target && e.target.id === "ev-buy-form") {
            e.preventDefault();
            submitPurchase();
        }
    });

    document.addEventListener("input", function (e) {
        const el = e.target;
        if (!el || !el.id) return;
        if (el.id === "ev-cpf" || el.id === "transfer-cpf") el.value = FZ.maskCPF(el.value);
        else if (el.id === "ev-matricula" || el.id === "transfer-matricula") el.value = FZ.maskMatricula(el.value);
        else if (el.id === "ev-phone") el.value = FZ.maskPhone(el.value);
    });

    document.addEventListener("keydown", function (e) {
        if (e.key !== "Escape") return;
        const order = ["ticket-modal", "transfer-accept-modal", "ticket-pix-modal", "event-modal"];
        for (let i = 0; i < order.length; i++) {
            const el = byId(order[i]);
            if (el && !el.classList.contains("hidden")) { closeOverlay(order[i]); break; }
        }
    });

    const acceptForm = byId("transfer-accept-form");
    if (acceptForm) acceptForm.addEventListener("submit", submitTransferAccept);

    document.addEventListener("fz:auth", onAuthChanged);
    document.addEventListener("fz:wallet-open", renderWallet);
}

if (FZ && FZ.db) {
    captureTransferCode();
    bindEvents();
    startEventsListener();
    onAuthChanged();
    // Vira "evento encerrado" sem precisar recarregar a pagina
    setInterval(renderEventsGrid, 60 * 1000);
    // So no ambiente local: permite simular dados para testar as telas
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
        window.__fzEventosDebug = {
            state: state, renderEventsGrid: renderEventsGrid, openEvent: openEvent, openPix: openPix,
            handleOrderStatus: handleOrderStatus, renderWallet: renderWallet, openTicket: openTicket,
            exportTicketPdf: exportTicketPdf
        };
    }
} else {
    console.warn("Bilheteria: a loja não inicializou, eventos indisponíveis.");
}
