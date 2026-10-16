// public/assets/js/main.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
    getAuth,
    signInAnonymously,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    updateProfile,
    updatePassword,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    getDocs,
    collection,
    addDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import Swiper from "https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.mjs";

// ============================================================================
// 1. CONFIGURACOES DO FIREBASE, ADMIN E MERCADO PAGO (VIA CLOUDFLARE WORKER)
// ============================================================================
const appId = "furiozos-app";
const CURRENCY_PREFIX = "R\x24 ";

const firebaseConfig = {
    apiKey: "AIzaSyDq8DjGLsN_yLlTP2brfyhfLgU23ROP38M",
    authDomain: "atletica-furiozos.firebaseapp.com",
    projectId: "atletica-furiozos",
    storageBucket: "atletica-furiozos.firebasestorage.app",
    messagingSenderId: "968429095494",
    appId: "1:968429095494:web:16c2514234a7a2ac4bd847",
    measurementId: "G-P39HJJCQLN"
};

const ADMIN_EMAILS = [
    "giorgiocsbazet@gmail.com"
];

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
    publicKey: "APP_USR-0ec36817-11d7-4726-a2e8-7dbf09bda36e",
    atleticaWhatsapp: "5521999999999",
    atleticaEmail: "giorgiocsbazet@gmail.com"
};

let app = null;
let db = null;
let auth = null;
let mpInstance = null;

try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
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
        images: ["assets/img/bandana.jpg"],
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
let userProfile = { name: "", matricula: "", cpf: "", phone: "" };
let cart = [];
let modalSwiperInstance = null;

let selectedProduct = null;
let selectedSize = null;
let selectedDeliveryMode = "lote";
let selectedPaymentMethod = "pix";
let activePixPaymentId = null;
let pixPollingInterval = null;
let authMode = "login";

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
    const icon = isErr ? "fa-triangle-exclamation" : "fa-check-circle";
    toast.innerHTML = '<i class="fa-solid ' + icon + '"></i> <span>' + message + '</span>';
    container.appendChild(toast);
    setTimeout(function () {
        toast.remove();
    }, 4000);
}

function isCurrentUserAdmin() {
    if (!currentUser) return false;
    if (currentUser.isAnonymous) return false;
    if (!currentUser.email) return false;
    return ADMIN_EMAILS.indexOf(currentUser.email.trim().toLowerCase()) !== -1;
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
function renderProducts() {
    const grid = byId("product-grid");
    if (!grid) return;

    const htmlList = [];
    for (let i = 0; i < productsCatalog.length; i++) {
        const p = productsCatalog[i];
        const isAvailable = p.status === "disponivel";
        const isComingSoon = p.status === "em_breve";
        const isSoldOut = p.status === "esgotado";

        let topBadge = "";
        if (p.id === "p2" && isAvailable) {
            topBadge = '<div class="absolute top-4 left-4 bg-[#ccff00] text-furiozo-dark text-xs font-black px-3 py-1 rounded-full z-20 shadow-md transform -rotate-6">OFICIAL • 1º LOTE</div>';
        } else if (isComingSoon) {
            topBadge = '<div class="absolute top-4 right-4 bg-furiozo-dark/90 text-[#ccff00] border border-[#ccff00] text-[11px] font-black px-3 py-1 rounded-full z-20 shadow-md uppercase tracking-wider">Em Breve</div>';
        } else if (isSoldOut) {
            topBadge = '<div class="absolute top-4 right-4 bg-red-600 text-white text-[11px] font-black px-3 py-1 rounded-full z-20 shadow-md uppercase tracking-wider">Esgotado</div>';
        }

        const clickAction = isAvailable
            ? "window.openProductModal('" + p.id + "')"
            : "window.notifyUnavailableProduct('" + p.status + "')";

        let priceAreaHTML = "";
        if (isComingSoon) {
            priceAreaHTML =
                '<div class="relative flex items-center">' +
                    '<span class="font-black text-2xl text-gray-300 blur-[5px] select-none pointer-events-none">' + CURRENCY_PREFIX + '00,00</span>' +
                    '<span class="absolute left-0 inline-flex items-center gap-1.5 bg-furiozo-dark text-[#ccff00] border-2 border-[#ccff00] px-3.5 py-1.5 rounded-xl font-sport font-black text-xs uppercase tracking-widest shadow-md">' +
                        '<i class="fa-solid fa-clock"></i> EM BREVE' +
                    '</span>' +
                '</div>';
        } else if (isSoldOut) {
            priceAreaHTML =
                '<span class="inline-flex items-center gap-1.5 bg-red-100 text-red-700 border border-red-300 px-3.5 py-1.5 rounded-xl font-sport font-black text-xs uppercase tracking-widest">' +
                    'ESGOTADO' +
                '</span>';
        } else {
            priceAreaHTML = '<span class="font-black text-3xl text-gray-900 tracking-tighter">' + formatPrice(p.price) + '</span>';
        }

        const actionBtnHTML = isAvailable
            ? '<button type="button" onclick="' + clickAction + '" class="bg-furiozo-dark text-[#ccff00] w-12 h-12 rounded-full flex items-center justify-center group-hover:bg-[#ccff00] group-hover:text-furiozo-dark transition-all shadow-md transform active:scale-95 border border-transparent group-hover:border-furiozo-dark" title="Personalizar e Comprar"><i class="fa-solid fa-plus text-xl"></i></button>'
            : '<button type="button" onclick="' + clickAction + '" class="bg-gray-200 text-gray-500 w-12 h-12 rounded-full flex items-center justify-center cursor-not-allowed opacity-75" title="Indisponível no momento"><i class="fa-solid fa-lock text-base"></i></button>';

        const cardHoverClass = isAvailable
            ? "hover:shadow-[0_10px_30px_rgba(204,255,0,0.25)] hover:border-[#ccff00]/60 transform hover:-translate-y-2"
            : "opacity-85";
        const cursorClass = isAvailable ? "cursor-pointer" : "cursor-not-allowed";
        const imgEffectClass = isAvailable ? "group-hover:scale-105" : "grayscale-[35%]";
        const titleHoverClass = isAvailable ? "cursor-pointer group-hover:text-[#8A9A4A]" : "";
        const customTagHTML = (p.isShirt && isAvailable)
            ? '<span class="text-[11px] font-bold text-[#8A9A4A] uppercase tracking-wider mt-1"><i class="fa-solid fa-wand-magic-sparkles mr-1"></i>Personalizável (Nome/Nº)</span>'
            : "";

        const imgUrl = (p.images && p.images.length > 0) ? p.images[0] : "assets/img/logo-atletica.jpg";

        htmlList.push(
            '<div class="bg-white rounded-[2rem] shadow-md overflow-hidden ' + cardHoverClass + ' transition-all duration-300 flex flex-col border-2 border-transparent relative group">' +
                topBadge +
                '<div class="relative pb-[100%] ' + cursorClass + ' overflow-hidden bg-gray-100" onclick="' + clickAction + '">' +
                    '<img src="' + imgUrl + '" onerror="this.src=\'https://placehold.co/500x500/1F4229/ccff00?text=FurioZOs\'" alt="' + p.name + '" class="absolute inset-0 w-full h-full object-cover ' + imgEffectClass + ' transition-transform duration-500">' +
                '</div>' +
                '<div class="p-6 flex flex-col flex-grow">' +
                    '<h3 class="font-sport text-lg text-furiozo-dark font-black uppercase mb-1 flex-grow ' + titleHoverClass + ' transition-colors leading-tight tracking-tight" onclick="' + clickAction + '">' +
                        p.name +
                    '</h3>' +
                    customTagHTML +
                    '<div class="flex justify-between items-center mt-4 pt-2 border-t border-gray-100">' +
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

    const customName = rawName.trim().toUpperCase().slice(0, 10);
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

    const cleanName = nameEl.value.toUpperCase().slice(0, 10);
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
            btnImmediate.classList.remove("border-furiozo-dark", "bg-furiozo-accent/40");
            btnImmediate.classList.add("border-gray-200", "bg-white");
        }
        if (btnBatch) {
            btnBatch.classList.add("border-furiozo-dark", "bg-furiozo-accent/40");
            btnBatch.classList.remove("border-gray-200", "bg-white");
        }

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

        if (selectedDeliveryMode === "imediata") {
            if (btnImmediate) {
                btnImmediate.classList.add("border-furiozo-dark", "bg-furiozo-accent/40");
                btnImmediate.classList.remove("border-gray-200", "bg-white");
            }
            if (btnBatch) {
                btnBatch.classList.remove("border-furiozo-dark", "bg-furiozo-accent/40");
                btnBatch.classList.add("border-gray-200", "bg-white");
            }
        } else {
            if (btnBatch) {
                btnBatch.classList.add("border-furiozo-dark", "bg-furiozo-accent/40");
                btnBatch.classList.remove("border-gray-200", "bg-white");
            }
            if (btnImmediate) {
                btnImmediate.classList.remove("border-furiozo-dark", "bg-furiozo-accent/40");
                btnImmediate.classList.add("border-gray-200", "bg-white");
            }
        }
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
    selectedDeliveryMode = mode;
    evaluateDeliveryAndPrice();
};

window.openProductModal = function (id) {
    selectedProduct = null;
    for (let i = 0; i < productsCatalog.length; i++) {
        if (productsCatalog[i].id === id) {
            selectedProduct = productsCatalog[i];
            break;
        }
    }

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
                '<div class="swiper-slide flex items-center justify-center p-4">' +
                    '<img src="' + imgs[i] + '" onerror="this.src=\'https://placehold.co/500x500/1F4229/ccff00?text=FurioZOs\'" alt="Produto" class="max-w-full max-h-[260px] md:max-h-[380px] object-contain drop-shadow-md rounded-xl">' +
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
                '<button type="button" onclick="window.selectSize(\'' + s + '\', this)" class="size-btn px-3 min-w-[2.5rem] h-10 rounded-full border-2 border-gray-300 font-bold text-gray-600 hover:border-[#ccff00] hover:text-furiozo-dark transition-all focus:outline-none flex items-center justify-center text-sm">' +
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
        allBtns[i].classList.remove("bg-[#ccff00]", "text-furiozo-dark", "border-[#ccff00]");
        allBtns[i].classList.add("border-gray-300", "text-gray-600");
    }
    if (btnElement) {
        btnElement.classList.remove("border-gray-300", "text-gray-600");
        btnElement.classList.add("bg-[#ccff00]", "text-furiozo-dark", "border-[#ccff00]");
    }
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
    const emptyMsg = byId("empty-cart-msg");
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
        totalValue += itemTotal;

        const customBadges = [];
        if (item.customName) {
            customBadges.push('<span class="bg-furiozo-accent text-furiozo-dark px-2 py-0.5 rounded font-bold text-[10px]">Nome: ' + item.customName + '</span>');
        }
        if (item.customNumber) {
            customBadges.push('<span class="bg-furiozo-accent text-furiozo-dark px-2 py-0.5 rounded font-bold text-[10px]">Nº: ' + item.customNumber + '</span>');
        }

        const deliveryBadge = item.deliveryMode === "imediata"
            ? '<span class="bg-[#ccff00] text-furiozo-dark px-2 py-0.5 rounded font-black text-[10px] uppercase"><i class="fa-solid fa-bolt mr-1"></i>Pronta Entrega</span>'
            : '<span class="bg-gray-100 text-gray-700 px-2 py-0.5 rounded font-bold text-[10px] uppercase">Pedido em Lote</span>';

        rows.push(
            '<div class="flex gap-3 bg-white p-3.5 rounded-2xl shadow-sm border border-gray-100">' +
                '<img src="' + item.img + '" onerror="this.src=\'https://placehold.co/150x150/1F4229/ccff00?text=FurioZOs\'" class="w-20 h-20 object-cover rounded-xl border border-gray-200 shrink-0">' +
                '<div class="flex-grow flex flex-col justify-between">' +
                    '<div class="flex justify-between items-start gap-2">' +
                        '<h4 class="font-bold text-sm text-gray-800 leading-tight">' + item.name + '</h4>' +
                        '<button type="button" onclick="window.removeFromCart(\'' + item.cartItemId + '\')" class="text-gray-400 hover:text-red-500 transition-colors"><i class="fa-solid fa-trash"></i></button>' +
                    '</div>' +
                    '<p class="text-xs text-gray-500 font-semibold mt-0.5">Tam: <strong class="text-gray-800">' + item.size + '</strong> • Unit: ' + formatPrice(item.price) + '</p>' +
                    '<div class="flex flex-wrap gap-1 my-1.5">' + customBadges.join("") + deliveryBadge + '</div>' +
                    '<div class="flex justify-between items-center mt-1">' +
                        '<div class="flex items-center border border-gray-200 rounded-lg px-2 py-0.5 bg-gray-50">' +
                            '<button type="button" onclick="window.updateQuantity(\'' + item.cartItemId + '\', -1)" class="text-gray-500 hover:text-furiozo-dark px-1"><i class="fa-solid fa-minus text-[10px]"></i></button>' +
                            '<span class="mx-2 text-xs font-bold w-4 text-center">' + item.quantity + '</span>' +
                            '<button type="button" onclick="window.updateQuantity(\'' + item.cartItemId + '\', 1)" class="text-gray-500 hover:text-furiozo-dark px-1"><i class="fa-solid fa-plus text-[10px]"></i></button>' +
                        '</div>' +
                        '<span class="font-black text-furiozo-dark text-sm">' + formatPrice(itemTotal) + '</span>' +
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
    const qty = isNaN(rawQty) ? 1 : rawQty;

    if (selectedProduct.hasSize && !selectedSize) {
        if (byId("size-error")) byId("size-error").classList.remove("hidden");
        return;
    }

    const state = getCustomizationState();
    const deliveryFee = selectedDeliveryMode === "imediata" ? PRICING_RULES.IMMEDIATE_DELIVERY_FEE : 0;
    const stockVal = selectedProduct.immediateStock ? Number(selectedProduct.immediateStock) : 0;

    if (selectedDeliveryMode === "imediata" && qty > stockVal) {
        showToast("Apenas " + stockVal + " unid. disponíveis para pronta entrega.", "error");
        return;
    }

    const finalUnitPrice = Number(selectedProduct.price) + state.customFee + deliveryFee;
    const sizeKey = selectedSize ? selectedSize : "unico";
    const nameKey = state.customName ? state.customName : "semnome";
    const numKey = state.customNumber ? state.customNumber : "semnum";
    const uniqueKey = [selectedProduct.id, sizeKey, nameKey, numKey, selectedDeliveryMode].join("-");

    const cartItem = {
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
    };

    let foundIndex = -1;
    for (let i = 0; i < cart.length; i++) {
        if (cart[i].cartItemId === cartItem.cartItemId) {
            foundIndex = i;
            break;
        }
    }

    if (foundIndex > -1) {
        cart[foundIndex].quantity += qty;
    } else {
        cart.push(cartItem);
    }

    updateCartUI();
    closeModal("product");
    showToast(qty + "x " + selectedProduct.name + " adicionado ao carrinho!");
    await saveCartData();
    setTimeout(openCartSidebar, 250);
};

window.removeFromCart = async function (cartItemId) {
    const nextCart = [];
    for (let i = 0; i < cart.length; i++) {
        if (cart[i].cartItemId !== cartItemId) {
            nextCart.push(cart[i]);
        }
    }
    cart = nextCart;
    updateCartUI();
    await saveCartData();
};

window.updateQuantity = async function (cartItemId, delta) {
    for (let i = 0; i < cart.length; i++) {
        if (cart[i].cartItemId === cartItemId) {
            cart[i].quantity += delta;
            if (cart[i].quantity <= 0) {
                await window.removeFromCart(cartItemId);
            } else {
                updateCartUI();
                await saveCartData();
            }
            break;
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
    selectedPaymentMethod = method;
    const tabPix = byId("tab-pay-pix");
    const tabCard = byId("tab-pay-card");
    const panelPix = byId("payment-pix-panel");
    const panelCard = byId("payment-card-panel");
    const btnSubmit = byId("btn-submit-payment");
    const qrBox = byId("pix-qrcode-box");

    if (method === "pix") {
        if (tabPix) tabPix.className = "p-4 rounded-2xl border-2 border-furiozo-dark bg-furiozo-accent/50 font-black text-furiozo-dark flex flex-col items-center justify-center gap-1 transition-all shadow-sm";
        if (tabCard) tabCard.className = "p-4 rounded-2xl border-2 border-gray-200 bg-white font-bold text-gray-600 flex flex-col items-center justify-center gap-1 transition-all";
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
        if (tabCard) tabCard.className = "p-4 rounded-2xl border-2 border-furiozo-dark bg-furiozo-accent/50 font-black text-furiozo-dark flex flex-col items-center justify-center gap-1 transition-all shadow-sm";
        if (tabPix) tabPix.className = "p-4 rounded-2xl border-2 border-gray-200 bg-white font-bold text-gray-600 flex flex-col items-center justify-center gap-1 transition-all";
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

async function callMercadoPagoApi(path, method, bodyObj) {
    const baseUrl = String(MERCADO_PAGO_CONFIG.workerUrl ? MERCADO_PAGO_CONFIG.workerUrl : "").replace(/\/+$/, "");
    if (!baseUrl || baseUrl.indexOf("SEU-SUBDOMINIO") !== -1) {
        return {
            ok: false,
            status: 400,
            data: { message: "Cole a URL do seu Cloudflare Worker na linha 61 do arquivo main.js!" }
        };
    }

    const headers = {
        "Content-Type": "application/json"
    };
    if (method === "POST") {
        headers["X-Idempotency-Key"] = "fz-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    }

    const fetchOptions = {
        method: method,
        headers: headers,
        body: bodyObj ? JSON.stringify(bodyObj) : undefined
    };

    const res = await fetch(baseUrl + path, fetchOptions);
    const data = await res.json();
    return { ok: res.ok, status: res.status, data: data };
}

function stopPixPolling() {
    if (pixPollingInterval) {
        clearInterval(pixPollingInterval);
        pixPollingInterval = null;
    }
}

async function checkPixPaymentStatus(paymentId, checkoutMeta, silent) {
    if (!paymentId) return;
    try {
        const res = await callMercadoPagoApi("/v1/payments/" + paymentId, "GET", null);
        if (res.ok && res.data && res.data.status === "approved") {
            stopPixPolling();
            const statusInd = byId("pix-status-indicator");
            if (statusInd) {
                statusInd.innerHTML = '<i class="fa-solid fa-circle-check text-green-600"></i> Pagamento Aprovado pelo Banco!';
            }
            await finalizeOrderRecord({
                matricula: checkoutMeta.matricula,
                cpf: checkoutMeta.cpf,
                phone: checkoutMeta.phone,
                subtotalAmount: checkoutMeta.subtotalAmount,
                feeAmount: 0,
                totalAmount: checkoutMeta.totalAmount,
                installments: 1,
                paymentMethod: "PIX (Mercado Pago)",
                mpPaymentId: String(paymentId)
            });
        } else if (!silent) {
            showToast("O banco ainda aguarda a confirmação do PIX. Assim que pagar no app do banco, aguarde alguns segundos!", "error");
        }
    } catch (err) {
        if (!silent) showToast("Verificando status com o Mercado Pago...", "error");
    }
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
            ? '<span class="block text-[11px] text-[#8A9A4A] font-bold">Personalização: ' + nStr + ' • Nº ' + numStr + '</span>'
            : "";
        const itemSubtotal = formatPrice(Number(item.price) * Number(item.quantity));

        itemRows.push(
            '<div class="flex justify-between items-start py-1.5 border-b border-gray-200/70">' +
                '<div>' +
                    '<strong class="text-gray-800">' + item.quantity + 'x ' + item.name + ' (Tam: ' + item.size + ')</strong>' +
                    customStr +
                '</div>' +
                '<span class="font-bold text-furiozo-dark">' + itemSubtotal + '</span>' +
            '</div>'
        );
    }

    box.innerHTML =
        '<div class="flex justify-between items-center border-b border-gray-200 pb-2 mb-2">' +
            '<span class="font-black text-furiozo-dark uppercase">Pedido #' + order.orderId + '</span>' +
            '<span class="bg-green-100 text-green-800 font-black px-2 py-0.5 rounded text-[10px] uppercase">' + order.status + '</span>' +
        '</div>' +
        '<p><strong>Aluno:</strong> ' + order.customerName + '</p>' +
        '<p><strong>Matrícula UERJ:</strong> <span class="font-mono">' + order.customerMatricula + '</span></p>' +
        '<p><strong>Pagamento:</strong> ' + order.paymentMethod + '</p>' +
        '<div class="mt-2 pt-2 border-t border-gray-200">' + itemRows.join("") + '</div>' +
        '<div class="flex justify-between items-center pt-2 text-sm font-black text-furiozo-dark">' +
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
            window.location.href = "mailto:" + order.customerEmail + "?cc=" + MERCADO_PAGO_CONFIG.atleticaEmail + "&subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(msgText);
        };
    }

    showModal("receipt");
}

async function finalizeOrderRecord(params) {
    const uName = (currentUser && currentUser.displayName)
        ? currentUser.displayName
        : (userProfile.name ? userProfile.name : "Aluno FurioZOs");
    const uEmail = (currentUser && currentUser.email) ? currentUser.email : "sem-email@furiozos.com";

    const newOrder = {
        orderId: "FZ-" + Date.now().toString().slice(-6),
        mpPaymentId: params.mpPaymentId ? params.mpPaymentId : "",
        userId: currentUser ? currentUser.uid : "guest",
        customerName: uName,
        customerEmail: uEmail,
        customerPhone: params.phone,
        customerCpf: params.cpf,
        customerMatricula: params.matricula,
        items: cart.slice(),
        subtotal: params.subtotalAmount,
        installmentFee: params.feeAmount ? params.feeAmount : 0,
        installments: params.installments ? params.installments : 1,
        total: params.totalAmount,
        paymentMethod: params.paymentMethod,
        status: "Pago / Confirmado",
        createdAtISO: new Date().toISOString()
    };

    try {
        for (let i = 0; i < cart.length; i++) {
            const item = cart[i];
            if (item.deliveryMode === "imediata") {
                for (let j = 0; j < productsCatalog.length; j++) {
                    if (productsCatalog[j].id === item.id) {
                        const curStock = productsCatalog[j].immediateStock ? Number(productsCatalog[j].immediateStock) : 0;
                        productsCatalog[j].immediateStock = Math.max(0, curStock - Number(item.quantity));
                        await saveProductToFirestore(productsCatalog[j]);
                        break;
                    }
                }
            }
        }

        await saveOrderToFirestore(newOrder);

        cart = [];
        await saveCartData();
        updateCartUI();
        closeModal("checkout");
        renderProducts();
        updateBatchCountersUI();
        showToast("Pagamento aprovado! Pedido #" + newOrder.orderId + " confirmado.");
        setTimeout(function () {
            showOrderReceiptModal(newOrder);
        }, 250);
    } catch (error) {
        console.error("Erro ao registrar pedido:", error);
        showToast("Erro ao salvar pedido no banco.", "error");
    }
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
            productsCatalog = snap.docs.map(function (d) { return d.data(); });
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

    try {
        const ordersCol = collection(db, "artifacts", appId, "public", "data", "orders");
        const ordersSnap = await getDocs(ordersCol);
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

async function saveOrderToFirestore(order) {
    ordersList.unshift(order);
    if (!db) return;
    const ordersCol = collection(db, "artifacts", appId, "public", "data", "orders");
    await addDoc(ordersCol, Object.assign({}, order, { createdAt: serverTimestamp() }));
}

async function loadCartData() {
    const localKey = currentUser ? ("furiozos_cart_" + currentUser.uid) : "furiozos_cart_guest";
    try {
        const localSaved = localStorage.getItem(localKey);
        if (localSaved) {
            cart = JSON.parse(localSaved);
            updateCartUI();
        }
    } catch (e) {}

    if (!db || !currentUser) return;
    try {
        const cartRef = doc(db, "artifacts", appId, "users", currentUser.uid, "cart", "current");
        const docSnap = await getDoc(cartRef);
        if (docSnap.exists() && docSnap.data().items) {
            cart = docSnap.data().items;
            localStorage.setItem(localKey, JSON.stringify(cart));
            updateCartUI();
        }
    } catch (error) {
        console.warn("Carrinho local mantido:", error);
    }
}

async function saveCartData() {
    const localKey = currentUser ? ("furiozos_cart_" + currentUser.uid) : "furiozos_cart_guest";
    try {
        localStorage.setItem(localKey, JSON.stringify(cart));
    } catch (e) {}

    if (!db || !currentUser) return;
    try {
        const cartRef = doc(db, "artifacts", appId, "users", currentUser.uid, "cart", "current");
        await setDoc(cartRef, { items: cart, updatedAt: serverTimestamp() }, { merge: true });
    } catch (error) {
        console.warn("Carrinho salvo localmente:", error);
    }
}

async function loadUserProfileData() {
    if (!currentUser || currentUser.isAnonymous || !db) return;
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
    if (!currentUser || currentUser.isAnonymous || !db) return;
    try {
        const profRef = doc(db, "artifacts", appId, "users", currentUser.uid, "cart", "profile");
        await setDoc(profRef, Object.assign({}, userProfile, { updatedAt: serverTimestamp() }), { merge: true });
    } catch (err) {
        console.warn("Erro ao salvar perfil:", err);
    }
}

// ============================================================================
// 10. MODAL MEU PERFIL E MEUS PEDIDOS
// ============================================================================
function openProfileModal() {
    if (!currentUser || currentUser.isAnonymous) {
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
        if (btnData) btnData.className = "flex-1 py-2.5 text-xs font-black uppercase rounded-xl bg-white shadow-sm text-furiozo-dark transition-all";
        if (btnOrders) btnOrders.className = "flex-1 py-2.5 text-xs font-black uppercase rounded-xl text-gray-500 hover:text-furiozo-dark transition-all";
        if (formPanel) formPanel.classList.remove("hidden");
        if (ordersPanel) ordersPanel.classList.add("hidden");
    } else {
        if (btnOrders) btnOrders.className = "flex-1 py-2.5 text-xs font-black uppercase rounded-xl bg-white shadow-sm text-furiozo-dark transition-all";
        if (btnData) btnData.className = "flex-1 py-2.5 text-xs font-black uppercase rounded-xl text-gray-500 hover:text-furiozo-dark transition-all";
        if (formPanel) formPanel.classList.add("hidden");
        if (ordersPanel) ordersPanel.classList.remove("hidden");
        renderUserOrdersHistory();
    }
};

function renderUserOrdersHistory() {
    const container = byId("profile-orders-panel");
    if (!container || !currentUser) return;

    const myOrders = ordersList.filter(function (o) {
        return o.userId === currentUser.uid || o.customerEmail === currentUser.email;
    });

    if (myOrders.length === 0) {
        container.innerHTML =
            '<div class="text-center py-10 text-gray-400">' +
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
                ? " [Nome: " + nVal + " / Nº: " + numVal + "]"
                : "";
            itemLines.push('<div class="text-xs text-gray-700">• <strong>' + it.quantity + 'x ' + it.name + '</strong> (Tam: ' + it.size + ')' + customTag + '</div>');
        }

        html.push(
            '<div class="bg-gray-50 p-4 rounded-2xl border border-gray-200 space-y-2">' +
                '<div class="flex justify-between items-center">' +
                    '<span class="font-sport font-black text-sm text-furiozo-dark">Pedido #' + o.orderId + '</span>' +
                    '<span class="bg-green-100 text-green-800 text-[10px] font-black px-2.5 py-0.5 rounded-full uppercase">' + o.status + '</span>' +
                '</div>' +
                '<p class="text-[11px] text-gray-500">' + dateStr + ' • ' + o.paymentMethod + '</p>' +
                '<div class="space-y-1 pt-1 border-t border-gray-200">' + itemLines.join("") + '</div>' +
                '<div class="flex justify-between items-center pt-2 border-t border-gray-200">' +
                    '<span class="font-black text-furiozo-dark text-sm">Total: ' + formatPrice(o.total) + '</span>' +
                    '<button type="button" onclick="window.reopenOrderReceipt(\'' + o.orderId + '\')" class="text-xs font-bold text-green-700 hover:underline flex items-center gap-1">' +
                        '<i class="fa-brands fa-whatsapp"></i> Ver Comprovante' +
                    '</button>' +
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
function calculateBatchMetrics() {
    let totalShirtsInBatch = 0;
    let totalRevenue = 0;

    for (let i = 0; i < ordersList.length; i++) {
        const order = ordersList[i];
        totalRevenue += Number(order.total ? order.total : 0);
        const itemsArr = order.items ? order.items : [];
        for (let j = 0; j < itemsArr.length; j++) {
            const item = itemsArr[j];
            if (item.isShirt && item.deliveryMode === "lote") {
                totalShirtsInBatch += Number(item.quantity ? item.quantity : 0);
            }
        }
    }

    return { totalShirtsInBatch: totalShirtsInBatch, totalRevenue: totalRevenue, totalOrders: ordersList.length };
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
            const selDisp = p.status === "disponivel" ? "selected" : "";
            const selBreve = p.status === "em_breve" ? "selected" : "";
            const selEsg = p.status === "esgotado" ? "selected" : "";
            const stVal = p.immediateStock ? p.immediateStock : 0;

            prodRows.push(
                '<tr class="hover:bg-gray-50">' +
                    '<td class="py-3 px-3 font-bold text-furiozo-dark">' + p.name + '</td>' +
                    '<td class="py-3 px-3">' +
                        '<select id="admin-status-' + p.id + '" class="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs font-bold bg-white">' +
                            '<option value="disponivel" ' + selDisp + '>Disponível p/ Compra</option>' +
                            '<option value="em_breve" ' + selBreve + '>Selo "EM BREVE" (Ocultar Preço)</option>' +
                            '<option value="esgotado" ' + selEsg + '>Esgotado</option>' +
                        '</select>' +
                    '</td>' +
                    '<td class="py-3 px-3">' +
                        '<input type="number" step="0.50" id="admin-price-' + p.id + '" value="' + p.price + '" class="w-24 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs font-bold">' +
                    '</td>' +
                    '<td class="py-3 px-3">' +
                        '<input type="number" min="0" id="admin-stock-' + p.id + '" value="' + stVal + '" class="w-20 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-center">' +
                    '</td>' +
                    '<td class="py-3 px-3 text-right">' +
                        '<button type="button" onclick="window.saveAdminProduct(\'' + p.id + '\')" class="bg-furiozo-dark text-[#ccff00] hover:bg-[#ccff00] hover:text-furiozo-dark font-black px-3 py-1.5 rounded-lg text-xs uppercase transition-all">' +
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
                        ? " [Nome: <strong>" + nVal + "</strong> / Nº: <strong>" + numVal + "</strong>]"
                        : " [Sem personalização]";
                    itemSummaries.push('<div class="text-xs mb-1"><strong>' + it.quantity + 'x ' + it.name + '</strong> (Tam: ' + it.size + ')' + customStr + '</div>');

                    if (it.deliveryMode === "imediata") {
                        modeSummaries.push('<span class="inline-block bg-[#ccff00] text-furiozo-dark text-[10px] font-black px-2 py-0.5 rounded uppercase">Pronta Entrega</span>');
                    } else {
                        modeSummaries.push('<span class="inline-block bg-gray-100 text-gray-700 text-[10px] font-bold px-2 py-0.5 rounded uppercase">Lote</span>');
                    }
                }

                const oId = o.orderId ? o.orderId : "-";
                const matVal = o.customerMatricula ? o.customerMatricula : (o.customerCourse ? o.customerCourse : "-");
                const payVal = o.paymentMethod ? o.paymentMethod : "PIX";

                ordRows.push(
                    '<tr class="hover:bg-gray-50 align-top">' +
                        '<td class="py-3 px-2 text-xs text-gray-500 font-mono"><strong>#' + oId + '</strong><br>' + dateFormatted + '</td>' +
                        '<td class="py-3 px-2 text-xs">' +
                            '<strong class="text-gray-800">' + o.customerName + '</strong><br>' +
                            '<span class="font-mono text-[11px] text-furiozo-dark font-bold">Mat: ' + matVal + '</span><br>' +
                            '<span class="text-gray-500">' + o.customerPhone + '</span>' +
                        '</td>' +
                        '<td class="py-3 px-2">' + itemSummaries.join("") + '</td>' +
                        '<td class="py-3 px-2">' + modeSummaries.join("<br>") + '</td>' +
                        '<td class="py-3 px-2 text-xs font-bold text-teal-700">' + payVal + '<br><span class="text-[10px] text-green-600 uppercase">' + o.status + '</span></td>' +
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
    let prod = null;
    for (let i = 0; i < productsCatalog.length; i++) {
        if (productsCatalog[i].id === productId) {
            prod = productsCatalog[i];
            break;
        }
    }
    if (!prod) return;

    const statusEl = byId("admin-status-" + productId);
    const priceEl = byId("admin-price-" + productId);
    const stockEl = byId("admin-stock-" + productId);

    const newStatus = statusEl ? statusEl.value : prod.status;
    const newPrice = parseFloat(priceEl ? priceEl.value : String(prod.price));
    const rawStock = parseInt(stockEl ? stockEl.value : "0", 10);
    const newStock = isNaN(rawStock) ? 0 : rawStock;

    prod.status = newStatus;
    if (!isNaN(newPrice) && newPrice >= 0) prod.price = newPrice;
    prod.immediateStock = Math.max(0, newStock);

    await saveProductToFirestore(prod);
    renderProducts();
    renderAdminPanel();
    showToast('Produto "' + prod.name + '" atualizado na vitrine!');
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

function getModalElements(type) {
    if (type === "product") return { target: byId("product-modal"), content: byId("product-modal-content") };
    if (type === "checkout") return { target: byId("checkout-modal"), content: byId("checkout-modal-content") };
    if (type === "admin") return { target: byId("admin-modal"), content: byId("admin-modal-content") };
    if (type === "profile") return { target: byId("profile-modal"), content: byId("profile-modal-content") };
    if (type === "receipt") return { target: byId("receipt-modal"), content: byId("receipt-modal-content") };
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
        if (tabLogin) tabLogin.className = "flex-1 py-2 text-sm font-bold rounded-lg bg-white shadow-sm text-furiozo-dark transition-all";
        if (tabRegister) tabRegister.className = "flex-1 py-2 text-sm font-bold rounded-lg text-gray-500 hover:text-furiozo-dark transition-all bg-transparent";
        if (nameField) nameField.classList.add("hidden");
        if (extraFields) extraFields.classList.add("hidden");
        if (authName) authName.removeAttribute("required");
        if (btnSubmit) btnSubmit.textContent = "Entrar";
        if (authTitle) authTitle.textContent = "Acessar Conta";
    } else {
        if (tabRegister) tabRegister.className = "flex-1 py-2 text-sm font-bold rounded-md bg-white shadow-sm text-furiozo-dark transition-all";
        if (tabLogin) tabLogin.className = "flex-1 py-2 text-sm font-bold rounded-md text-gray-500 hover:text-furiozo-dark transition-all bg-transparent";
        if (nameField) nameField.classList.remove("hidden");
        if (extraFields) extraFields.classList.remove("hidden");
        if (authName) authName.setAttribute("required", "true");
        if (btnSubmit) btnSubmit.textContent = "Cadastrar";
        if (authTitle) authTitle.textContent = "Criar Conta";
    }
}

function updateAuthUI() {
    const isGuest = !currentUser || currentUser.isAnonymous;
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
function bindAllEvents() {
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
        if (input && parseInt(input.value, 10) < 10) input.value = String(parseInt(input.value, 10) + 1);
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
            showToast("Link de redefinição enviado para " + email + "! Verifique sua caixa de entrada e spam.");
            if (errEl) errEl.classList.add("hidden");
        } catch (err) {
            if (errEl) {
                errEl.classList.remove("hidden");
                errEl.textContent = "Não foi possível enviar o e-mail de recuperação. Verifique o endereço digitado.";
            }
        }
    });

    on("auth-form", "submit", async function (e) {
        e.preventDefault();
        const email = byId("auth-email") ? byId("auth-email").value.trim() : "";
        const pass = byId("auth-pass") ? byId("auth-pass").value : "";
        const name = byId("auth-name") ? byId("auth-name").value.trim() : "";
        const matricula = byId("auth-matricula") ? byId("auth-matricula").value.replace(/\D/g, "") : "";
        const btn = byId("btn-auth-submit");
        const authError = byId("auth-error");

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
                userProfile = { name: name, matricula: matricula.slice(0, 12), cpf: "", phone: "" };
                await saveUserProfileData();
                showToast("Conta criada com sucesso!");
            }
            closeModal("auth");
        } catch (error) {
            console.error("Auth Error:", error);
            if (authError) {
                authError.classList.remove("hidden");
                if (error.code === "auth/email-already-in-use") authError.textContent = "E-mail já cadastrado.";
                else if (error.code === "auth/wrong-password" || error.code === "auth/user-not-found" || error.code === "auth/invalid-credential") authError.textContent = "E-mail ou senha incorretos.";
                else if (error.code === "auth/weak-password") authError.textContent = "A senha deve ter pelo menos 6 caracteres.";
                else authError.textContent = "Erro ao autenticar: verifique se E-mail/Senha está ativo no Firebase.";
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
            if (auth) await signOut(auth);
            userProfile = { name: "", matricula: "", cpf: "", phone: "" };
            if (auth) await signInAnonymously(auth);
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
        if (!currentUser || currentUser.isAnonymous) return;

        const name = byId("profile-name") ? byId("profile-name").value.trim() : "";
        const matricula = byId("profile-matricula") ? byId("profile-matricula").value.replace(/\D/g, "") : "";
        const cpf = byId("profile-cpf") ? byId("profile-cpf").value.trim() : "";
        const phone = byId("profile-phone") ? byId("profile-phone").value.trim() : "";
        const newPass = byId("profile-new-password") ? byId("profile-new-password").value : "";

        if (matricula && matricula.length !== 12) {
            showToast("A Matrícula UERJ deve ter exatamente 12 dígitos.", "error");
            return;
        }

        try {
            if (name && name !== currentUser.displayName) {
                await updateProfile(currentUser, { displayName: name });
            }
            userProfile = { name: name, matricula: matricula, cpf: cpf, phone: phone };
            await saveUserProfileData();

            if (newPass && newPass.length >= 6) {
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
                showToast("Dados salvos!", "success");
            }
        }
    });

    on("btn-checkout", "click", function () {
        if (cart.length === 0) return;

        if (!currentUser || currentUser.isAnonymous) {
            closeCartSidebar();
            openAuthModal();
            showToast("Faça login ou cadastre-se para finalizar o pedido.", "error");
            return;
        }

        stopPixPolling();
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
    });

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

        const matricula = byId("checkout-matricula") ? byId("checkout-matricula").value.replace(/\D/g, "") : "";
        const cpf = byId("checkout-cpf") ? byId("checkout-cpf").value.replace(/\D/g, "") : "";
        const phone = byId("checkout-phone") ? byId("checkout-phone").value.trim() : "";

        if (matricula.length !== 12) {
            showToast("A Matrícula UERJ deve conter exatamente 12 números (Ex: 202610123456).", "error");
            return;
        }
        if (cpf.length !== 11) {
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
        await saveUserProfileData();

        const baseSubtotal = getCartBaseSubtotal();
        const btnSubmit = byId("btn-submit-payment");
        const fullName = fallbackName.trim();
        const nameParts = fullName.split(" ");
        const firstName = nameParts[0] ? nameParts[0] : "Aluno";
        const lastName = nameParts.slice(1).join(" ") ? nameParts.slice(1).join(" ") : "FurioZOs";

        if (selectedPaymentMethod === "pix") {
            if (btnSubmit) {
                btnSubmit.disabled = true;
                btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Gerando PIX Oficial...';
            }

            try {
                const payload = {
                    transaction_amount: Number(baseSubtotal.toFixed(2)),
                    description: "Pedido Atletica FurioZOs - Matricula " + matricula,
                    payment_method_id: "pix",
                    payer: {
                        email: (currentUser && currentUser.email) ? currentUser.email : "aluno@uerj.br",
                        first_name: firstName,
                        last_name: lastName,
                        identification: {
                            type: "CPF",
                            number: cpf
                        }
                    }
                };

                const res = await callMercadoPagoApi("/v1/payments", "POST", payload);
                const poi = res.data ? res.data.point_of_interaction : null;
                const txData = poi ? poi.transaction_data : null;

                if (!res.ok || !txData || !txData.qr_code) {
                    const detailMsg = translateMpRejectReason(res.data ? res.data.status_detail : "", res.data ? res.data.message : "");
                    showToast("Não foi possível gerar o PIX: " + detailMsg, "error");
                    if (btnSubmit) {
                        btnSubmit.disabled = false;
                        btnSubmit.textContent = "Gerar QR Code PIX";
                    }
                    return;
                }

                activePixPaymentId = res.data.id;
                const qrImgEl = byId("pix-qr-img");
                if (qrImgEl) {
                    if (txData.qr_code_base64) {
                        qrImgEl.src = "data:image/png;base64," + txData.qr_code_base64;
                    } else {
                        qrImgEl.src = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" + encodeURIComponent(txData.qr_code);
                    }
                }

                if (byId("pix-copia-cola")) byId("pix-copia-cola").value = txData.qr_code;
                if (byId("pix-qrcode-box")) byId("pix-qrcode-box").classList.remove("hidden");
                if (btnSubmit) btnSubmit.classList.add("hidden");
                showToast("QR Code PIX oficial gerado! Escaneie ou use o Copia e Cola no seu banco.");

                const checkoutMeta = {
                    matricula: matricula,
                    cpf: maskCPF(cpf),
                    phone: phone,
                    subtotalAmount: baseSubtotal,
                    feeAmount: 0,
                    totalAmount: baseSubtotal,
                    installments: 1
                };

                stopPixPolling();
                pixPollingInterval = setInterval(function () {
                    checkPixPaymentStatus(activePixPaymentId, checkoutMeta, true);
                }, 4000);

                const verifyBtn = byId("btn-verify-pix-now");
                if (verifyBtn) {
                    verifyBtn.onclick = function () {
                        checkPixPaymentStatus(activePixPaymentId, checkoutMeta, false);
                    };
                }
            } catch (err) {
                console.error("Erro PIX Mercado Pago:", err);
                showToast("Erro de conexão com o Worker de pagamento. Verifique a URL configurada.", "error");
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

            const rate = INSTALLMENT_RATES[installments] ? INSTALLMENT_RATES[installments] : 0.0498;
            const finalCardTotal = Number((baseSubtotal / (1 - rate)).toFixed(2));
            const feeAmount = Math.max(0, finalCardTotal - baseSubtotal);

            if (btnSubmit) {
                btnSubmit.disabled = true;
                btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Processando Cartão...';
            }

            try {
                if (!mpInstance && typeof window.MercadoPago !== "undefined") {
                    mpInstance = new window.MercadoPago(MERCADO_PAGO_CONFIG.publicKey, { locale: "pt-BR" });
                }

                // 1. Identifica a bandeira (visa, master, elo, etc.) e banco emissor pelos 6 primeiros digitos
                const binInfo = await detectCardMethodAndIssuer(cardNumber);

                // 2. Gera o Token seguro do cartao via SDK Mercado Pago
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
                    if (btnSubmit) {
                        btnSubmit.disabled = false;
                        btnSubmit.textContent = "Pagar com Cartão";
                    }
                    return;
                }

                // 3. Envia a cobranca completa para a API do Mercado Pago via Cloudflare Worker
                const paymentPayload = {
                    transaction_amount: finalCardTotal,
                    token: tokenResponse.id,
                    description: "Pedido Atletica FurioZOs - Matricula " + matricula,
                    installments: installments,
                    payment_method_id: binInfo.paymentMethodId,
                    issuer_id: binInfo.issuerId,
                    payer: {
                        email: (currentUser && currentUser.email) ? currentUser.email : "aluno@uerj.br",
                        first_name: firstName,
                        last_name: lastName,
                        identification: {
                            type: "CPF",
                            number: cpf
                        }
                    }
                };

                const res = await callMercadoPagoApi("/v1/payments", "POST", paymentPayload);
                if (res.ok && res.data && (res.data.status === "approved" || res.data.status === "in_process")) {
                    await finalizeOrderRecord({
                        matricula: matricula,
                        cpf: maskCPF(cpf),
                        phone: phone,
                        subtotalAmount: baseSubtotal,
                        feeAmount: feeAmount,
                        totalAmount: finalCardTotal,
                        installments: installments,
                        paymentMethod: "Cartão de Crédito (" + installments + "x)",
                        mpPaymentId: String(res.data.id)
                    });
                } else {
                    const reason = translateMpRejectReason(
                        res.data ? res.data.status_detail : "",
                        res.data ? res.data.message : ""
                    );
                    showToast("Cartão recusado: " + reason, "error");
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
                facRow["Número (Costas)"] = item.customNumber !== "" ? item.customNumber : "SEM NÚMERO";
                facRow["Modalidade Entrega"] = item.deliveryMode === "imediata" ? "PRONTA ENTREGA" : "LOTE (ENCOMENDA)";
                facRow["Quantidade"] = qtyNum;
                facRow["Valor Unitário"] = priceNum;
                facRow["Subtotal Item"] = Number(priceNum * qtyNum);
                facRow["Status Pagamento"] = order.status ? order.status : "Confirmado";
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
            if (user) {
                currentUser = user;
                await loadUserProfileData();
                updateAuthUI();
                await loadCartData();
                await loadInitialData();
            } else {
                currentUser = null;
                updateAuthUI();
                await loadCartData();
            }
        });

        try {
            if (!auth.currentUser) {
                await signInAnonymously(auth);
            }
        } catch (err) {
            console.warn("Modo visitante local ativo:", err);
            await loadCartData();
        }
    }

    await loadInitialData();
}

bootstrapApp();