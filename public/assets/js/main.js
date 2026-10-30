// public/assets/js/main.js
// Versao 2 (seguranca): pagamentos e pedidos passam a ser processados pelo
// Cloudflare Worker. O navegador nunca define precos nem status "pago".
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    updateProfile,
    updatePassword,
    sendPasswordResetEmail,
    sendEmailVerification
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    getDocs,
    collection,
    query,
    where,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import Swiper from "https://cdn.jsdelivr.net/npm/swiper@11.2.10/swiper-bundle.min.mjs";

// ============================================================================
// 1. CONFIGURACOES DO FIREBASE E MERCADO PAGO (VIA CLOUDFLARE WORKER)
// ============================================================================
const appId = "furiozos-app";
const CURRENCY_PREFIX = "R\x24 ";

// A configuracao web do Firebase e publica por natureza. A protecao real
// esta nas regras do Firestore e nas restricoes da chave no Google Cloud.
const firebaseConfig = {
    apiKey: "AIzaSyDq8DjGLsN_yLlTP2brfyhfLgU23ROP38M",
    authDomain: "atletica-furiozos.firebaseapp.com",
    projectId: "atletica-furiozos",
    storageBucket: "atletica-furiozos.firebasestorage.app",
    messagingSenderId: "968429095494",
    appId: "1:968429095494:web:16c2514234a7a2ac4bd847",
    measurementId: "G-P39HJJCQLN"
};

// Os administradores agora ficam na colecao artifacts/furiozos-app/admins
// (documento com o UID de cada admin). Nada de lista de e-mails no codigo.

// Usado APENAS para exibir valores. O Worker recalcula tudo no servidor.
const PRICING_RULES = {
    CUSTOM_NAME_FEE: 5.00,
    CUSTOM_NUMBER_FEE: 5.00,
    IMMEDIATE_DELIVERY_FEE: 10.00,
    BATCH_MIN_GOAL: 20
};

const INSTALLMENT_RATES = {
    1: 0.0498,
    2: 0.0750,
    3: 0.0920,
    4: 0.1080,
    5: 0.1230,
    6: 0.1380,
    7: 0.1550,
    8: 0.1700,
    9: 0.1850,
    10: 0.2000,
    11: 0.2150,
    12: 0.2300
};

const MERCADO_PAGO_CONFIG = {
    workerUrl: "https://furiozos-pagamento.bblackgamerbr.workers.dev",
    publicKey: "APP_USR-a170c9dc-cc2d-476b-a20b-df9d0dc4a747",
    atleticaWhatsapp: "5521978251441",
    atleticaEmail: "atleticafuriozos@gmail.com"
};

const ORDER_STATUS = {
    PENDING: "Aguardando pagamento",
    REVIEW: "Em análise",
    PAID: "Pago / Confirmado",
    REJECTED: "Pagamento recusado",
    CANCELLED: "Cancelado",
    REFUNDED: "Estornado"
};

const MAX_QTY_PER_ITEM = 10;
const CUSTOM_NAME_ALLOWED = /[^A-Z0-9ÀÁÂÃÄÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ .'-]/g;
const PRODUCT_STATUSES = ["disponivel", "em_breve", "esgotado"];

let app = null;
let db = null;
let auth = null;
let mpInstance = null;

try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
    auth.languageCode = "pt-BR"; // e-mails do Firebase (verificacao, senha) em portugues
} catch (err) {
    console.error("Erro ao inicializar Firebase:", err);
}

try {
    if (typeof window.MercadoPago !== "undefined") {
        mpInstance = new window.MercadoPago(MERCADO_PAGO_CONFIG.publicKey, { locale: "pt-BR" });
    }
} catch (err) {
    console.warn("SDK Mercado Pago:", err);
}

// ============================================================================
// 2. CATALOGO INICIAL E ESTADO DA APLICACAO
// ============================================================================
const DEFAULT_PRODUCTS = [
    {
        id: "p1",
        name: "Caneca FurioZOs",
        price: 45.00,
        images: ["assets/img/caneca.jpg"],
        hasSize: false,
        isShirt: false,
        status: "em_breve",
        immediateStock: 0,
        desc: "Caneca oficial da atlética, 500ml de pura energia da ZO. Perfeita para as choppadas."
    },
    {
        id: "p2",
        name: "Camisa Especial Limitada",
        price: 120.00,
        images: [
            "assets/img/camisa-diretoria-frente.jpg",
            "assets/img/camisa-diretoria-costas.jpg",
            "assets/img/camisa-diretoria-manga.jpg",
            "assets/img/camisa-diretoria-escudo.jpg"
        ],
        hasSize: true,
        isShirt: true,
        status: "disponivel",
        immediateStock: 0,
        desc: "Edição limitada Sapo Bombado. Tecido premium dry-fit, detalhes em dourado e verde oliva. Personalize com seu nome e número!"
    },
    {
        id: "p3",
        name: "Camisa de Jogo",
        price: 85.00,
        images: ["assets/img/camisa-jogo.jpg"],
        hasSize: true,
        isShirt: true,
        status: "em_breve",
        immediateStock: 0,
        desc: "Camisa oficial para atletas e guerreiros. Material leve, ideal para a prática esportiva."
    },
    {
        id: "p4",
        name: "Camisa de Torcida",
        price: 70.00,
        images: ["assets/img/camisa-torcida.jpg"],
        hasSize: true,
        isShirt: true,
        status: "em_breve",
        immediateStock: 0,
        desc: "Mostre seu apoio nas arquibancadas! Malha 100% algodão, confortável e com estampa exclusiva."
    },
    {
        id: "p5",
        name: "Bandana FurioZOs",
        price: 25.00,
        images: [
            "assets/img/bandana-frente.jpg",
            "assets/img/bandana-costas.jpg"
        ],
        hasSize: false,
        isShirt: false,
        status: "em_breve",
        immediateStock: 0,
        desc: "Acessório indispensável. Use na cabeça, no pescoço ou amarrada na mochila. Estilo puramente ZO."
    }
];

let productsCatalog = DEFAULT_PRODUCTS.slice();
let ordersList = [];
let currentUser = null;
let isAdminUser = false;
let userProfile = { name: "", matricula: "", cpf: "", phone: "" };
let cart = [];
let modalSwiperInstance = null;

let selectedProduct = null;
let selectedSize = null;
let selectedDeliveryMode = "lote";
let selectedPaymentMethod = "pix";
let activeOrderId = null;
let pixPollingInterval = null;
let authMode = "login";
const confirmedOrderIds = new Set();

// ============================================================================
// 3. UTILITARIOS E HELPERS DE DOM SEGUROS
// ============================================================================
function byId(id) {
    return document.getElementById(id);
}

function on(id, eventName, handler) {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener(eventName, handler);
    }
}

// Escapa qualquer texto antes de entrar em innerHTML (previne XSS)
function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"'`]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;", "`": "&#96;" }[c];
    });
}

function formatPrice(price) {
    const num = Number(price ? price : 0);
    return CURRENCY_PREFIX + num.toFixed(2).replace(".", ",");
}

function showToast(message, type) {
    const container = byId("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    const isErr = type === "error";
    toast.className = "toast" + (isErr ? " !bg-red-600" : "");
    const icon = document.createElement("i");
    icon.className = "fa-solid " + (isErr ? "fa-triangle-exclamation" : "fa-check-circle");
    const span = document.createElement("span");
    span.textContent = String(message);
    toast.appendChild(icon);
    toast.appendChild(document.createTextNode(" "));
    toast.appendChild(span);
    container.appendChild(toast);
    setTimeout(function () {
        toast.remove();
    }, 4000);
}

function isRegisteredUser() {
    return Boolean(currentUser && !currentUser.isAnonymous);
}

function isCurrentUserAdmin() {
    return isRegisteredUser() && isAdminUser;
}

async function refreshAdminFlag() {
    isAdminUser = false;
    if (!db || !isRegisteredUser()) return;
    try {
        const snap = await getDoc(doc(db, "artifacts", appId, "admins", currentUser.uid));
        isAdminUser = snap.exists();
    } catch (err) {
        isAdminUser = false;
    }
}

function findProduct(id) {
    for (let i = 0; i < productsCatalog.length; i++) {
        if (productsCatalog[i].id === id) return productsCatalog[i];
    }
    return null;
}

function statusBadgeClass(status) {
    if (status === ORDER_STATUS.PAID) return "bg-[#ccff00] text-ink";
    if (status === ORDER_STATUS.PENDING || status === ORDER_STATUS.REVIEW) return "bg-amber-400 text-ink";
    return "bg-red-500 text-white";
}

function statusTextClass(status) {
    if (status === ORDER_STATUS.PAID) return "text-green-600";
    if (status === ORDER_STATUS.PENDING || status === ORDER_STATUS.REVIEW) return "text-amber-600";
    return "text-red-600";
}

function isValidCpf(cpf) {
    const c = String(cpf ? cpf : "").replace(/\D/g, "");
    if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
    const checks = [9, 10];
    for (let k = 0; k < checks.length; k++) {
        const t = checks[k];
        let sum = 0;
        for (let i = 0; i < t; i++) sum += Number(c[i]) * (t + 1 - i);
        if (((sum * 10) % 11) % 10 !== Number(c[t])) return false;
    }
    return true;
}

function maskCPF(val) {
    const d = String(val ? val : "").replace(/\D/g, "").slice(0, 11);
    if (d.length <= 3) return d;
    if (d.length <= 6) return d.slice(0, 3) + "." + d.slice(3);
    if (d.length <= 9) return d.slice(0, 3) + "." + d.slice(3, 6) + "." + d.slice(6);
    return d.slice(0, 3) + "." + d.slice(3, 6) + "." + d.slice(6, 9) + "-" + d.slice(9, 11);
}

function maskPhone(val) {
    const d = String(val ? val : "").replace(/\D/g, "").slice(0, 11);
    if (d.length <= 2) return d;
    if (d.length <= 7) return "(" + d.slice(0, 2) + ") " + d.slice(2);
    return "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7);
}

function maskMatricula(val) {
    return String(val ? val : "").replace(/\D/g, "").slice(0, 12);
}

function maskCard(val) {
    const d = String(val ? val : "").replace(/\D/g, "").slice(0, 16);
    const parts = [];
    for (let i = 0; i < d.length; i += 4) {
        parts.push(d.slice(i, i + 4));
    }
    return parts.join(" ");
}

function maskExpiry(val) {
    const d = String(val ? val : "").replace(/\D/g, "").slice(0, 4);
    if (d.length <= 2) return d;
    return d.slice(0, 2) + "/" + d.slice(2, 4);
}

// ============================================================================
// 4. RENDERIZACAO DA VITRINE DE PRODUTOS (IMEDIATA)
// ============================================================================
// Ordem da vitrine: disponíveis primeiro; dentro de cada status, a camisa
// especial (p2) e a bandana (p5) vêm na frente. Ids fora da lista vão ao fim.
const SHOWCASE_ORDER = ["p2", "p5", "p3", "p4", "p1"];
const STATUS_ORDER = { disponivel: 0, em_breve: 1, esgotado: 2 };

function sortedCatalog() {
    const rank = function (p) {
        const pos = SHOWCASE_ORDER.indexOf(p.id);
        return pos === -1 ? SHOWCASE_ORDER.length : pos;
    };
    const statusRank = function (p) {
        return STATUS_ORDER[p.status] !== undefined ? STATUS_ORDER[p.status] : 3;
    };
    return productsCatalog.slice().sort(function (a, b) {
        return (statusRank(a) - statusRank(b)) || (rank(a) - rank(b));
    });
}

function renderProducts() {
    const grid = byId("product-grid");
    if (!grid) return;

    const catalog = sortedCatalog();
    const htmlList = [];
    for (let i = 0; i < catalog.length; i++) {
        const p = catalog[i];
        const isAvailable = p.status === "disponivel";
        const isComingSoon = p.status === "em_breve";
        const isSoldOut = p.status === "esgotado";
        const pid = esc(p.id);

        // Selo de disponibilidade no estilo "etiqueta de roupa"
        let statusTag = "";
        if (isAvailable) {
            statusTag = '<span class="label inline-flex items-center gap-2 bg-[#ccff00] text-ink px-2 py-1"><span class="w-1.5 h-1.5 rounded-full bg-ink animate-blink"></span>' + (p.id === "p2" ? "Oficial • 1º Lote" : "Disponível") + '</span>';
        } else if (isComingSoon) {
            statusTag = '<span class="label inline-flex items-center gap-2 border border-bone/40 text-bone px-2 py-1"><i class="fa-solid fa-clock"></i> Em breve</span>';
        } else if (isSoldOut) {
            statusTag = '<span class="label inline-flex items-center gap-2 bg-ash text-smoke px-2 py-1 line-through">Esgotado</span>';
        }

        let priceAreaHTML = "";
        if (isComingSoon) {
            priceAreaHTML = '<span class="font-mono text-xl text-smoke blur-[5px] select-none pointer-events-none">' + CURRENCY_PREFIX + '00,00</span>';
        } else if (isSoldOut) {
            priceAreaHTML = '<span class="font-mono text-xl text-smoke line-through">' + formatPrice(p.price) + '</span>';
        } else {
            priceAreaHTML = '<span class="font-mono font-semibold text-2xl text-[#ccff00] tracking-tight">' + formatPrice(p.price) + '</span>';
        }

        const actionBtnHTML = isAvailable
            ? '<button type="button" data-product-id="' + pid + '" class="bg-[#ccff00] text-ink w-12 h-12 flex items-center justify-center group-hover:bg-bone transition-colors active:scale-95" title="Personalizar e Comprar"><i class="fa-solid fa-arrow-right text-lg group-hover:-rotate-45 transition-transform duration-300"></i></button>'
            : '<button type="button" data-product-id="' + pid + '" class="border border-ash text-smoke w-12 h-12 flex items-center justify-center cursor-not-allowed" title="Indisponível no momento"><i class="fa-solid fa-lock text-base"></i></button>';

        const cardHoverClass = isAvailable ? "hover:bg-soot hover:border-[#ccff00]/50" : "[&>*]:opacity-75";
        const cursorClass = isAvailable ? "cursor-pointer" : "cursor-not-allowed";
        const imgEffectClass = isAvailable ? "group-hover:scale-105" : "grayscale";
        const titleHoverClass = isAvailable ? "cursor-pointer group-hover:text-[#ccff00]" : "";
        const customTagHTML = (p.isShirt && isAvailable)
            ? '<span class="label text-furiozo-light"><i class="fa-solid fa-wand-magic-sparkles mr-1"></i>Personalizável (Nome/Nº)</span>'
            : "";

        const imgUrl = (p.images && p.images.length > 0) ? p.images[0] : "assets/img/logo-atletica.jpg";
        const code = String(i + 1).padStart(3, "0");

        htmlList.push(
            '<div class="reveal bg-coal border border-ash ' + cardHoverClass + ' transition-all duration-700 ease-razor flex flex-col relative group">' +
                '<div class="relative pb-[115%] ' + cursorClass + ' overflow-hidden bg-soot" data-product-id="' + pid + '">' +
                    '<span class="absolute top-3 left-3 z-10 label text-bone mix-blend-difference">' + code + ' / FurioZOs</span>' +
                    '<span class="absolute top-3 right-3 z-10 w-3 h-3 rounded-full border border-bone/50 bg-ink"></span>' +
                    '<img src="' + esc(imgUrl) + '" onerror="this.src=\'https://placehold.co/500x500/1F4229/ccff00?text=FurioZOs\'" alt="' + esc(p.name) + '" class="absolute inset-0 w-full h-full object-cover ' + imgEffectClass + ' transition-transform duration-700">' +
                    '<span class="absolute inset-x-0 bottom-0 h-1 bg-[#ccff00] origin-left scale-x-0 group-hover:scale-x-100 transition-transform duration-500 ease-razor"></span>' +
                '</div>' +
                '<div class="p-5 flex flex-col flex-grow gap-3 border-t border-dashed border-ash">' +
                    '<div>' + statusTag + '</div>' +
                    '<h3 class="font-sport text-2xl text-bone font-black uppercase flex-grow ' + titleHoverClass + ' transition-colors leading-none" data-product-id="' + pid + '">' +
                        esc(p.name) +
                    '</h3>' +
                    customTagHTML +
                    '<div class="flex justify-between items-center mt-2">' +
                        priceAreaHTML +
                        actionBtnHTML +
                    '</div>' +
                '</div>' +
            '</div>'
        );
    }

    grid.innerHTML = htmlList.join("");
}

window.notifyUnavailableProduct = function (status) {
    if (status === "em_breve") {
        showToast("Este produto será liberado em breve pela diretoria!", "error");
    } else {
        showToast("Produto esgotado no momento.", "error");
    }
};

// ============================================================================
// 5. MODAL DE PRODUTO: PERSONALIZACAO E MODALIDADE DE ENTREGA
// ============================================================================
function getCustomizationState() {
    if (!selectedProduct || !selectedProduct.isShirt) {
        return { customName: "", customNumber: "", hasName: false, hasNumber: false, customFee: 0 };
    }
    const nameEl = byId("custom-name-input");
    const numEl = byId("custom-number-input");
    const rawName = nameEl ? nameEl.value : "";
    const rawNum = numEl ? numEl.value : "";

    const customName = rawName.toUpperCase().replace(CUSTOM_NAME_ALLOWED, "").trim().slice(0, 10);
    const customNumber = rawNum.trim().replace(/\D/g, "").slice(0, 2);
    const hasName = customName.length > 0;
    const hasNumber = customNumber.length > 0;

    let customFee = 0;
    if (hasName) customFee += PRICING_RULES.CUSTOM_NAME_FEE;
    if (hasNumber) customFee += PRICING_RULES.CUSTOM_NUMBER_FEE;

    return { customName: customName, customNumber: customNumber, hasName: hasName, hasNumber: hasNumber, customFee: customFee };
}

function sanitizeCustomInputs() {
    const nameEl = byId("custom-name-input");
    const counterEl = byId("custom-name-counter");
    const numEl = byId("custom-number-input");
    if (!nameEl || !numEl) return;

    const cleanName = nameEl.value.toUpperCase().replace(CUSTOM_NAME_ALLOWED, "").slice(0, 10);
    if (nameEl.value !== cleanName) nameEl.value = cleanName;
    if (counterEl) counterEl.textContent = cleanName.trim().length + "/10";

    let rawDigits = numEl.value.replace(/\D/g, "").slice(0, 2);
    if (rawDigits !== "") {
        const numVal = parseInt(rawDigits, 10);
        if (isNaN(numVal) || numVal < 0) rawDigits = "0";
        if (numVal > 99) rawDigits = "99";
    }
    if (numEl.value !== rawDigits) numEl.value = rawDigits;

    evaluateDeliveryAndPrice();
}

function evaluateDeliveryAndPrice() {
    if (!selectedProduct) return;

    const state = getCustomizationState();
    const isCustomized = state.hasName || state.hasNumber;
    const stockVal = selectedProduct.immediateStock ? Number(selectedProduct.immediateStock) : 0;
    const hasImmediateStock = stockVal > 0;

    const btnBatch = byId("btn-delivery-batch");
    const btnImmediate = byId("btn-delivery-immediate");
    const immediateStatusText = byId("immediate-delivery-status");
    const ruleNotice = byId("delivery-rule-notice");

    if (isCustomized || !hasImmediateStock) {
        selectedDeliveryMode = "lote";
        if (btnImmediate) {
            btnImmediate.disabled = true;
            btnImmediate.classList.add("opacity-50", "cursor-not-allowed");
            btnImmediate.classList.remove("is-active");
        }
        if (btnBatch) btnBatch.classList.add("is-active");

        if (isCustomized) {
            if (immediateStatusText) immediateStatusText.textContent = "Indisponível para itens com nome/número.";
            if (ruleNotice) ruleNotice.classList.remove("hidden");
        } else {
            if (immediateStatusText) immediateStatusText.textContent = "Sem estoque a pronta entrega no momento (apenas Lote).";
            if (ruleNotice) ruleNotice.classList.add("hidden");
        }
    } else {
        if (btnImmediate) {
            btnImmediate.disabled = false;
            btnImmediate.classList.remove("opacity-50", "cursor-not-allowed");
        }
        if (immediateStatusText) {
            immediateStatusText.textContent = "Disponível (" + stockVal + " unid. em estoque imediato).";
        }
        if (ruleNotice) ruleNotice.classList.add("hidden");

        const immediateOn = selectedDeliveryMode === "imediata";
        if (btnImmediate) btnImmediate.classList.toggle("is-active", immediateOn);
        if (btnBatch) btnBatch.classList.toggle("is-active", !immediateOn);
    }

    const deliveryFee = selectedDeliveryMode === "imediata" ? PRICING_RULES.IMMEDIATE_DELIVERY_FEE : 0;
    const unitPrice = Number(selectedProduct.price) + state.customFee + deliveryFee;

    const priceEl = byId("modal-product-price");
    const breakdownEl = byId("modal-price-breakdown");

    if (priceEl) priceEl.textContent = formatPrice(unitPrice);

    if (breakdownEl) {
        const extras = [];
        if (state.customFee > 0) extras.push("+" + formatPrice(state.customFee) + " personalização");
        if (deliveryFee > 0) extras.push("+" + formatPrice(deliveryFee) + " pronta entrega");

        if (extras.length > 0) {
            breakdownEl.textContent = extras.join(" • ");
            breakdownEl.classList.remove("hidden");
        } else {
            breakdownEl.classList.add("hidden");
        }
    }
}

window.selectDeliveryMode = function (mode) {
    if (!selectedProduct) return;
    const state = getCustomizationState();
    const stockVal = selectedProduct.immediateStock ? Number(selectedProduct.immediateStock) : 0;

    if (mode === "imediata") {
        if (state.hasName || state.hasNumber) {
            showToast("Peças com nome ou número só podem ser pedidas no Lote!", "error");
            return;
        }
        if (stockVal <= 0) {
            showToast("Não há unidades a pronta entrega disponíveis no momento.", "error");
            return;
        }
    }
    selectedDeliveryMode = mode === "imediata" ? "imediata" : "lote";
    evaluateDeliveryAndPrice();
};

window.openProductModal = function (id) {
    selectedProduct = findProduct(id);

    if (!selectedProduct || selectedProduct.status !== "disponivel") {
        window.notifyUnavailableProduct(selectedProduct ? selectedProduct.status : "em_breve");
        return;
    }

    selectedSize = null;
    selectedDeliveryMode = "lote";

    if (byId("modal-product-name")) byId("modal-product-name").textContent = selectedProduct.name;
    if (byId("modal-product-desc")) byId("modal-product-desc").textContent = selectedProduct.desc;
    if (byId("qty-input")) byId("qty-input").value = "1";
    if (byId("size-error")) byId("size-error").classList.add("hidden");

    if (byId("custom-name-input")) byId("custom-name-input").value = "";
    if (byId("custom-number-input")) byId("custom-number-input").value = "";
    if (byId("custom-name-counter")) byId("custom-name-counter").textContent = "0/10";

    const wrapper = byId("modal-swiper-wrapper");
    if (wrapper) {
        const slides = [];
        const imgs = selectedProduct.images && selectedProduct.images.length > 0 ? selectedProduct.images : ["assets/img/logo-atletica.jpg"];
        for (let i = 0; i < imgs.length; i++) {
            slides.push(
                '<div class="swiper-slide flex items-center justify-center p-6">' +
                    '<img src="' + esc(imgs[i]) + '" onerror="this.src=\'https://placehold.co/500x500/1F4229/ccff00?text=FurioZOs\'" alt="Produto" class="max-w-full max-h-[260px] md:max-h-[420px] object-contain drop-shadow-[0_20px_40px_rgba(0,0,0,0.5)]">' +
                '</div>'
            );
        }
        wrapper.innerHTML = slides.join("");
    }

    try {
        if (modalSwiperInstance) modalSwiperInstance.destroy(true, true);
        modalSwiperInstance = new Swiper(".modalSwiper", {
            loop: (selectedProduct.images && selectedProduct.images.length > 1),
            grabCursor: true,
            pagination: { el: ".swiper-pagination", clickable: true },
            navigation: { nextEl: ".swiper-button-next", prevEl: ".swiper-button-prev" }
        });
    } catch (swErr) {
        console.warn("Swiper modal:", swErr);
    }

    const sizeContainer = byId("size-selector-container");
    const sizeOptions = byId("size-options");
    const customContainer = byId("customization-container");

    if (selectedProduct.hasSize && sizeContainer && sizeOptions) {
        sizeContainer.classList.remove("hidden");
        const tamanhos = ["PP", "P", "M", "G", "GG", "XG", "XXG"];
        const btns = [];
        for (let i = 0; i < tamanhos.length; i++) {
            const s = tamanhos[i];
            btns.push(
                '<button type="button" data-size="' + s + '" class="size-btn">' +
                    s +
                '</button>'
            );
        }
        sizeOptions.innerHTML = btns.join("");
    } else if (sizeContainer) {
        sizeContainer.classList.add("hidden");
    }

    if (customContainer) {
        if (selectedProduct.isShirt) {
            customContainer.classList.remove("hidden");
        } else {
            customContainer.classList.add("hidden");
        }
    }

    evaluateDeliveryAndPrice();
    showModal("product");
};

window.selectSize = function (size, btnElement) {
    selectedSize = size;
    if (byId("size-error")) byId("size-error").classList.add("hidden");
    const allBtns = document.querySelectorAll(".size-btn");
    for (let i = 0; i < allBtns.length; i++) {
        allBtns[i].classList.remove("is-active");
    }
    if (btnElement) btnElement.classList.add("is-active");
};

// ============================================================================
// 6. CARRINHO DE COMPRAS
// ============================================================================
function getCartBaseSubtotal() {
    let sum = 0;
    for (let i = 0; i < cart.length; i++) {
        sum += Number(cart[i].price) * Number(cart[i].quantity);
    }
    return sum;
}

// Recalcula o preco exibido de cada item com base no catalogo atual
// (evita mostrar valores antigos ou alterados no localStorage)
function refreshCartPrices() {
    for (let i = 0; i < cart.length; i++) {
        const item = cart[i];
        const p = findProduct(item.id);
        if (!p) continue;
        const customFee = (item.customName ? PRICING_RULES.CUSTOM_NAME_FEE : 0) + (item.customNumber ? PRICING_RULES.CUSTOM_NUMBER_FEE : 0);
        const deliveryFee = item.deliveryMode === "imediata" ? PRICING_RULES.IMMEDIATE_DELIVERY_FEE : 0;
        item.basePrice = Number(p.price);
        item.customFee = customFee;
        item.deliveryFee = deliveryFee;
        item.price = Number(p.price) + customFee + deliveryFee;
        item.name = p.name;
        item.quantity = Math.max(1, Math.min(MAX_QTY_PER_ITEM, parseInt(item.quantity, 10) || 1));
    }
}

// A mensagem de carrinho vazio sai do DOM quando os itens sao renderizados;
// guardamos a referencia para poder recoloca-la depois.
let emptyCartMsgEl = null;

function updateCartUI() {
    let totalQty = 0;
    for (let i = 0; i < cart.length; i++) {
        totalQty += Number(cart[i].quantity);
    }

    const badge = byId("cart-badge");
    const badgeMob = byId("cart-badge-mobile");
    if (badge) badge.textContent = String(totalQty);
    if (badgeMob) badgeMob.textContent = String(totalQty);

    const container = byId("cart-items-container");
    if (!emptyCartMsgEl) emptyCartMsgEl = byId("empty-cart-msg");
    const emptyMsg = emptyCartMsgEl;
    const totalEl = byId("cart-total");

    if (!container || !totalEl) return;

    if (cart.length === 0) {
        container.innerHTML = "";
        if (emptyMsg) {
            emptyMsg.classList.remove("hidden");
            container.appendChild(emptyMsg);
        }
        totalEl.textContent = CURRENCY_PREFIX + "0,00";
        return;
    }

    if (emptyMsg) emptyMsg.classList.add("hidden");
    let totalValue = 0;
    const rows = [];

    for (let i = 0; i < cart.length; i++) {
        const item = cart[i];
        const itemTotal = Number(item.price) * Number(item.quantity);
        const cid = esc(item.cartItemId);
        totalValue += itemTotal;

        const customBadges = [];
        if (item.customName) {
            customBadges.push('<span class="label border border-bone/30 text-bone px-1.5 py-0.5">Nome: ' + esc(item.customName) + '</span>');
        }
        if (item.customNumber) {
            customBadges.push('<span class="label border border-bone/30 text-bone px-1.5 py-0.5">Nº ' + esc(item.customNumber) + '</span>');
        }

        const deliveryBadge = item.deliveryMode === "imediata"
            ? '<span class="label bg-[#ccff00] text-ink px-1.5 py-0.5"><i class="fa-solid fa-bolt mr-1"></i>Pronta Entrega</span>'
            : '<span class="label bg-ash text-smoke px-1.5 py-0.5">Pedido em Lote</span>';

        rows.push(
            '<div class="flex gap-3 bg-coal p-3 border border-ash hover:border-[#ccff00]/40 transition-colors">' +
                '<img src="' + esc(item.img) + '" onerror="this.src=\'https://placehold.co/150x150/1F4229/ccff00?text=FurioZOs\'" class="w-20 h-24 object-cover border border-ash shrink-0">' +
                '<div class="flex-grow flex flex-col justify-between min-w-0">' +
                    '<div class="flex justify-between items-start gap-2">' +
                        '<h4 class="font-sport font-black uppercase text-xl text-bone leading-none">' + esc(item.name) + '</h4>' +
                        '<button type="button" data-cart-action="remove" data-cart-id="' + cid + '" class="text-smoke hover:text-red-400 transition-colors" title="Remover"><i class="fa-solid fa-xmark"></i></button>' +
                    '</div>' +
                    '<p class="label text-smoke mt-1">Tam <strong class="text-bone">' + esc(item.size) + '</strong> • Unit ' + formatPrice(item.price) + '</p>' +
                    '<div class="flex flex-wrap gap-1 my-2">' + customBadges.join("") + deliveryBadge + '</div>' +
                    '<div class="flex justify-between items-center">' +
                        '<div class="flex items-center border border-ash">' +
                            '<button type="button" data-cart-action="dec" data-cart-id="' + cid + '" class="w-7 h-7 text-smoke hover:text-ink hover:bg-[#ccff00] transition-colors"><i class="fa-solid fa-minus text-[10px]"></i></button>' +
                            '<span class="w-7 text-center font-mono text-xs text-bone">' + Number(item.quantity) + '</span>' +
                            '<button type="button" data-cart-action="inc" data-cart-id="' + cid + '" class="w-7 h-7 text-smoke hover:text-ink hover:bg-[#ccff00] transition-colors"><i class="fa-solid fa-plus text-[10px]"></i></button>' +
                        '</div>' +
                        '<span class="font-mono font-semibold text-[#ccff00]">' + formatPrice(itemTotal) + '</span>' +
                    '</div>' +
                '</div>' +
            '</div>'
        );
    }

    container.innerHTML = rows.join("");
    totalEl.textContent = formatPrice(totalValue);
}

window.addToCart = async function () {
    if (!selectedProduct) return;
    const qtyEl = byId("qty-input");
    const rawQty = parseInt(qtyEl ? qtyEl.value : "1", 10);
    const qty = Math.max(1, Math.min(MAX_QTY_PER_ITEM, isNaN(rawQty) ? 1 : rawQty));

    if (selectedProduct.hasSize && !selectedSize) {
        if (byId("size-error")) byId("size-error").classList.remove("hidden");
        return;
    }

    const state = getCustomizationState();
    const deliveryFee = selectedDeliveryMode === "imediata" ? PRICING_RULES.IMMEDIATE_DELIVERY_FEE : 0;
    const stockVal = selectedProduct.immediateStock ? Number(selectedProduct.immediateStock) : 0;

    const finalUnitPrice = Number(selectedProduct.price) + state.customFee + deliveryFee;
    const sizeKey = selectedSize ? selectedSize : "unico";
    const nameKey = state.customName ? state.customName : "semnome";
    const numKey = state.customNumber ? state.customNumber : "semnum";
    const uniqueKey = [selectedProduct.id, sizeKey, nameKey, numKey, selectedDeliveryMode].join("-");

    let foundIndex = -1;
    for (let i = 0; i < cart.length; i++) {
        if (cart[i].cartItemId === uniqueKey) {
            foundIndex = i;
            break;
        }
    }

    const alreadyInCart = foundIndex > -1 ? Number(cart[foundIndex].quantity) : 0;
    if (selectedDeliveryMode === "imediata" && alreadyInCart + qty > stockVal) {
        showToast("Apenas " + stockVal + " unid. disponíveis para pronta entrega.", "error");
        return;
    }
    if (alreadyInCart + qty > MAX_QTY_PER_ITEM) {
        showToast("Máximo de " + MAX_QTY_PER_ITEM + " unidades por item.", "error");
        return;
    }

    if (foundIndex > -1) {
        cart[foundIndex].quantity = alreadyInCart + qty;
    } else {
        cart.push({
            id: selectedProduct.id,
            name: selectedProduct.name,
            basePrice: Number(selectedProduct.price),
            customFee: state.customFee,
            deliveryFee: deliveryFee,
            price: finalUnitPrice,
            img: (selectedProduct.images && selectedProduct.images.length > 0) ? selectedProduct.images[0] : "assets/img/logo-atletica.jpg",
            size: selectedSize ? selectedSize : "Único",
            customName: state.customName,
            customNumber: state.customNumber,
            deliveryMode: selectedDeliveryMode,
            isShirt: Boolean(selectedProduct.isShirt),
            quantity: qty,
            cartItemId: uniqueKey
        });
    }

    updateCartUI();
    closeModal("product");
    showToast(qty + "x " + selectedProduct.name + " adicionado ao carrinho!");
    await saveCartData();
    setTimeout(openCartSidebar, 250);
};

window.removeFromCart = async function (cartItemId) {
    cart = cart.filter(function (item) { return item.cartItemId !== cartItemId; });
    updateCartUI();
    await saveCartData();
};

window.updateQuantity = async function (cartItemId, delta) {
    for (let i = 0; i < cart.length; i++) {
        if (cart[i].cartItemId === cartItemId) {
            const next = Number(cart[i].quantity) + Number(delta);
            if (next <= 0) {
                await window.removeFromCart(cartItemId);
                return;
            }
            if (next > MAX_QTY_PER_ITEM) {
                showToast("Máximo de " + MAX_QTY_PER_ITEM + " unidades por item.", "error");
                return;
            }
            if (cart[i].deliveryMode === "imediata") {
                const p = findProduct(cart[i].id);
                const stockVal = p && p.immediateStock ? Number(p.immediateStock) : 0;
                if (next > stockVal) {
                    showToast("Apenas " + stockVal + " unid. disponíveis para pronta entrega.", "error");
                    return;
                }
            }
            cart[i].quantity = next;
            updateCartUI();
            await saveCartData();
            return;
        }
    }
};

// ============================================================================
// 7. CHECKOUT, PARCELAMENTO 12X E INTEGRACAO MERCADO PAGO VIA WORKER
// ============================================================================
function buildInstallmentsDropdown(baseSubtotal) {
    const select = byId("card-installments");
    if (!select) return;

    const optionsHTML = [];
    for (let i = 1; i <= 12; i++) {
        const rate = INSTALLMENT_RATES[i] ? INSTALLMENT_RATES[i] : 0.05;
        const totalWithFee = Number((baseSubtotal / (1 - rate)).toFixed(2));
        const installmentVal = Number((totalWithFee / i).toFixed(2));
        const label = i + "x de " + formatPrice(installmentVal) + " (Total: " + formatPrice(totalWithFee) + ")";
        optionsHTML.push('<option value="' + i + '" data-total="' + totalWithFee + '">' + label + '</option>');
    }
    select.innerHTML = optionsHTML.join("");
}

function updateCheckoutTotalsUI() {
    const baseSubtotal = getCartBaseSubtotal();
    const subtotalEl = byId("checkout-subtotal-display");
    const feeRow = byId("checkout-fee-row");
    const feeDisplay = byId("checkout-fee-display");
    const totalDisplay = byId("checkout-total-display");
    const summaryText = byId("checkout-installment-summary");

    if (subtotalEl) subtotalEl.textContent = formatPrice(baseSubtotal);

    if (selectedPaymentMethod === "pix") {
        if (feeRow) {
            feeRow.classList.add("hidden");
            feeRow.classList.remove("flex");
        }
        if (totalDisplay) totalDisplay.textContent = formatPrice(baseSubtotal);
        if (summaryText) summaryText.textContent = "À vista no PIX (Sem taxas extras)";
    } else {
        const select = byId("card-installments");
        const rawInst = select ? select.value : "1";
        const installments = parseInt(rawInst, 10) ? parseInt(rawInst, 10) : 1;
        const rate = INSTALLMENT_RATES[installments] ? INSTALLMENT_RATES[installments] : 0.0498;
        const finalCardTotal = Number((baseSubtotal / (1 - rate)).toFixed(2));
        const feeAmount = Math.max(0, finalCardTotal - baseSubtotal);
        const perInstallment = Number((finalCardTotal / installments).toFixed(2));

        if (feeRow) {
            feeRow.classList.remove("hidden");
            feeRow.classList.add("flex");
        }
        if (feeDisplay) feeDisplay.textContent = "+ " + formatPrice(feeAmount);
        if (totalDisplay) totalDisplay.textContent = formatPrice(finalCardTotal);
        if (summaryText) summaryText.textContent = "Em " + installments + "x de " + formatPrice(perInstallment) + " no Cartão";
    }
}

window.selectPaymentMethod = function (method) {
    selectedPaymentMethod = (method === "card" || method === "cartao") ? "card" : "pix";
    const tabPix = byId("tab-pay-pix");
    const tabCard = byId("tab-pay-card");
    const panelPix = byId("payment-pix-panel");
    const panelCard = byId("payment-card-panel");
    const btnSubmit = byId("btn-submit-payment");
    const qrBox = byId("pix-qrcode-box");

    if (selectedPaymentMethod === "pix") {
        if (tabPix) tabPix.classList.add("is-active");
        if (tabCard) tabCard.classList.remove("is-active");
        if (panelPix) panelPix.classList.remove("hidden");
        if (panelCard) panelCard.classList.add("hidden");
        if (btnSubmit) {
            btnSubmit.textContent = "Gerar QR Code PIX";
            if (qrBox && !qrBox.classList.contains("hidden")) {
                btnSubmit.classList.add("hidden");
            } else {
                btnSubmit.classList.remove("hidden");
            }
        }
    } else {
        if (tabCard) tabCard.classList.add("is-active");
        if (tabPix) tabPix.classList.remove("is-active");
        if (panelCard) panelCard.classList.remove("hidden");
        if (panelPix) panelPix.classList.add("hidden");
        if (btnSubmit) {
            btnSubmit.classList.remove("hidden");
            btnSubmit.textContent = "Pagar com Cartão";
        }
    }
    updateCheckoutTotalsUI();
};

// Detecta automaticamente a bandeira (payment_method_id) e banco emissor (issuer_id) pelo BIN do cartao
async function detectCardMethodAndIssuer(cardNumber) {
    const bin = String(cardNumber ? cardNumber : "").replace(/\D/g, "").slice(0, 6);
    try {
        if (mpInstance && bin.length >= 6) {
            const methods = await mpInstance.getPaymentMethods({ bin: bin });
            if (methods && methods.results && methods.results.length > 0) {
                const first = methods.results[0];
                return {
                    paymentMethodId: first.id,
                    issuerId: (first.issuer && first.issuer.id) ? first.issuer.id : undefined
                };
            }
        }
    } catch (e) {
        console.warn("Fallback BIN:", e);
    }

    // Fallback por prefixo caso o SDK nao retorne a bandeira
    if (/^4/.test(bin)) return { paymentMethodId: "visa", issuerId: undefined };
    if (/^(5[1-5]|2[2-7])/.test(bin)) return { paymentMethodId: "master", issuerId: undefined };
    if (/^3[47]/.test(bin)) return { paymentMethodId: "amex", issuerId: undefined };
    if (/^(606282|3841)/.test(bin)) return { paymentMethodId: "hipercard", issuerId: undefined };
    return { paymentMethodId: "elo", issuerId: undefined };
}

function translateMpRejectReason(statusDetail, rawMessage) {
    const map = {
        "cc_rejected_bad_filled_card_number": "Número do cartão inválido.",
        "cc_rejected_bad_filled_date": "Data de validade incorreta.",
        "cc_rejected_bad_filled_other": "Verifique os dados digitados do cartão.",
        "cc_rejected_bad_filled_security_code": "Código CVV inválido.",
        "cc_rejected_blacklist": "Cartão bloqueado por segurança.",
        "cc_rejected_call_for_authorize": "O banco emissor exige autorização para esta compra.",
        "cc_rejected_card_disabled": "Este cartão está desativado. Ative-o no app do banco.",
        "cc_rejected_duplicated_payment": "Pagamento duplicado detectado. Aguarde alguns minutos.",
        "cc_rejected_high_risk": "Recusado pelo antifraude (Nota: o Mercado Pago bloqueia compras usando o mesmo CPF/cartão do dono da conta).",
        "cc_rejected_insufficient_amount": "Saldo ou limite insuficiente no cartão.",
        "cc_rejected_invalid_installments": "O cartão não aceita essa quantidade de parcelas.",
        "cc_rejected_max_attempts": "Limite de tentativas excedido. Tente outro cartão."
    };
    if (statusDetail && map[statusDetail]) return map[statusDetail];
    if (rawMessage && String(rawMessage).toLowerCase().indexOf("payer") !== -1) {
        return "O Mercado Pago não permite que o titular da conta pague para si mesmo. Teste com o CPF de outra pessoa!";
    }
    return rawMessage ? String(rawMessage) : "Transação não autorizada pela operadora.";
}

// Chamada autenticada ao Worker (envia o ID token do Firebase)
async function callWorker(path, method, bodyObj) {
    const baseUrl = String(MERCADO_PAGO_CONFIG.workerUrl ? MERCADO_PAGO_CONFIG.workerUrl : "").replace(/\/+$/, "");
    if (!baseUrl) {
        return { ok: false, status: 400, data: { message: "URL do Worker de pagamento não configurada." } };
    }
    if (!isRegisteredUser()) {
        return { ok: false, status: 401, data: { message: "Faça login para continuar." } };
    }

    const idToken = await currentUser.getIdToken();
    const res = await fetch(baseUrl + path, {
        method: method,
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + idToken
        },
        body: bodyObj ? JSON.stringify(bodyObj) : undefined
    });

    let data = {};
    try {
        data = await res.json();
    } catch (e) {
        data = {};
    }
    return { ok: res.ok, status: res.status, data: data };
}

// O Worker recebe apenas O QUE foi escolhido; o preco e calculado la
function buildCheckoutItems() {
    return cart.map(function (item) {
        return {
            id: item.id,
            size: item.size,
            customName: item.customName ? item.customName : "",
            customNumber: item.customNumber ? item.customNumber : "",
            deliveryMode: item.deliveryMode === "imediata" ? "imediata" : "lote",
            quantity: Number(item.quantity)
        };
    });
}

function stopPixPolling() {
    if (pixPollingInterval) {
        clearInterval(pixPollingInterval);
        pixPollingInterval = null;
    }
}

async function checkOrderStatus(orderId, silent) {
    if (!orderId) return;
    try {
        const res = await callWorker("/orders/" + encodeURIComponent(orderId), "GET", null);
        const status = res.data ? res.data.status : "";

        if (res.ok && status === ORDER_STATUS.PAID) {
            stopPixPolling();
            const statusInd = byId("pix-status-indicator");
            if (statusInd) {
                statusInd.innerHTML = '<i class="fa-solid fa-circle-check text-[#ccff00]"></i> Pagamento Aprovado pelo Banco!';
            }
            await handleOrderConfirmed(res.data.order);
        } else if (res.ok && (status === ORDER_STATUS.CANCELLED || status === ORDER_STATUS.REJECTED)) {
            stopPixPolling();
            showToast("Este PIX expirou ou foi cancelado. Gere um novo código.", "error");
            if (byId("pix-qrcode-box")) byId("pix-qrcode-box").classList.add("hidden");
            if (byId("btn-submit-payment")) byId("btn-submit-payment").classList.remove("hidden");
        } else if (!silent) {
            showToast("O banco ainda aguarda a confirmação do PIX. Assim que pagar no app do banco, aguarde alguns segundos!", "error");
        }
    } catch (err) {
        if (!silent) showToast("Verificando status com o Mercado Pago...", "error");
    }
}

function upsertOrderLocally(order) {
    if (!order || !order.orderId) return;
    const next = [];
    let replaced = false;
    for (let i = 0; i < ordersList.length; i++) {
        if (ordersList[i].orderId === order.orderId) {
            next.push(Object.assign({}, ordersList[i], order));
            replaced = true;
        } else {
            next.push(ordersList[i]);
        }
    }
    if (!replaced) next.unshift(order);
    ordersList = next;
}

// ============================================================================
// 8. CONFIRMACAO DO PEDIDO (WHATSAPP + E-MAIL + RECIBO)
// ============================================================================
function buildOrderReceiptMessage(order) {
    const itemsArr = order.items ? order.items : [];
    const lines = [];
    for (let i = 0; i < itemsArr.length; i++) {
        const item = itemsArr[i];
        let customInfo = "";
        if (item.customName || item.customNumber) {
            const nStr = item.customName ? item.customName : "-";
            const numStr = item.customNumber ? item.customNumber : "-";
            customInfo = " • Nome: " + nStr + " / Nº: " + numStr;
        }
        const modeLabel = item.deliveryMode === "imediata" ? "Pronta Entrega" : "Lote";
        const lineTotal = formatPrice(Number(item.price) * Number(item.quantity));
        lines.push("• " + item.quantity + "x " + item.name + " (Tam: " + item.size + customInfo + ") [" + modeLabel + "] - " + lineTotal);
    }

    const txId = order.mpPaymentId ? order.mpPaymentId : "Confirmado";

    return [
        "🐸 *CONFIRMAÇÃO DE PEDIDO - ATLÉTICA FURIOZOS*",
        "━━━━━━━━━━━━━━━━━━━━",
        "*Pedido:* #" + order.orderId,
        "*Transação MP:* " + txId,
        "*Aluno:* " + order.customerName,
        "*Matrícula UERJ:* " + order.customerMatricula,
        "*CPF:* " + order.customerCpf,
        "*WhatsApp:* " + order.customerPhone,
        "━━━━━━━━━━━━━━━━━━━━",
        "*ITENS DO PEDIDO:*",
        lines.join("\n"),
        "━━━━━━━━━━━━━━━━━━━━",
        "*Forma de Pagamento:* " + order.paymentMethod,
        "*Total Pago:* " + formatPrice(order.total),
        "*Status:* ✅ " + order.status
    ].join("\n");
}

function showOrderReceiptModal(order) {
    const box = byId("receipt-details-box");
    if (!box) return;

    const itemsArr = order.items ? order.items : [];
    const itemRows = [];
    for (let i = 0; i < itemsArr.length; i++) {
        const item = itemsArr[i];
        const nStr = item.customName ? item.customName : "-";
        const numStr = item.customNumber ? item.customNumber : "-";
        const customStr = (item.customName || item.customNumber)
            ? '<span class="block text-[11px] text-[#8A9A4A] font-bold">Personalização: ' + esc(nStr) + ' • Nº ' + esc(numStr) + '</span>'
            : "";
        const itemSubtotal = formatPrice(Number(item.price) * Number(item.quantity));

        itemRows.push(
            '<div class="flex justify-between items-start py-1.5 border-b border-ash">' +
                '<div>' +
                    '<strong class="text-bone">' + Number(item.quantity) + 'x ' + esc(item.name) + ' (Tam: ' + esc(item.size) + ')</strong>' +
                    customStr +
                '</div>' +
                '<span class="font-bold text-[#ccff00]">' + itemSubtotal + '</span>' +
            '</div>'
        );
    }

    box.innerHTML =
        '<div class="flex justify-between items-center border-b border-ash pb-2 mb-2">' +
            '<span class="font-black text-[#ccff00] uppercase">Pedido #' + esc(order.orderId) + '</span>' +
            '<span class="' + statusBadgeClass(order.status) + ' font-black px-2 py-0.5 rounded text-[10px] uppercase">' + esc(order.status) + '</span>' +
        '</div>' +
        '<p><strong>Aluno:</strong> ' + esc(order.customerName) + '</p>' +
        '<p><strong>Matrícula UERJ:</strong> <span class="font-mono">' + esc(order.customerMatricula) + '</span></p>' +
        '<p><strong>Pagamento:</strong> ' + esc(order.paymentMethod) + '</p>' +
        '<div class="mt-2 pt-2 border-t border-ash">' + itemRows.join("") + '</div>' +
        '<div class="flex justify-between items-center pt-2 text-sm font-black text-[#ccff00]">' +
            '<span>TOTAL PAGO:</span>' +
            '<span class="text-lg">' + formatPrice(order.total) + '</span>' +
        '</div>';

    const msgText = buildOrderReceiptMessage(order);
    const waBtn = byId("btn-receipt-whatsapp");
    if (waBtn) {
        waBtn.href = "https://wa.me/" + MERCADO_PAGO_CONFIG.atleticaWhatsapp + "?text=" + encodeURIComponent(msgText);
    }

    const emailBtn = byId("btn-receipt-email");
    if (emailBtn) {
        emailBtn.onclick = function () {
            const subject = "Confirmação de Pedido #" + order.orderId + " - Atlética FurioZOs";
            window.location.href = "mailto:" + encodeURIComponent(order.customerEmail ? order.customerEmail : "") +
                "?cc=" + encodeURIComponent(MERCADO_PAGO_CONFIG.atleticaEmail) +
                "&subject=" + encodeURIComponent(subject) +
                "&body=" + encodeURIComponent(msgText);
        };
    }

    showModal("receipt");
}

// Chamado SOMENTE depois que o Worker confirmou o pagamento no Mercado Pago
async function handleOrderConfirmed(order) {
    if (!order || !order.orderId || confirmedOrderIds.has(order.orderId)) return;
    confirmedOrderIds.add(order.orderId);

    upsertOrderLocally(order);
    cart = [];
    await saveCartData();
    updateCartUI();
    closeModal("checkout");

    await loadInitialData();
    renderProducts();
    updateBatchCountersUI();

    showToast("Pagamento aprovado! Pedido #" + order.orderId + " confirmado.");
    setTimeout(function () {
        showOrderReceiptModal(order);
    }, 250);
}

async function handleOrderUnderReview(order) {
    if (order) upsertOrderLocally(order);
    cart = [];
    await saveCartData();
    updateCartUI();
    closeModal("checkout");
    showToast("Pagamento em análise pelo Mercado Pago. Acompanhe em Meu Perfil > Pedidos.");
}

// ============================================================================
// 9. PERSISTENCIA FIRESTORE + BACKUP LOCAL SEGURO
// ============================================================================
async function loadInitialData() {
    if (!db) return;
    try {
        const productsCol = collection(db, "artifacts", appId, "public", "data", "products");
        const snap = await getDocs(productsCol);
        if (!snap.empty) {
            productsCatalog = snap.docs.map(function (d) { return Object.assign({}, d.data(), { id: d.id }); });
            refreshCartPrices();
            updateCartUI();
            renderProducts();
        } else if (isCurrentUserAdmin()) {
            for (let i = 0; i < DEFAULT_PRODUCTS.length; i++) {
                const p = DEFAULT_PRODUCTS[i];
                await setDoc(doc(productsCol, p.id), p);
            }
        }
    } catch (err) {
        console.warn("Catálogo padrão ativo:", err);
    }

    if (!isRegisteredUser()) {
        ordersList = [];
        updateBatchCountersUI();
        return;
    }

    try {
        const ordersCol = collection(db, "artifacts", appId, "public", "data", "orders");
        // Admin ve todos; usuario comum so os proprios (exigido pelas regras)
        const ordersQuery = isCurrentUserAdmin()
            ? ordersCol
            : query(ordersCol, where("userId", "==", currentUser.uid));
        const ordersSnap = await getDocs(ordersQuery);
        ordersList = ordersSnap.docs
            .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
            .sort(function (a, b) {
                const dA = a.createdAtISO ? a.createdAtISO : "";
                const dB = b.createdAtISO ? b.createdAtISO : "";
                return dB.localeCompare(dA);
            });
        updateBatchCountersUI();
    } catch (err) {
        console.warn("Pedidos Firestore:", err);
    }
}

async function saveProductToFirestore(product) {
    for (let i = 0; i < productsCatalog.length; i++) {
        if (productsCatalog[i].id === product.id) {
            productsCatalog[i] = product;
            break;
        }
    }
    if (!db) return;
    const prodRef = doc(db, "artifacts", appId, "public", "data", "products", product.id);
    await setDoc(prodRef, product, { merge: true });
}

function getCartLocalKey() {
    return isRegisteredUser() ? ("furiozos_cart_" + currentUser.uid) : "furiozos_cart_guest";
}

async function loadCartData() {
    const localKey = getCartLocalKey();
    cart = [];
    try {
        const localSaved = localStorage.getItem(localKey);
        if (localSaved) {
            const parsed = JSON.parse(localSaved);
            if (Array.isArray(parsed)) cart = parsed;
        }
    } catch (e) {}
    refreshCartPrices();
    updateCartUI();

    if (!db || !isRegisteredUser()) return;
    try {
        const cartRef = doc(db, "artifacts", appId, "users", currentUser.uid, "cart", "current");
        const docSnap = await getDoc(cartRef);
        if (docSnap.exists() && Array.isArray(docSnap.data().items)) {
            cart = docSnap.data().items;
            refreshCartPrices();
            localStorage.setItem(localKey, JSON.stringify(cart));
            updateCartUI();
        }
    } catch (error) {
        console.warn("Carrinho local mantido:", error);
    }
}

async function saveCartData() {
    const localKey = getCartLocalKey();
    try {
        localStorage.setItem(localKey, JSON.stringify(cart));
    } catch (e) {}

    if (!db || !isRegisteredUser()) return;
    try {
        const cartRef = doc(db, "artifacts", appId, "users", currentUser.uid, "cart", "current");
        await setDoc(cartRef, { items: cart, updatedAt: serverTimestamp() }, { merge: true });
    } catch (error) {
        console.warn("Carrinho salvo localmente:", error);
    }
}

async function loadUserProfileData() {
    if (!isRegisteredUser() || !db) return;
    try {
        const profRef = doc(db, "artifacts", appId, "users", currentUser.uid, "cart", "profile");
        const snap = await getDoc(profRef);
        const fallbackName = currentUser.displayName ? currentUser.displayName : "";
        if (snap.exists()) {
            const d = snap.data();
            userProfile = {
                name: d.name ? d.name : fallbackName,
                matricula: d.matricula ? d.matricula : "",
                cpf: d.cpf ? d.cpf : "",
                phone: d.phone ? d.phone : ""
            };
        } else {
            userProfile = { name: fallbackName, matricula: "", cpf: "", phone: "" };
        }
    } catch (err) {
        console.warn("Perfil:", err);
    }
}

async function saveUserProfileData() {
    if (!isRegisteredUser() || !db) return;
    const profRef = doc(db, "artifacts", appId, "users", currentUser.uid, "cart", "profile");
    await setDoc(profRef, Object.assign({}, userProfile, { updatedAt: serverTimestamp() }), { merge: true });
}

// ============================================================================
// 10. MODAL MEU PERFIL E MEUS PEDIDOS
// ============================================================================
function openProfileModal() {
    if (!isRegisteredUser()) {
        openAuthModal();
        return;
    }
    const uEmail = currentUser.email ? currentUser.email : "";
    const uName = userProfile.name ? userProfile.name : (currentUser.displayName ? currentUser.displayName : "");

    if (byId("profile-header-email")) byId("profile-header-email").textContent = uEmail;
    if (byId("profile-name")) byId("profile-name").value = uName;
    if (byId("profile-matricula")) byId("profile-matricula").value = userProfile.matricula ? userProfile.matricula : "";
    if (byId("profile-cpf")) byId("profile-cpf").value = userProfile.cpf ? userProfile.cpf : "";
    if (byId("profile-phone")) byId("profile-phone").value = userProfile.phone ? userProfile.phone : "";
    if (byId("profile-new-password")) byId("profile-new-password").value = "";

    window.switchProfileTab("dados");
    showModal("profile");
}

window.switchProfileTab = function (tab) {
    const btnData = byId("tab-profile-data");
    const btnOrders = byId("tab-profile-orders");
    const formPanel = byId("profile-form");
    const ordersPanel = byId("profile-orders-panel");

    if (tab === "dados") {
        if (btnData) btnData.classList.add("is-active");
        if (btnOrders) btnOrders.classList.remove("is-active");
        if (formPanel) formPanel.classList.remove("hidden");
        if (ordersPanel) ordersPanel.classList.add("hidden");
    } else {
        if (btnOrders) btnOrders.classList.add("is-active");
        if (btnData) btnData.classList.remove("is-active");
        if (formPanel) formPanel.classList.add("hidden");
        if (ordersPanel) ordersPanel.classList.remove("hidden");
        renderUserOrdersHistory();
    }
};

function renderUserOrdersHistory() {
    const container = byId("profile-orders-panel");
    if (!container || !isRegisteredUser()) return;

    const myOrders = ordersList.filter(function (o) {
        return o.userId === currentUser.uid;
    });

    if (myOrders.length === 0) {
        container.innerHTML =
            '<div class="text-center py-10 text-smoke">' +
                '<i class="fa-solid fa-bag-shopping text-4xl mb-2"></i>' +
                '<p class="font-bold text-sm">Você ainda não realizou nenhum pedido.</p>' +
            '</div>';
        return;
    }

    const html = [];
    for (let i = 0; i < myOrders.length; i++) {
        const o = myOrders[i];
        const dateStr = o.createdAtISO ? new Date(o.createdAtISO).toLocaleString("pt-BR") : "";
        const itemsArr = o.items ? o.items : [];
        const itemLines = [];
        for (let j = 0; j < itemsArr.length; j++) {
            const it = itemsArr[j];
            const nVal = it.customName ? it.customName : "-";
            const numVal = it.customNumber ? it.customNumber : "-";
            const customTag = (it.customName || it.customNumber)
                ? " [Nome: " + esc(nVal) + " / Nº: " + esc(numVal) + "]"
                : "";
            itemLines.push('<div class="text-xs text-bone/80">• <strong>' + Number(it.quantity) + 'x ' + esc(it.name) + '</strong> (Tam: ' + esc(it.size) + ')' + customTag + '</div>');
        }

        const receiptBtn = o.status === ORDER_STATUS.PAID
            ? '<button type="button" data-order-id="' + esc(o.orderId) + '" class="text-xs font-bold text-[#ccff00] hover:underline flex items-center gap-1">' +
                  '<i class="fa-brands fa-whatsapp"></i> Ver Comprovante' +
              '</button>'
            : "";

        html.push(
            '<div class="bg-coal p-4 border border-ash space-y-2">' +
                '<div class="flex justify-between items-center">' +
                    '<span class="font-sport font-black text-sm text-[#ccff00]">Pedido #' + esc(o.orderId) + '</span>' +
                    '<span class="' + statusBadgeClass(o.status) + ' text-[10px] font-black px-2.5 py-0.5 rounded-full uppercase">' + esc(o.status) + '</span>' +
                '</div>' +
                '<p class="text-[11px] text-smoke">' + esc(dateStr) + ' • ' + esc(o.paymentMethod) + '</p>' +
                '<div class="space-y-1 pt-1 border-t border-ash">' + itemLines.join("") + '</div>' +
                '<div class="flex justify-between items-center pt-2 border-t border-ash">' +
                    '<span class="font-black text-[#ccff00] text-sm">Total: ' + formatPrice(o.total) + '</span>' +
                    receiptBtn +
                '</div>' +
            '</div>'
        );
    }

    container.innerHTML = html.join("");
}

window.reopenOrderReceipt = function (orderId) {
    for (let i = 0; i < ordersList.length; i++) {
        if (ordersList[i].orderId === orderId) {
            closeModal("profile");
            const targetOrder = ordersList[i];
            setTimeout(function () {
                showOrderReceiptModal(targetOrder);
            }, 200);
            break;
        }
    }
};

// ============================================================================
// 11. PAINEL DA DIRETORIA (ADMIN) E EXPORTACAO EXCEL (.XLSX)
// ============================================================================
function getPaidOrders() {
    return ordersList.filter(function (o) { return o.status === ORDER_STATUS.PAID; });
}

function calculateBatchMetrics() {
    let totalShirtsInBatch = 0;
    let totalRevenue = 0;
    const paidOrders = getPaidOrders();

    for (let i = 0; i < paidOrders.length; i++) {
        const order = paidOrders[i];
        totalRevenue += Number(order.total ? order.total : 0);
        const itemsArr = order.items ? order.items : [];
        for (let j = 0; j < itemsArr.length; j++) {
            const item = itemsArr[j];
            if (item.isShirt && item.deliveryMode === "lote") {
                totalShirtsInBatch += Number(item.quantity ? item.quantity : 0);
            }
        }
    }

    return { totalShirtsInBatch: totalShirtsInBatch, totalRevenue: totalRevenue, totalOrders: paidOrders.length };
}

function updateBatchCountersUI() {
    const metrics = calculateBatchMetrics();
    const goal = PRICING_RULES.BATCH_MIN_GOAL;

    const adminBatchCount = byId("admin-batch-count");
    const adminBatchBar = byId("admin-batch-bar");
    const adminBatchBadge = byId("admin-batch-status-badge");
    const adminOrdersCount = byId("admin-orders-count");
    const adminRevenueTotal = byId("admin-revenue-total");

    if (adminBatchCount) adminBatchCount.textContent = metrics.totalShirtsInBatch + " / " + goal + " camisas";
    if (adminBatchBar) {
        const pct = Math.min(100, Math.round((metrics.totalShirtsInBatch / goal) * 100));
        adminBatchBar.style.width = pct + "%";
    }
    if (adminBatchBadge) {
        if (metrics.totalShirtsInBatch >= goal) {
            adminBatchBadge.textContent = "Meta Atingida! Pronto p/ Fábrica";
            adminBatchBadge.className = "text-[11px] font-black px-2.5 py-0.5 rounded-full bg-green-100 text-green-800";
        } else {
            const remaining = goal - metrics.totalShirtsInBatch;
            adminBatchBadge.textContent = "Faltam " + remaining + " p/ fechar lote";
            adminBatchBadge.className = "text-[11px] font-black px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800";
        }
    }
    if (adminOrdersCount) adminOrdersCount.textContent = String(metrics.totalOrders);
    if (adminRevenueTotal) adminRevenueTotal.textContent = formatPrice(metrics.totalRevenue);
}

function renderAdminPanel() {
    if (!isCurrentUserAdmin()) {
        showToast("Acesso restrito ao administrador.", "error");
        return;
    }

    updateBatchCountersUI();

    const prodTbody = byId("admin-products-tbody");
    if (prodTbody) {
        const prodRows = [];
        for (let i = 0; i < productsCatalog.length; i++) {
            const p = productsCatalog[i];
            const pid = esc(p.id);
            const selDisp = p.status === "disponivel" ? "selected" : "";
            const selBreve = p.status === "em_breve" ? "selected" : "";
            const selEsg = p.status === "esgotado" ? "selected" : "";
            const stVal = p.immediateStock ? Number(p.immediateStock) : 0;

            prodRows.push(
                '<tr class="hover:bg-gray-50">' +
                    '<td class="py-3 px-3 font-bold text-furiozo-dark">' + esc(p.name) + '</td>' +
                    '<td class="py-3 px-3">' +
                        '<select id="admin-status-' + pid + '" class="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs font-bold bg-white">' +
                            '<option value="disponivel" ' + selDisp + '>Disponível p/ Compra</option>' +
                            '<option value="em_breve" ' + selBreve + '>Selo "EM BREVE" (Ocultar Preço)</option>' +
                            '<option value="esgotado" ' + selEsg + '>Esgotado</option>' +
                        '</select>' +
                    '</td>' +
                    '<td class="py-3 px-3">' +
                        '<input type="number" step="0.50" id="admin-price-' + pid + '" value="' + Number(p.price) + '" class="w-24 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs font-bold">' +
                    '</td>' +
                    '<td class="py-3 px-3">' +
                        '<input type="number" min="0" id="admin-stock-' + pid + '" value="' + stVal + '" class="w-20 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-center">' +
                    '</td>' +
                    '<td class="py-3 px-3 text-right">' +
                        '<button type="button" data-admin-save="' + pid + '" class="bg-furiozo-dark text-[#ccff00] hover:bg-[#ccff00] hover:text-furiozo-dark font-black px-3 py-1.5 rounded-lg text-xs uppercase transition-all">' +
                            'Salvar' +
                        '</button>' +
                    '</td>' +
                '</tr>'
            );
        }
        prodTbody.innerHTML = prodRows.join("");
    }

    const ordersTbody = byId("admin-orders-tbody");
    if (ordersTbody) {
        if (ordersList.length === 0) {
            ordersTbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-gray-400 font-medium">Nenhum pedido registrado até o momento.</td></tr>';
        } else {
            const ordRows = [];
            for (let i = 0; i < ordersList.length; i++) {
                const o = ordersList[i];
                const dateFormatted = o.createdAtISO ? new Date(o.createdAtISO).toLocaleString("pt-BR") : "Recente";
                const itemsArr = o.items ? o.items : [];
                const itemSummaries = [];
                const modeSummaries = [];

                for (let j = 0; j < itemsArr.length; j++) {
                    const it = itemsArr[j];
                    const nVal = it.customName ? it.customName : "-";
                    const numVal = it.customNumber ? it.customNumber : "-";
                    const customStr = (it.customName || it.customNumber)
                        ? " [Nome: <strong>" + esc(nVal) + "</strong> / Nº: <strong>" + esc(numVal) + "</strong>]"
                        : " [Sem personalização]";
                    itemSummaries.push('<div class="text-xs mb-1"><strong>' + Number(it.quantity) + 'x ' + esc(it.name) + '</strong> (Tam: ' + esc(it.size) + ')' + customStr + '</div>');

                    if (it.deliveryMode === "imediata") {
                        modeSummaries.push('<span class="inline-block bg-[#ccff00] text-furiozo-dark text-[10px] font-black px-2 py-0.5 rounded uppercase">Pronta Entrega</span>');
                    } else {
                        modeSummaries.push('<span class="inline-block bg-gray-100 text-gray-700 text-[10px] font-bold px-2 py-0.5 rounded uppercase">Lote</span>');
                    }
                }

                const oId = o.orderId ? o.orderId : "-";
                const matVal = o.customerMatricula ? o.customerMatricula : (o.customerCourse ? o.customerCourse : "-");
                const payVal = o.paymentMethod ? o.paymentMethod : "PIX";
                const noteHTML = o.adminNote
                    ? '<br><span class="text-[10px] text-red-600 font-bold">' + esc(o.adminNote) + '</span>'
                    : "";

                ordRows.push(
                    '<tr class="hover:bg-gray-50 align-top">' +
                        '<td class="py-3 px-2 text-xs text-gray-500 font-mono"><strong>#' + esc(oId) + '</strong><br>' + esc(dateFormatted) + '</td>' +
                        '<td class="py-3 px-2 text-xs">' +
                            '<strong class="text-gray-800">' + esc(o.customerName) + '</strong><br>' +
                            '<span class="font-mono text-[11px] text-furiozo-dark font-bold">Mat: ' + esc(matVal) + '</span><br>' +
                            '<span class="text-gray-500">' + esc(o.customerPhone) + '</span>' +
                        '</td>' +
                        '<td class="py-3 px-2">' + itemSummaries.join("") + '</td>' +
                        '<td class="py-3 px-2">' + modeSummaries.join("<br>") + '</td>' +
                        '<td class="py-3 px-2 text-xs font-bold text-teal-700">' + esc(payVal) + '<br><span class="text-[10px] ' + statusTextClass(o.status) + ' uppercase">' + esc(o.status) + '</span>' + noteHTML + '</td>' +
                        '<td class="py-3 px-2 font-black text-furiozo-dark text-sm">' + formatPrice(o.total) + '</td>' +
                    '</tr>'
                );
            }
            ordersTbody.innerHTML = ordRows.join("");
        }
    }
}

window.saveAdminProduct = async function (productId) {
    if (!isCurrentUserAdmin()) return;
    const prod = findProduct(productId);
    if (!prod) return;

    const statusEl = byId("admin-status-" + productId);
    const priceEl = byId("admin-price-" + productId);
    const stockEl = byId("admin-stock-" + productId);

    const newStatus = statusEl ? statusEl.value : prod.status;
    const newPrice = parseFloat(priceEl ? priceEl.value : String(prod.price));
    const rawStock = parseInt(stockEl ? stockEl.value : "0", 10);
    const newStock = isNaN(rawStock) ? 0 : rawStock;

    if (PRODUCT_STATUSES.indexOf(newStatus) !== -1) prod.status = newStatus;
    if (!isNaN(newPrice) && newPrice > 0) prod.price = Number(newPrice.toFixed(2));
    prod.immediateStock = Math.max(0, newStock);

    try {
        await saveProductToFirestore(prod);
        renderProducts();
        renderAdminPanel();
        showToast('Produto "' + prod.name + '" atualizado na vitrine!');
    } catch (err) {
        console.error("Erro ao salvar produto:", err);
        showToast("Sem permissão para salvar. Confira se sua conta está na lista de admins.", "error");
    }
};

// ============================================================================
// 12. CONTROLE DE MODAIS E AUTENTICACAO
// ============================================================================
function openCartSidebar() {
    const backdrop = byId("modal-backdrop");
    const sidebar = byId("cart-sidebar");
    if (!backdrop || !sidebar) return;
    backdrop.classList.remove("hidden");
    setTimeout(function () {
        backdrop.classList.remove("opacity-0");
        sidebar.classList.remove("translate-x-full");
    }, 10);
}

function closeCartSidebar() {
    const backdrop = byId("modal-backdrop");
    const sidebar = byId("cart-sidebar");
    if (!backdrop || !sidebar) return;
    sidebar.classList.add("translate-x-full");
    backdrop.classList.add("opacity-0");
    setTimeout(function () {
        backdrop.classList.add("hidden");
    }, 250);
}

// ============================================================================
// VERIFICACAO DE E-MAIL (exigida para pagar)
// ============================================================================
const VERIFY_EMAIL_SETTINGS = { url: "https://atletica-furiozos.web.app/" };
let verifyResendAvailableAt = 0;

// Recarrega o usuario para pegar a confirmacao feita em outra aba/aparelho e
// renova o token, para o Worker enxergar email_verified = true.
async function isEmailVerified() {
    if (!isRegisteredUser()) return false;
    if (currentUser.emailVerified) return true;
    try {
        await currentUser.reload();
        currentUser = auth.currentUser || currentUser;
        if (currentUser.emailVerified) {
            await currentUser.getIdToken(true);
            return true;
        }
    } catch (err) {
        console.warn("Recarregar usuário:", err && err.code ? err.code : err);
    }
    return false;
}

function openVerifyModal() {
    const target = byId("verify-email-target");
    if (target) target.textContent = currentUser && currentUser.email ? currentUser.email : "seu e-mail";
    showModal("verify");
}

function getModalElements(type) {
    if (type === "product") return { target: byId("product-modal"), content: byId("product-modal-content") };
    if (type === "checkout") return { target: byId("checkout-modal"), content: byId("checkout-modal-content") };
    if (type === "admin") return { target: byId("admin-modal"), content: byId("admin-modal-content") };
    if (type === "profile") return { target: byId("profile-modal"), content: byId("profile-modal-content") };
    if (type === "receipt") return { target: byId("receipt-modal"), content: byId("receipt-modal-content") };
    if (type === "verify") return { target: byId("verify-modal"), content: byId("verify-modal-content") };
    return { target: byId("auth-modal"), content: byId("auth-modal-content") };
}

function showModal(type) {
    const backdrop = byId("modal-backdrop");
    const pair = getModalElements(type);
    if (!backdrop || !pair.target || !pair.content) return;
    backdrop.classList.remove("hidden");
    pair.target.classList.remove("hidden");
    setTimeout(function () {
        backdrop.classList.remove("opacity-0");
        pair.content.classList.remove("scale-95", "opacity-0");
    }, 10);
}

function closeModal(type) {
    if (type === "checkout") stopPixPolling();
    const backdrop = byId("modal-backdrop");
    const sidebar = byId("cart-sidebar");
    const pair = getModalElements(type);
    if (!pair.target || !pair.content) return;
    pair.content.classList.add("scale-95", "opacity-0");
    if (backdrop) backdrop.classList.add("opacity-0");
    setTimeout(function () {
        pair.target.classList.add("hidden");
        if (backdrop && (!sidebar || sidebar.classList.contains("translate-x-full"))) {
            backdrop.classList.add("hidden");
        }
    }, 200);
}

function openAuthModal() {
    setAuthMode("login");
    const form = byId("auth-form");
    const err = byId("auth-error");
    if (form) form.reset();
    if (err) err.classList.add("hidden");
    showModal("auth");
}

function setAuthMode(mode) {
    authMode = mode;
    const tabLogin = byId("tab-login");
    const tabRegister = byId("tab-register");
    const nameField = byId("name-field");
    const extraFields = byId("register-extra-fields");
    const btnSubmit = byId("btn-auth-submit");
    const authTitle = byId("auth-title");
    const authError = byId("auth-error");
    const authName = byId("auth-name");

    if (authError) authError.classList.add("hidden");

    if (mode === "login") {
        if (tabLogin) tabLogin.classList.add("is-active");
        if (tabRegister) tabRegister.classList.remove("is-active");
        if (nameField) nameField.classList.add("hidden");
        if (extraFields) extraFields.classList.add("hidden");
        if (authName) authName.removeAttribute("required");
        if (btnSubmit) btnSubmit.textContent = "Entrar";
        if (authTitle) authTitle.textContent = "Acessar Conta";
    } else {
        if (tabRegister) tabRegister.classList.add("is-active");
        if (tabLogin) tabLogin.classList.remove("is-active");
        if (nameField) nameField.classList.remove("hidden");
        if (extraFields) extraFields.classList.remove("hidden");
        if (authName) authName.setAttribute("required", "true");
        if (btnSubmit) btnSubmit.textContent = "Cadastrar";
        if (authTitle) authTitle.textContent = "Criar Conta";
    }
}

function updateAuthUI() {
    const isGuest = !isRegisteredUser();
    const btnLoginNav = byId("btn-login-nav");
    const userInfoNav = byId("user-info-nav");
    const usernameSpan = byId("nav-username");
    const btnLoginMobile = byId("btn-login-mobile");
    const userInfoMobile = byId("user-info-mobile");
    const usernameMobile = byId("mobile-username");
    const btnAdminNav = byId("btn-admin-nav");
    const btnAdminMobile = byId("btn-admin-mobile");

    if (isCurrentUserAdmin()) {
        if (btnAdminNav) btnAdminNav.classList.remove("hidden");
        if (btnAdminMobile) btnAdminMobile.classList.remove("hidden");
    } else {
        if (btnAdminNav) btnAdminNav.classList.add("hidden");
        if (btnAdminMobile) btnAdminMobile.classList.add("hidden");
    }

    if (isGuest) {
        if (btnLoginNav) btnLoginNav.classList.remove("hidden");
        if (userInfoNav) {
            userInfoNav.classList.add("hidden");
            userInfoNav.classList.remove("flex");
        }
        if (btnLoginMobile) btnLoginMobile.classList.remove("hidden");
        if (userInfoMobile) {
            userInfoMobile.classList.add("hidden");
            userInfoMobile.classList.remove("flex");
        }
    } else {
        const emailPrefix = currentUser.email ? currentUser.email.split("@")[0] : "Meu Perfil";
        const displayName = userProfile.name ? userProfile.name : (currentUser.displayName ? currentUser.displayName : emailPrefix);

        if (btnLoginNav) btnLoginNav.classList.add("hidden");
        if (userInfoNav) {
            userInfoNav.classList.remove("hidden");
            userInfoNav.classList.add("flex");
        }
        if (usernameSpan) usernameSpan.textContent = displayName;

        if (btnLoginMobile) btnLoginMobile.classList.add("hidden");
        if (userInfoMobile) {
            userInfoMobile.classList.remove("hidden");
            userInfoMobile.classList.add("flex");
        }
        if (usernameMobile) usernameMobile.textContent = displayName;
    }
}

// ============================================================================
// 13. INICIALIZACAO DE EVENTOS E SISTEMA
// ============================================================================
function bindDelegatedEvents() {
    // Vitrine: imagem, titulo e botao de cada card
    on("product-grid", "click", function (e) {
        const target = e.target.closest("[data-product-id]");
        if (!target) return;
        const p = findProduct(target.getAttribute("data-product-id"));
        if (p && p.status === "disponivel") {
            window.openProductModal(p.id);
        } else {
            window.notifyUnavailableProduct(p ? p.status : "em_breve");
        }
    });

    // Tamanhos no modal de produto
    on("size-options", "click", function (e) {
        const btn = e.target.closest("[data-size]");
        if (btn) window.selectSize(btn.getAttribute("data-size"), btn);
    });

    // Carrinho: remover / aumentar / diminuir
    on("cart-items-container", "click", function (e) {
        const btn = e.target.closest("[data-cart-action]");
        if (!btn) return;
        const id = btn.getAttribute("data-cart-id");
        const action = btn.getAttribute("data-cart-action");
        if (action === "remove") window.removeFromCart(id);
        else if (action === "inc") window.updateQuantity(id, 1);
        else if (action === "dec") window.updateQuantity(id, -1);
    });

    // Historico: reabrir comprovante
    on("profile-orders-panel", "click", function (e) {
        const btn = e.target.closest("[data-order-id]");
        if (btn) window.reopenOrderReceipt(btn.getAttribute("data-order-id"));
    });

    // Painel admin: salvar produto
    on("admin-products-tbody", "click", function (e) {
        const btn = e.target.closest("[data-admin-save]");
        if (btn) window.saveAdminProduct(btn.getAttribute("data-admin-save"));
    });
}

function bindAllEvents() {
    bindDelegatedEvents();

    ["checkout-cpf", "profile-cpf"].forEach(function (id) {
        on(id, "input", function (e) { e.target.value = maskCPF(e.target.value); });
    });
    ["checkout-phone", "profile-phone"].forEach(function (id) {
        on(id, "input", function (e) { e.target.value = maskPhone(e.target.value); });
    });
    ["checkout-matricula", "profile-matricula", "auth-matricula"].forEach(function (id) {
        on(id, "input", function (e) { e.target.value = maskMatricula(e.target.value); });
    });
    on("card-number", "input", function (e) { e.target.value = maskCard(e.target.value); });
    on("card-expiry", "input", function (e) { e.target.value = maskExpiry(e.target.value); });

    on("custom-name-input", "input", sanitizeCustomInputs);
    on("custom-number-input", "input", sanitizeCustomInputs);

    on("qty-plus", "click", function () {
        const input = byId("qty-input");
        if (input && parseInt(input.value, 10) < MAX_QTY_PER_ITEM) input.value = String(parseInt(input.value, 10) + 1);
    });
    on("qty-minus", "click", function () {
        const input = byId("qty-input");
        if (input && parseInt(input.value, 10) > 1) input.value = String(parseInt(input.value, 10) - 1);
    });
    on("btn-add-to-cart", "click", window.addToCart);

    on("btn-cart-nav", "click", openCartSidebar);
    on("btn-cart-mobile", "click", openCartSidebar);
    on("close-cart", "click", closeCartSidebar);
    on("btn-continue-shopping", "click", closeCartSidebar);

    on("close-product", "click", function () { closeModal("product"); });
    on("close-product-mobile", "click", function () { closeModal("product"); });
    on("close-auth", "click", function () { closeModal("auth"); });
    on("close-checkout", "click", function () { closeModal("checkout"); });
    on("close-admin", "click", function () { closeModal("admin"); });
    on("close-profile", "click", function () { closeModal("profile"); });
    on("close-receipt", "click", function () { closeModal("receipt"); });

    on("modal-backdrop", "click", function () {
        closeModal("product");
        closeModal("auth");
        closeModal("checkout");
        closeModal("admin");
        closeModal("profile");
        closeModal("receipt");
        closeModal("verify");
        closeCartSidebar();
    });

    on("mobile-menu-btn", "click", function () {
        const m = byId("mobile-menu");
        if (m) m.classList.toggle("hidden");
    });

    on("btn-login-nav", "click", openAuthModal);
    on("btn-login-mobile", "click", function () {
        const m = byId("mobile-menu");
        if (m) m.classList.add("hidden");
        openAuthModal();
    });
    on("tab-login", "click", function () { setAuthMode("login"); });
    on("tab-register", "click", function () { setAuthMode("register"); });

    on("btn-profile-nav", "click", openProfileModal);
    on("btn-profile-mobile", "click", function () {
        const m = byId("mobile-menu");
        if (m) m.classList.add("hidden");
        openProfileModal();
    });

    on("btn-admin-nav", "click", async function () {
        if (!isCurrentUserAdmin()) return;
        await loadInitialData();
        renderAdminPanel();
        showModal("admin");
    });
    on("btn-admin-mobile", "click", async function () {
        if (!isCurrentUserAdmin()) return;
        const m = byId("mobile-menu");
        if (m) m.classList.add("hidden");
        await loadInitialData();
        renderAdminPanel();
        showModal("admin");
    });

    on("btn-forgot-password", "click", async function () {
        const emailEl = byId("auth-email");
        const errEl = byId("auth-error");
        const email = emailEl ? emailEl.value.trim() : "";
        if (!email) {
            if (errEl) {
                errEl.classList.remove("hidden");
                errEl.textContent = "Digite seu e-mail no campo acima para receber o link de recuperação.";
            }
            return;
        }
        try {
            await sendPasswordResetEmail(auth, email);
        } catch (err) {
            console.warn("Reset de senha:", err && err.code ? err.code : err);
        }
        // Mensagem neutra: nao revela se o e-mail esta cadastrado
        showToast("Se o e-mail estiver cadastrado, você receberá o link de redefinição. Verifique também o spam.");
        if (errEl) errEl.classList.add("hidden");
    });

    on("auth-form", "submit", async function (e) {
        e.preventDefault();
        const email = byId("auth-email") ? byId("auth-email").value.trim() : "";
        const pass = byId("auth-pass") ? byId("auth-pass").value : "";
        const name = byId("auth-name") ? byId("auth-name").value.trim().slice(0, 80) : "";
        const matricula = byId("auth-matricula") ? byId("auth-matricula").value.replace(/\D/g, "") : "";
        const btn = byId("btn-auth-submit");
        const authError = byId("auth-error");

        if (authMode !== "login" && pass.length < 8) {
            if (authError) {
                authError.classList.remove("hidden");
                authError.textContent = "A senha deve ter pelo menos 8 caracteres.";
            }
            return;
        }

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Aguarde...';
        }
        if (authError) authError.classList.add("hidden");

        try {
            if (authMode === "login") {
                await signInWithEmailAndPassword(auth, email, pass);
                showToast("Login realizado com sucesso!");
            } else {
                const userCredential = await createUserWithEmailAndPassword(auth, email, pass);
                await updateProfile(userCredential.user, { displayName: name });
                currentUser = userCredential.user;
                userProfile = { name: name, matricula: matricula.slice(0, 12), cpf: "", phone: "" };
                try {
                    await saveUserProfileData();
                } catch (profileErr) {
                    console.warn("Perfil inicial:", profileErr);
                }
                updateAuthUI();
                try {
                    await sendEmailVerification(userCredential.user, VERIFY_EMAIL_SETTINGS);
                    showToast("Conta criada! Enviamos um link de confirmação para " + email + ".");
                } catch (verifyErr) {
                    console.warn("Verificação de e-mail:", verifyErr && verifyErr.code ? verifyErr.code : verifyErr);
                    showToast("Conta criada com sucesso!");
                }
            }
            closeModal("auth");
        } catch (error) {
            console.error("Auth Error:", error && error.code ? error.code : error);
            if (authError) {
                authError.classList.remove("hidden");
                if (error.code === "auth/email-already-in-use") authError.textContent = "E-mail já cadastrado.";
                else if (error.code === "auth/wrong-password" || error.code === "auth/user-not-found" || error.code === "auth/invalid-credential") authError.textContent = "E-mail ou senha incorretos.";
                else if (error.code === "auth/weak-password" || error.code === "auth/password-does-not-meet-requirements") authError.textContent = "Senha fraca. Use pelo menos 8 caracteres, com letras e números.";
                else if (error.code === "auth/too-many-requests") authError.textContent = "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
                else authError.textContent = "Erro ao autenticar. Tente novamente em instantes.";
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = authMode === "login" ? "Entrar" : "Cadastrar";
            }
        }
    });

    const handleLogout = async function () {
        try {
            stopPixPolling();
            if (auth) await signOut(auth);
            userProfile = { name: "", matricula: "", cpf: "", phone: "" };
            isAdminUser = false;
            ordersList = [];
            closeModal("admin");
            closeModal("profile");
            showToast("Sessão encerrada.");
        } catch (err) {
            console.error(err);
        }
    };
    on("btn-logout", "click", handleLogout);
    on("btn-logout-mobile", "click", handleLogout);

    on("profile-form", "submit", async function (e) {
        e.preventDefault();
        if (!isRegisteredUser()) return;

        const name = byId("profile-name") ? byId("profile-name").value.trim().slice(0, 80) : "";
        const matricula = byId("profile-matricula") ? byId("profile-matricula").value.replace(/\D/g, "") : "";
        const cpf = byId("profile-cpf") ? byId("profile-cpf").value.trim() : "";
        const phone = byId("profile-phone") ? byId("profile-phone").value.trim() : "";
        const newPass = byId("profile-new-password") ? byId("profile-new-password").value : "";

        if (matricula && matricula.length !== 12) {
            showToast("A Matrícula UERJ deve ter exatamente 12 dígitos.", "error");
            return;
        }
        if (cpf && !isValidCpf(cpf)) {
            showToast("CPF inválido. Confira os números digitados.", "error");
            return;
        }
        if (newPass && newPass.length < 8) {
            showToast("A nova senha deve ter pelo menos 8 caracteres.", "error");
            return;
        }

        try {
            if (name && name !== currentUser.displayName) {
                await updateProfile(currentUser, { displayName: name });
            }
            userProfile = { name: name, matricula: matricula, cpf: cpf, phone: phone };
            await saveUserProfileData();

            if (newPass) {
                await updatePassword(currentUser, newPass);
                if (byId("profile-new-password")) byId("profile-new-password").value = "";
                showToast("Perfil e nova senha salvos com sucesso!");
            } else {
                showToast("Dados do perfil atualizados com sucesso!");
            }
            updateAuthUI();
        } catch (err) {
            console.error("Erro ao atualizar perfil:", err);
            if (err.code === "auth/requires-recent-login") {
                showToast("Para trocar a senha, saia e entre novamente na conta por segurança.", "error");
            } else {
                showToast("Não foi possível salvar os dados. Tente novamente.", "error");
            }
        }
    });

    on("btn-checkout", "click", async function () {
        if (cart.length === 0) return;

        if (!isRegisteredUser()) {
            closeCartSidebar();
            openAuthModal();
            showToast("Faça login ou cadastre-se para finalizar o pedido.", "error");
            return;
        }

        // Pagamento so com e-mail confirmado (o Worker tambem exige)
        if (!(await isEmailVerified())) {
            closeCartSidebar();
            openVerifyModal();
            return;
        }

        openCheckout();
    });

    on("close-verify", "click", function () { closeModal("verify"); });

    on("btn-verify-done", "click", async function () {
        const btn = byId("btn-verify-done");
        if (btn) btn.disabled = true;
        try {
            if (await isEmailVerified()) {
                closeModal("verify");
                showToast("E-mail confirmado! Vamos finalizar seu pedido.");
                if (cart.length > 0) setTimeout(openCheckout, 220);
            } else {
                showToast("Ainda não encontramos a confirmação. Abra o link do e-mail e tente de novo.", "error");
            }
        } finally {
            if (btn) btn.disabled = false;
        }
    });

    on("btn-verify-resend", "click", async function () {
        if (!isRegisteredUser()) return;
        const wait = Math.ceil((verifyResendAvailableAt - Date.now()) / 1000);
        if (wait > 0) {
            showToast("Aguarde " + wait + "s para reenviar.", "error");
            return;
        }
        try {
            await sendEmailVerification(currentUser, VERIFY_EMAIL_SETTINGS);
            verifyResendAvailableAt = Date.now() + 60000;
            showToast("Link reenviado para " + currentUser.email + ". Confira também o spam.");
        } catch (err) {
            if (err && err.code === "auth/too-many-requests") {
                showToast("Muitos envios seguidos. Aguarde alguns minutos.", "error");
            } else {
                showToast("Não foi possível reenviar agora. Tente em instantes.", "error");
            }
        }
    });

    function openCheckout() {
        stopPixPolling();
        activeOrderId = null;
        refreshCartPrices();
        const baseSubtotal = getCartBaseSubtotal();
        buildInstallmentsDropdown(baseSubtotal);

        if (userProfile.matricula && byId("checkout-matricula")) byId("checkout-matricula").value = userProfile.matricula;
        if (userProfile.cpf && byId("checkout-cpf")) byId("checkout-cpf").value = userProfile.cpf;
        if (userProfile.phone && byId("checkout-phone")) byId("checkout-phone").value = userProfile.phone;

        if (byId("pix-qrcode-box")) byId("pix-qrcode-box").classList.add("hidden");
        if (byId("btn-submit-payment")) byId("btn-submit-payment").classList.remove("hidden");

        window.selectPaymentMethod("pix");
        closeCartSidebar();
        showModal("checkout");
    }

    on("card-installments", "change", updateCheckoutTotalsUI);

    on("btn-copy-pix", "click", function () {
        const input = byId("pix-copia-cola");
        if (input) {
            navigator.clipboard.writeText(input.value);
            showToast("Código PIX Copia e Cola copiado!");
        }
    });

    // Submit Checkout (PIX e Cartao via Cloudflare Worker)
    on("checkout-form", "submit", async function (e) {
        e.preventDefault();
        if (cart.length === 0) return;
        if (!isRegisteredUser()) {
            openAuthModal();
            return;
        }

        const matricula = byId("checkout-matricula") ? byId("checkout-matricula").value.replace(/\D/g, "") : "";
        const cpf = byId("checkout-cpf") ? byId("checkout-cpf").value.replace(/\D/g, "") : "";
        const phone = byId("checkout-phone") ? byId("checkout-phone").value.trim() : "";

        if (matricula.length !== 12) {
            showToast("A Matrícula UERJ deve conter exatamente 12 números (Ex: 202610123456).", "error");
            return;
        }
        if (!isValidCpf(cpf)) {
            showToast("Digite um CPF válido com 11 dígitos.", "error");
            return;
        }
        if (phone.replace(/\D/g, "").length < 10) {
            showToast("Digite um WhatsApp válido com DDD.", "error");
            return;
        }

        const fallbackName = (currentUser && currentUser.displayName)
            ? currentUser.displayName
            : (userProfile.name ? userProfile.name : "Aluno FurioZOs");

        userProfile = {
            name: fallbackName,
            matricula: matricula,
            cpf: maskCPF(cpf),
            phone: phone
        };
        try {
            await saveUserProfileData();
        } catch (profileErr) {
            console.warn("Perfil:", profileErr);
        }

        const btnSubmit = byId("btn-submit-payment");
        const customerPayload = { name: fallbackName.trim(), matricula: matricula, cpf: cpf, phone: phone };
        const itemsPayload = buildCheckoutItems();

        if (selectedPaymentMethod === "pix") {
            if (btnSubmit) {
                btnSubmit.disabled = true;
                btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Gerando PIX Oficial...';
            }

            try {
                const res = await callWorker("/checkout", "POST", {
                    items: itemsPayload,
                    customer: customerPayload,
                    payment: { method: "pix" }
                });

                const pix = res.data ? res.data.pix : null;
                if (!res.ok || !pix || !pix.qrCode) {
                    const detailMsg = translateMpRejectReason(res.data ? res.data.statusDetail : "", res.data ? res.data.message : "");
                    showToast("Não foi possível gerar o PIX: " + detailMsg, "error");
                    return;
                }

                activeOrderId = res.data.orderId;
                if (byId("checkout-total-display")) byId("checkout-total-display").textContent = formatPrice(res.data.total);

                const qrImgEl = byId("pix-qr-img");
                if (qrImgEl) {
                    if (pix.qrCodeBase64) {
                        qrImgEl.src = "data:image/png;base64," + pix.qrCodeBase64;
                        qrImgEl.classList.remove("hidden");
                    } else {
                        // Sem imagem: use apenas o Copia e Cola (nao enviamos o codigo a terceiros)
                        qrImgEl.removeAttribute("src");
                        qrImgEl.classList.add("hidden");
                    }
                }

                if (byId("pix-copia-cola")) byId("pix-copia-cola").value = pix.qrCode;
                if (byId("pix-qrcode-box")) byId("pix-qrcode-box").classList.remove("hidden");
                if (btnSubmit) btnSubmit.classList.add("hidden");
                showToast("QR Code PIX oficial gerado! Escaneie ou use o Copia e Cola no seu banco.");

                stopPixPolling();
                pixPollingInterval = setInterval(function () {
                    checkOrderStatus(activeOrderId, true);
                }, 5000);

                const verifyBtn = byId("btn-verify-pix-now");
                if (verifyBtn) {
                    verifyBtn.onclick = function () {
                        checkOrderStatus(activeOrderId, false);
                    };
                }
            } catch (err) {
                console.error("Erro PIX Mercado Pago:", err);
                showToast("Erro de conexão com o servidor de pagamento. Tente novamente.", "error");
            } finally {
                if (btnSubmit) {
                    btnSubmit.disabled = false;
                    btnSubmit.textContent = "Gerar QR Code PIX";
                }
            }
        } else {
            const cardNumber = byId("card-number") ? byId("card-number").value.replace(/\D/g, "") : "";
            const cardHolder = byId("card-holder") ? byId("card-holder").value.trim() : "";
            const cardExpiry = byId("card-expiry") ? byId("card-expiry").value.trim() : "";
            const cardCvv = byId("card-cvv") ? byId("card-cvv").value.replace(/\D/g, "") : "";
            const rawInst = byId("card-installments") ? byId("card-installments").value : "1";
            const installments = parseInt(rawInst ? rawInst : "1", 10);

            const expParts = cardExpiry.split("/");
            const expMonth = expParts[0];
            const expYearShort = expParts[1];
            if (cardNumber.length < 13 || !cardHolder || !expMonth || !expYearShort || cardCvv.length < 3) {
                showToast("Preencha todos os dados do cartão corretamente.", "error");
                return;
            }

            if (btnSubmit) {
                btnSubmit.disabled = true;
                btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Processando Cartão...';
            }

            try {
                if (!mpInstance && typeof window.MercadoPago !== "undefined") {
                    mpInstance = new window.MercadoPago(MERCADO_PAGO_CONFIG.publicKey, { locale: "pt-BR" });
                }
                if (!mpInstance) {
                    showToast("SDK do Mercado Pago ainda carregando. Tente novamente.", "error");
                    return;
                }

                // 1. Identifica a bandeira (visa, master, elo, etc.) e banco emissor pelos 6 primeiros digitos
                const binInfo = await detectCardMethodAndIssuer(cardNumber);

                // 2. Gera o Token seguro do cartao via SDK Mercado Pago (o numero nunca vai ao nosso servidor)
                const expYearFull = expYearShort.length === 2 ? ("20" + expYearShort) : expYearShort;
                const tokenResponse = await mpInstance.createCardToken({
                    cardNumber: cardNumber,
                    cardholderName: cardHolder,
                    cardExpirationMonth: expMonth,
                    cardExpirationYear: expYearFull,
                    securityCode: cardCvv,
                    identificationType: "CPF",
                    identificationNumber: cpf
                });

                if (!tokenResponse || !tokenResponse.id) {
                    showToast("Dados do cartão inválidos. Verifique número, validade e CVV.", "error");
                    return;
                }

                // 3. O Worker recalcula o total, cria o pedido e cobra no Mercado Pago
                const res = await callWorker("/checkout", "POST", {
                    items: itemsPayload,
                    customer: customerPayload,
                    payment: {
                        method: "card",
                        token: tokenResponse.id,
                        installments: installments,
                        paymentMethodId: binInfo.paymentMethodId,
                        issuerId: binInfo.issuerId ? String(binInfo.issuerId) : ""
                    }
                });

                if (!res.ok) {
                    showToast("Pagamento não processado: " + translateMpRejectReason(res.data ? res.data.statusDetail : "", res.data ? res.data.message : ""), "error");
                    return;
                }

                const status = res.data.status;
                if (status === ORDER_STATUS.PAID) {
                    await handleOrderConfirmed(res.data.order);
                } else if (status === ORDER_STATUS.REVIEW || status === ORDER_STATUS.PENDING) {
                    await handleOrderUnderReview(res.data.order);
                } else {
                    showToast("Cartão recusado: " + translateMpRejectReason(res.data.statusDetail, ""), "error");
                }
            } catch (cardErr) {
                console.error("Erro no processamento do cartão:", cardErr);
                showToast("Não foi possível validar o cartão. Verifique o número, validade e CVV.", "error");
            } finally {
                if (btnSubmit) {
                    btnSubmit.disabled = false;
                    btnSubmit.textContent = "Pagar com Cartão";
                }
            }
        }
    });

    on("btn-export-excel", "click", function () {
        if (!isCurrentUserAdmin()) return;
        if (typeof XLSX === "undefined") {
            showToast("Biblioteca Excel ainda carregando. Tente novamente.", "error");
            return;
        }
        if (ordersList.length === 0) {
            showToast("Não há pedidos registrados para exportar.", "error");
            return;
        }

        const factoryRows = [];
        const financialRows = [];

        for (let i = 0; i < ordersList.length; i++) {
            const order = ordersList[i];
            const dateStr = order.createdAtISO ? new Date(order.createdAtISO).toLocaleString("pt-BR") : "";
            const matriculaStr = order.customerMatricula ? order.customerMatricula : (order.customerCourse ? order.customerCourse : "");
            const subVal = order.subtotal ? order.subtotal : (order.total ? order.total : 0);
            const feeVal = order.installmentFee ? order.installmentFee : 0;
            const totVal = order.total ? order.total : 0;

            const finRow = {};
            finRow["ID Pedido"] = order.orderId ? order.orderId : "";
            finRow["ID Transação MP"] = order.mpPaymentId ? order.mpPaymentId : "";
            finRow["Data"] = dateStr;
            finRow["Aluno"] = order.customerName ? order.customerName : "";
            finRow["Matrícula UERJ"] = matriculaStr;
            finRow["E-mail"] = order.customerEmail ? order.customerEmail : "";
            finRow["WhatsApp"] = order.customerPhone ? order.customerPhone : "";
            finRow["CPF"] = order.customerCpf ? order.customerCpf : "";
            finRow["Método Pagamento"] = order.paymentMethod ? order.paymentMethod : "";
            finRow["Status"] = order.status ? order.status : "";
            finRow["Subtotal Produtos"] = Number(subVal);
            finRow["Taxa Parcelamento"] = Number(feeVal);
            finRow["Valor Total Pago"] = Number(totVal);
            financialRows.push(finRow);

            // A fabrica so recebe itens de pedidos efetivamente pagos
            if (order.status !== ORDER_STATUS.PAID) continue;

            const itemsArr = order.items ? order.items : [];
            for (let j = 0; j < itemsArr.length; j++) {
                const item = itemsArr[j];
                const qtyNum = Number(item.quantity ? item.quantity : 1);
                const priceNum = Number(item.price ? item.price : 0);
                const facRow = {};
                facRow["ID Pedido"] = order.orderId ? order.orderId : "";
                facRow["Data"] = dateStr;
                facRow["Aluno"] = order.customerName ? order.customerName : "";
                facRow["Matrícula UERJ"] = matriculaStr;
                facRow["WhatsApp"] = order.customerPhone ? order.customerPhone : "";
                facRow["Produto"] = item.name ? item.name : "";
                facRow["Tamanho"] = item.size ? item.size : "Único";
                facRow["Nome Personalizado (Costas)"] = item.customName ? item.customName : "SEM NOME";
                facRow["Número (Costas)"] = item.customNumber ? item.customNumber : "SEM NÚMERO";
                facRow["Modalidade Entrega"] = item.deliveryMode === "imediata" ? "PRONTA ENTREGA" : "LOTE (ENCOMENDA)";
                facRow["Quantidade"] = qtyNum;
                facRow["Valor Unitário"] = priceNum;
                facRow["Subtotal Item"] = Number(priceNum * qtyNum);
                facRow["Status Pagamento"] = order.status;
                factoryRows.push(facRow);
            }
        }

        const wb = XLSX.utils.book_new();
        const wsFactory = XLSX.utils.json_to_sheet(factoryRows);
        const wsFinancial = XLSX.utils.json_to_sheet(financialRows);

        XLSX.utils.book_append_sheet(wb, wsFactory, "Itens_Para_Fabrica");
        XLSX.utils.book_append_sheet(wb, wsFinancial, "Resumo_Financeiro");

        const fileName = "Relatorio_Pedidos_FurioZOs_" + new Date().toISOString().slice(0, 10) + ".xlsx";
        XLSX.writeFile(wb, fileName);
        showToast("Relatório Excel (.xlsx) gerado com sucesso!");
    });
}

async function bootstrapApp() {
    renderProducts();
    updateCartUI();
    bindAllEvents();

    try {
        new Swiper(".mySwiper", {
            loop: true,
            grabCursor: true,
            autoplay: { delay: 5000, disableOnInteraction: false },
            navigation: { nextEl: "#next-slide", prevEl: "#prev-slide" }
        });
    } catch (swErr) {
        console.warn("Swiper principal:", swErr);
    }

    if (auth) {
        onAuthStateChanged(auth, async function (user) {
            // Sessoes anonimas da versao antiga sao encerradas: visitantes
            // navegam sem login e o carrinho fica salvo so no navegador.
            if (user && user.isAnonymous) {
                try {
                    await signOut(auth);
                } catch (e) {}
                return;
            }

            currentUser = user ? user : null;
            await refreshAdminFlag();
            if (currentUser) {
                await loadUserProfileData();
            } else {
                userProfile = { name: "", matricula: "", cpf: "", phone: "" };
            }
            updateAuthUI();
            await loadCartData();
            await loadInitialData();
        });
    } else {
        await loadInitialData();
    }
}

bootstrapApp();
