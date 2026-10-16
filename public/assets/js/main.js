// main.js
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
import Swiper from 'https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.mjs';

// ============================================================================
// 1. CONFIGURAÇÕES DO FIREBASE, ADMIN E MERCADO PAGO (PRODUÇÃO)
// ============================================================================
const appId = 'furiozos-app';

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
    publicKey: "APP_USR-0ec36817-11d7-4726-a2e8-7dbf09bda36e",
    accessToken: "APP_USR-7337621722875027-101604-aa6e32c631ec2cbc868ed5b9a0c0c593-2238854816",
    atleticaWhatsapp: "5521999999999",
    atleticaEmail: "giorgiocsbazet@gmail.com"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let mpInstance = null;
try {
    if (typeof window.MercadoPago !== 'undefined') {
        mpInstance = new window.MercadoPago(MERCADO_PAGO_CONFIG.publicKey, { locale: 'pt-BR' });
    }
} catch (err) {
    console.warn("SDK Mercado Pago a carregar:", err);
}

// ============================================================================
// 2. CATÁLOGO INICIAL E ESTADO DA APLICAÇÃO
// ============================================================================
const DEFAULT_PRODUCTS = [
    {
        id: 'p1',
        name: 'Caneca FurioZOs',
        price: 45.00,
        images: ['assets/img/caneca.jpg'],
        hasSize: false,
        isShirt: false,
        status: 'em_breve',
        immediateStock: 0,
        desc: 'Caneca oficial da atlética, 500ml de pura energia da ZO. Perfeita para as choppadas.'
    },
    {
        id: 'p2',
        name: 'Camisa Especial Limitada',
        price: 120.00,
        images: [
            'assets/img/camisa-diretoria-frente.jpg',
            'assets/img/camisa-diretoria-costas.jpg',
            'assets/img/camisa-diretoria-manga.jpg',
            'assets/img/camisa-diretoria-escudo.jpg'
        ],
        hasSize: true,
        isShirt: true,
        status: 'disponivel',
        immediateStock: 0,
        desc: 'Edição limitada "Sapo Bombado". Tecido premium dry-fit, detalhes em dourado e verde oliva. Personalize com seu nome e número!'
    },
    {
        id: 'p3',
        name: 'Camisa de Jogo',
        price: 85.00,
        images: ['assets/img/camisa-jogo.jpg'],
        hasSize: true,
        isShirt: true,
        status: 'em_breve',
        immediateStock: 0,
        desc: 'Camisa oficial para atletas e guerreiros. Material leve, ideal para a prática esportiva.'
    },
    {
        id: 'p4',
        name: 'Camisa de Torcida',
        price: 70.00,
        images: ['assets/img/camisa-torcida.jpg'],
        hasSize: true,
        isShirt: true,
        status: 'em_breve',
        immediateStock: 0,
        desc: 'Mostre seu apoio nas arquibancadas! Malha 100% algodão, confortável e com estampa exclusiva.'
    },
    {
        id: 'p5',
        name: 'Bandana FurioZOs',
        price: 25.00,
        images: ['assets/img/bandana.jpg'],
        hasSize: false,
        isShirt: false,
        status: 'em_breve',
        immediateStock: 0,
        desc: 'Acessório indispensável. Use na cabeça, no pescoço ou amarrada na mochila. Estilo puramente ZO.'
    }
];

let productsCatalog = [...DEFAULT_PRODUCTS];
let ordersList = [];
let currentUser = null;
let userProfile = { name: '', matricula: '', cpf: '', phone: '' };
let cart = [];
let modalSwiperInstance = null;

let selectedProduct = null;
let selectedSize = null;
let selectedDeliveryMode = 'lote';
let selectedPaymentMethod = 'pix';
let activePixPaymentId = null;
let pixPollingInterval = null;
let lastConfirmedOrder = null;

// ============================================================================
// 3. ELEMENTOS DO DOM E MÁSCARAS DE FORMATAÇÃO
// ============================================================================
const grid = document.getElementById('product-grid');
const modalBackdrop = document.getElementById('modal-backdrop');
const productModal = document.getElementById('product-modal');
const productModalContent = document.getElementById('product-modal-content');
const cartSidebar = document.getElementById('cart-sidebar');
const authModal = document.getElementById('auth-modal');
const authModalContent = document.getElementById('auth-modal-content');
const checkoutModal = document.getElementById('checkout-modal');
const checkoutModalContent = document.getElementById('checkout-modal-content');
const adminModal = document.getElementById('admin-modal');
const adminModalContent = document.getElementById('admin-modal-content');
const profileModal = document.getElementById('profile-modal');
const profileModalContent = document.getElementById('profile-modal-content');
const receiptModal = document.getElementById('receipt-modal');
const receiptModalContent = document.getElementById('receipt-modal-content');

const cartBadge = document.getElementById('cart-badge');
const cartBadgeMobile = document.getElementById('cart-badge-mobile');
const cartItemsContainer = document.getElementById('cart-items-container');
const cartTotalEl = document.getElementById('cart-total');
const emptyCartMsg = document.getElementById('empty-cart-msg');

const customNameInput = document.getElementById('custom-name-input');
const customNameCounter = document.getElementById('custom-name-counter');
const customNumberInput = document.getElementById('custom-number-input');

const formatPrice = (price) => {
    const num = Number(price ? price : 0);
    return 'R$ ' + num.toFixed(2).replace('.', ',');
};

const showToast = (message, type = 'success') => {
    const toast = document.createElement('div');
    const errClass = type === 'error' ? ' !bg-red-600' : '';
    const iconClass = type === 'error' ? 'fa-triangle-exclamation' : 'fa-check-circle';
    toast.className = 'toast' + errClass;
    toast.innerHTML = '<i class="fa-solid ' + iconClass + '"></i> <span>' + message + '</span>';
    document.getElementById('toast-container').appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
};

function isCurrentUserAdmin() {
    if (!currentUser) return false;
    if (currentUser.isAnonymous) return false;
    if (!currentUser.email) return false;
    return ADMIN_EMAILS.includes(currentUser.email.trim().toLowerCase());
}

function maskCPF(val) {
    return val.replace(/\D/g, '').slice(0, 11)
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function maskPhone(val) {
    const d = val.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d;
    if (d.length <= 7) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
    return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
}

function maskMatricula(val) {
    return val.replace(/\D/g, '').slice(0, 12);
}

['checkout-cpf', 'profile-cpf'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', (e) => { e.target.value = maskCPF(e.target.value); });
});
['checkout-phone', 'profile-phone'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', (e) => { e.target.value = maskPhone(e.target.value); });
});
['checkout-matricula', 'profile-matricula', 'auth-matricula'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', (e) => { e.target.value = maskMatricula(e.target.value); });
});

const cardNumberEl = document.getElementById('card-number');
if (cardNumberEl) {
    cardNumberEl.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 ');
    });
}
const cardExpiryEl = document.getElementById('card-expiry');
if (cardExpiryEl) {
    cardExpiryEl.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4).replace(/(\d{2})(\d)/, '$1/$2');
    });
}

// ============================================================================
// 4. RENDERIZAÇÃO DA VITRINE DE PRODUTOS
// ============================================================================
function renderProducts() {
    if (!grid) return;

    grid.innerHTML = productsCatalog.map((p) => {
        const isAvailable = p.status === 'disponivel';
        const isComingSoon = p.status === 'em_breve';
        const isSoldOut = p.status === 'esgotado';

        let topBadge = '';
        if (p.id === 'p2' && isAvailable) {
            topBadge = '<div class="absolute top-4 left-4 bg-[#ccff00] text-furiozo-dark text-xs font-black px-3 py-1 rounded-full z-20 shadow-md transform -rotate-6">OFICIAL • 1º LOTE</div>';
        } else if (isComingSoon) {
            topBadge = '<div class="absolute top-4 right-4 bg-furiozo-dark/90 text-[#ccff00] border border-[#ccff00] text-[11px] font-black px-3 py-1 rounded-full z-20 shadow-md uppercase tracking-wider">Em Breve</div>';
        } else if (isSoldOut) {
            topBadge = '<div class="absolute top-4 right-4 bg-red-600 text-white text-[11px] font-black px-3 py-1 rounded-full z-20 shadow-md uppercase tracking-wider">Esgotado</div>';
        }

        const clickAction = isAvailable
            ? "window.openProductModal('" + p.id + "')"
            : "window.notifyUnavailableProduct('" + p.status + "')";

        let priceAreaHTML = '';
        if (isComingSoon) {
            priceAreaHTML = `
                <div class="relative flex items-center">
                    <span class="font-black text-2xl text-gray-300 blur-[5px] select-none pointer-events-none">R$ 00,00</span>
                    <span class="absolute left-0 inline-flex items-center gap-1.5 bg-furiozo-dark text-[#ccff00] border-2 border-[#ccff00] px-3.5 py-1.5 rounded-xl font-sport font-black text-xs uppercase tracking-widest shadow-md">
                        <i class="fa-solid fa-clock"></i> EM BREVE
                    </span>
                </div>
            `;
        } else if (isSoldOut) {
            priceAreaHTML = `
                <span class="inline-flex items-center gap-1.5 bg-red-100 text-red-700 border border-red-300 px-3.5 py-1.5 rounded-xl font-sport font-black text-xs uppercase tracking-widest">
                    ESGOTADO
                </span>
            `;
        } else {
            priceAreaHTML = '<span class="font-black text-3xl text-gray-900 tracking-tighter">' + formatPrice(p.price) + '</span>';
        }

        const actionBtnHTML = isAvailable
            ? '<button onclick="' + clickAction + '" class="bg-furiozo-dark text-[#ccff00] w-12 h-12 rounded-full flex items-center justify-center group-hover:bg-[#ccff00] group-hover:text-furiozo-dark transition-all shadow-md transform active:scale-95 border border-transparent group-hover:border-furiozo-dark" title="Personalizar e Comprar"><i class="fa-solid fa-plus text-xl"></i></button>'
            : '<button onclick="' + clickAction + '" class="bg-gray-200 text-gray-500 w-12 h-12 rounded-full flex items-center justify-center cursor-not-allowed opacity-75" title="Indisponível no momento"><i class="fa-solid fa-lock text-base"></i></button>';

        const cardHoverClass = isAvailable
            ? 'hover:shadow-[0_10px_30px_rgba(204,255,0,0.25)] hover:border-[#ccff00]/60 transform hover:-translate-y-2'
            : 'opacity-85';
        const cursorClass = isAvailable ? 'cursor-pointer' : 'cursor-not-allowed';
        const imgEffectClass = isAvailable ? 'group-hover:scale-105' : 'grayscale-[35%]';
        const titleHoverClass = isAvailable ? 'cursor-pointer group-hover:text-[#8A9A4A]' : '';
        const customTagHTML = (p.isShirt && isAvailable)
            ? '<span class="text-[11px] font-bold text-[#8A9A4A] uppercase tracking-wider mt-1"><i class="fa-solid fa-wand-magic-sparkles mr-1"></i>Personalizável (Nome/Nº)</span>'
            : '';

        return `
            <div class="bg-white rounded-[2rem] shadow-md overflow-hidden ${cardHoverClass} transition-all duration-300 flex flex-col border-2 border-transparent relative group">
                ${topBadge}
                <div class="relative pb-[100%] ${cursorClass} overflow-hidden bg-gray-100" onclick="${clickAction}">
                    <img src="${p.images[0]}" onerror="this.src='https://placehold.co/500x500/1F4229/ccff00?text=FurioZOs'" alt="${p.name}" class="absolute inset-0 w-full h-full object-cover ${imgEffectClass} transition-transform duration-500">
                </div>
                <div class="p-6 flex flex-col flex-grow">
                    <h3 class="font-sport text-lg text-furiozo-dark font-black uppercase mb-1 flex-grow ${titleHoverClass} transition-colors leading-tight tracking-tight" onclick="${clickAction}">
                        ${p.name}
                    </h3>
                    ${customTagHTML}
                    <div class="flex justify-between items-center mt-4 pt-2 border-t border-gray-100">
                        ${priceAreaHTML}
                        ${actionBtnHTML}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

window.notifyUnavailableProduct = function(status) {
    if (status === 'em_breve') {
        showToast("Este produto será liberado em breve pela diretoria!", "error");
    } else {
        showToast("Produto esgotado no momento.", "error");
    }
};

// ============================================================================
// 5. MODAL DE PRODUTO: PERSONALIZAÇÃO (MÁX 10 LETRAS / 0-99) E ENTREGA
// ============================================================================
function sanitizeCustomInputs() {
    if (!customNameInput || !customNumberInput) return;

    let cleanName = customNameInput.value.toUpperCase().slice(0, 10);
    if (customNameInput.value !== cleanName) customNameInput.value = cleanName;
    if (customNameCounter) customNameCounter.textContent = cleanName.trim().length + '/10';

    let rawDigits = customNumberInput.value.replace(/\D/g, '').slice(0, 2);
    if (rawDigits !== '') {
        let numVal = parseInt(rawDigits, 10);
        if (isNaN(numVal) || numVal < 0) rawDigits = '0';
        if (numVal > 99) rawDigits = '99';
    }
    if (customNumberInput.value !== rawDigits) customNumberInput.value = rawDigits;

    evaluateDeliveryAndPrice();
}

if (customNameInput) customNameInput.addEventListener('input', sanitizeCustomInputs);
if (customNumberInput) customNumberInput.addEventListener('input', sanitizeCustomInputs);

function getCustomizationState() {
    if (!selectedProduct || !selectedProduct.isShirt) {
        return { customName: '', customNumber: '', hasName: false, hasNumber: false, customFee: 0 };
    }
    const rawName = customNameInput ? customNameInput.value : '';
    const rawNum = customNumberInput ? customNumberInput.value : '';
    const customName = rawName.trim().toUpperCase().slice(0, 10);
    const customNumber = rawNum.trim().replace(/\D/g, '').slice(0, 2);
    const hasName = customName.length > 0;
    const hasNumber = customNumber.length > 0;

    let customFee = 0;
    if (hasName) customFee += PRICING_RULES.CUSTOM_NAME_FEE;
    if (hasNumber) customFee += PRICING_RULES.CUSTOM_NUMBER_FEE;

    return { customName, customNumber, hasName, hasNumber, customFee };
}

function evaluateDeliveryAndPrice() {
    if (!selectedProduct) return;

    const { hasName, hasNumber, customFee } = getCustomizationState();
    const isCustomized = hasName || hasNumber;
    const stockVal = selectedProduct.immediateStock ? selectedProduct.immediateStock : 0;
    const hasImmediateStock = Number(stockVal) > 0;

    const btnBatch = document.getElementById('btn-delivery-batch');
    const btnImmediate = document.getElementById('btn-delivery-immediate');
    const immediateStatusText = document.getElementById('immediate-delivery-status');
    const ruleNotice = document.getElementById('delivery-rule-notice');

    if (isCustomized || !hasImmediateStock) {
        selectedDeliveryMode = 'lote';
        if (btnImmediate) {
            btnImmediate.disabled = true;
            btnImmediate.classList.add('opacity-50', 'cursor-not-allowed');
            btnImmediate.classList.remove('border-furiozo-dark', 'bg-furiozo-accent/40');
            btnImmediate.classList.add('border-gray-200', 'bg-white');
        }
        if (btnBatch) {
            btnBatch.classList.add('border-furiozo-dark', 'bg-furiozo-accent/40');
            btnBatch.classList.remove('border-gray-200', 'bg-white');
        }

        if (isCustomized) {
            if (immediateStatusText) immediateStatusText.textContent = "Indisponível para itens com nome/número.";
            if (ruleNotice) ruleNotice.classList.remove('hidden');
        } else {
            if (immediateStatusText) immediateStatusText.textContent = "Sem estoque a pronta entrega no momento (apenas Lote).";
            if (ruleNotice) ruleNotice.classList.add('hidden');
        }
    } else {
        if (btnImmediate) {
            btnImmediate.disabled = false;
            btnImmediate.classList.remove('opacity-50', 'cursor-not-allowed');
        }
        if (immediateStatusText) {
            immediateStatusText.textContent = 'Disponível (' + selectedProduct.immediateStock + ' unid. em estoque imediato).';
        }
        if (ruleNotice) ruleNotice.classList.add('hidden');

        if (selectedDeliveryMode === 'imediata') {
            btnImmediate.classList.add('border-furiozo-dark', 'bg-furiozo-accent/40');
            btnImmediate.classList.remove('border-gray-200', 'bg-white');
            btnBatch.classList.remove('border-furiozo-dark', 'bg-furiozo-accent/40');
            btnBatch.classList.add('border-gray-200', 'bg-white');
        } else {
            btnBatch.classList.add('border-furiozo-dark', 'bg-furiozo-accent/40');
            btnBatch.classList.remove('border-gray-200', 'bg-white');
            btnImmediate.classList.remove('border-furiozo-dark', 'bg-furiozo-accent/40');
            btnImmediate.classList.add('border-gray-200', 'bg-white');
        }
    }

    const deliveryFee = selectedDeliveryMode === 'imediata' ? PRICING_RULES.IMMEDIATE_DELIVERY_FEE : 0;
    const unitPrice = Number(selectedProduct.price) + customFee + deliveryFee;

    const priceEl = document.getElementById('modal-product-price');
    const breakdownEl = document.getElementById('modal-price-breakdown');

    if (priceEl) priceEl.textContent = formatPrice(unitPrice);

    if (breakdownEl) {
        const extras = [];
        if (customFee > 0) extras.push('+' + formatPrice(customFee) + ' personalização');
        if (deliveryFee > 0) extras.push('+' + formatPrice(deliveryFee) + ' pronta entrega');

        if (extras.length > 0) {
            breakdownEl.textContent = extras.join(' • ');
            breakdownEl.classList.remove('hidden');
        } else {
            breakdownEl.classList.add('hidden');
        }
    }
}

window.selectDeliveryMode = function(mode) {
    if (!selectedProduct) return;
    const { hasName, hasNumber } = getCustomizationState();
    const stockVal = selectedProduct.immediateStock ? selectedProduct.immediateStock : 0;
    const hasImmediateStock = Number(stockVal) > 0;

    if (mode === 'imediata') {
        if (hasName || hasNumber) {
            showToast("Peças com nome ou número só podem ser pedidas no Lote!", "error");
            return;
        }
        if (!hasImmediateStock) {
            showToast("Não há unidades a pronta entrega disponíveis no momento.", "error");
            return;
        }
    }
    selectedDeliveryMode = mode;
    evaluateDeliveryAndPrice();
};

window.openProductModal = function(id) {
    selectedProduct = productsCatalog.find(p => p.id === id);
    if (!selectedProduct || selectedProduct.status !== 'disponivel') {
        const st = selectedProduct ? selectedProduct.status : 'em_breve';
        window.notifyUnavailableProduct(st);
        return;
    }

    selectedSize = null;
    selectedDeliveryMode = 'lote';

    document.getElementById('modal-product-name').textContent = selectedProduct.name;
    document.getElementById('modal-product-desc').textContent = selectedProduct.desc;
    document.getElementById('qty-input').value = 1;
    document.getElementById('size-error').classList.add('hidden');

    if (customNameInput) customNameInput.value = '';
    if (customNumberInput) customNumberInput.value = '';
    if (customNameCounter) customNameCounter.textContent = '0/10';

    const wrapper = document.getElementById('modal-swiper-wrapper');
    wrapper.innerHTML = selectedProduct.images.map(imgUrl => `
        <div class="swiper-slide flex items-center justify-center p-4">
            <img src="${imgUrl}" onerror="this.src='https://placehold.co/500x500/1F4229/ccff00?text=FurioZOs'" alt="Produto" class="max-w-full max-h-[260px] md:max-h-[380px] object-contain drop-shadow-md rounded-xl">
        </div>
    `).join('');

    if (modalSwiperInstance) modalSwiperInstance.destroy(true, true);
    modalSwiperInstance = new Swiper('.modalSwiper', {
        loop: selectedProduct.images.length > 1,
        grabCursor: true,
        pagination: { el: ".swiper-pagination", clickable: true },
        navigation: { nextEl: ".swiper-button-next", prevEl: ".swiper-button-prev" },
    });

    const sizeContainer = document.getElementById('size-selector-container');
    const sizeOptions = document.getElementById('size-options');
    const customContainer = document.getElementById('customization-container');

    if (selectedProduct.hasSize) {
        sizeContainer.classList.remove('hidden');
        const tamanhos = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XXG'];
        sizeOptions.innerHTML = tamanhos.map(size =>
            '<button type="button" onclick="window.selectSize(\'' + size + '\', this)" class="size-btn px-3 min-w-[2.5rem] h-10 rounded-full border-2 border-gray-300 font-bold text-gray-600 hover:border-[#ccff00] hover:text-furiozo-dark transition-all focus:outline-none flex items-center justify-center text-sm">' + size + '</button>'
        ).join('');
    } else {
        sizeContainer.classList.add('hidden');
    }

    if (selectedProduct.isShirt) {
        customContainer.classList.remove('hidden');
    } else {
        customContainer.classList.add('hidden');
    }

    evaluateDeliveryAndPrice();
    showModal('product');
};

window.selectSize = function(size, btnElement) {
    selectedSize = size;
    document.getElementById('size-error').classList.add('hidden');
    document.querySelectorAll('.size-btn').forEach(btn => {
        btn.classList.remove('bg-[#ccff00]', 'text-furiozo-dark', 'border-[#ccff00]');
        btn.classList.add('border-gray-300', 'text-gray-600');
    });
    btnElement.classList.remove('border-gray-300', 'text-gray-600');
    btnElement.classList.add('bg-[#ccff00]', 'text-furiozo-dark', 'border-[#ccff00]');
};

document.getElementById('qty-plus').addEventListener('click', () => {
    const input = document.getElementById('qty-input');
    if (parseInt(input.value) < 10) input.value = parseInt(input.value) + 1;
});
document.getElementById('qty-minus').addEventListener('click', () => {
    const input = document.getElementById('qty-input');
    if (parseInt(input.value) > 1) input.value = parseInt(input.value) - 1;
});

// ============================================================================
// 6. CARRINHO DE COMPRAS
// ============================================================================
window.addToCart = async function() {
    if (!selectedProduct) return;
    const rawQty = parseInt(document.getElementById('qty-input').value, 10);
    const qty = isNaN(rawQty) ? 1 : rawQty;

    if (selectedProduct.hasSize && !selectedSize) {
        document.getElementById('size-error').classList.remove('hidden');
        return;
    }

    const { customName, customNumber, customFee } = getCustomizationState();
    const deliveryFee = selectedDeliveryMode === 'imediata' ? PRICING_RULES.IMMEDIATE_DELIVERY_FEE : 0;
    const stockVal = selectedProduct.immediateStock ? selectedProduct.immediateStock : 0;

    if (selectedDeliveryMode === 'imediata' && qty > Number(stockVal)) {
        showToast('Apenas ' + stockVal + ' unid. disponíveis para pronta entrega.', "error");
        return;
    }

    const finalUnitPrice = Number(selectedProduct.price) + customFee + deliveryFee;
    const sizeKey = selectedSize ? selectedSize : 'unico';
    const nameKey = customName ? customName : 'semnome';
    const numKey = customNumber ? customNumber : 'semnum';
    const uniqueKey = [selectedProduct.id, sizeKey, nameKey, numKey, selectedDeliveryMode].join('-');

    const cartItem = {
        id: selectedProduct.id,
        name: selectedProduct.name,
        basePrice: Number(selectedProduct.price),
        customFee,
        deliveryFee,
        price: finalUnitPrice,
        img: selectedProduct.images[0],
        size: selectedSize ? selectedSize : 'Único',
        customName: customName ? customName : '',
        customNumber: customNumber ? customNumber : '',
        deliveryMode: selectedDeliveryMode,
        isShirt: Boolean(selectedProduct.isShirt),
        quantity: qty,
        cartItemId: uniqueKey
    };

    const existingIndex = cart.findIndex(item => item.cartItemId === cartItem.cartItemId);
    if (existingIndex > -1) {
        cart[existingIndex].quantity += qty;
    } else {
        cart.push(cartItem);
    }

    updateCartUI();
    closeModal('product');
    showToast(qty + 'x ' + selectedProduct.name + ' adicionado ao carrinho!');
    await saveCartData();
    setTimeout(openCartSidebar, 250);
};

document.getElementById('btn-add-to-cart').addEventListener('click', window.addToCart);

window.removeFromCart = async function(cartItemId) {
    cart = cart.filter(item => item.cartItemId !== cartItemId);
    updateCartUI();
    await saveCartData();
};

window.updateQuantity = async function(cartItemId, delta) {
    const item = cart.find(i => i.cartItemId === cartItemId);
    if (item) {
        item.quantity += delta;
        if (item.quantity <= 0) {
            await window.removeFromCart(cartItemId);
        } else {
            updateCartUI();
            await saveCartData();
        }
    }
};

function getCartBaseSubtotal() {
    return cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
}

function updateCartUI() {
    const totalQty = cart.reduce((sum, item) => sum + item.quantity, 0);
    cartBadge.textContent = totalQty;
    cartBadgeMobile.textContent = totalQty;

    if (totalQty > 0) {
        cartBadge.classList.remove('hidden');
        cartBadgeMobile.classList.remove('hidden');
    } else {
        cartBadge.classList.add('hidden');
        cartBadgeMobile.classList.add('hidden');
    }

    if (cart.length === 0) {
        cartItemsContainer.innerHTML = '';
        emptyCartMsg.classList.remove('hidden');
        cartItemsContainer.appendChild(emptyCartMsg);
        cartTotalEl.textContent = 'R$ 0,00';
        return;
    }

    emptyCartMsg.classList.add('hidden');
    let totalValue = 0;

    cartItemsContainer.innerHTML = cart.map(item => {
        const itemTotal = item.price * item.quantity;
        totalValue += itemTotal;

        const customBadges = [];
        if (item.customName) {
            customBadges.push('<span class="bg-furiozo-accent text-furiozo-dark px-2 py-0.5 rounded font-bold text-[10px]">Nome: ' + item.customName + '</span>');
        }
        if (item.customNumber) {
            customBadges.push('<span class="bg-furiozo-accent text-furiozo-dark px-2 py-0.5 rounded font-bold text-[10px]">Nº: ' + item.customNumber + '</span>');
        }

        const deliveryBadge = item.deliveryMode === 'imediata'
            ? '<span class="bg-[#ccff00] text-furiozo-dark px-2 py-0.5 rounded font-black text-[10px] uppercase"><i class="fa-solid fa-bolt mr-1"></i>Pronta Entrega (+R$ 10)</span>'
            : '<span class="bg-gray-100 text-gray-700 px-2 py-0.5 rounded font-bold text-[10px] uppercase">Pedido em Lote</span>';

        const badgesHTML = customBadges.join('') + deliveryBadge;
        const unitFormatted = formatPrice(item.price);
        const subFormatted = formatPrice(itemTotal);

        return `
        <div class="flex gap-3 bg-white p-3.5 rounded-2xl shadow-sm border border-gray-100">
            <img src="${item.img}" onerror="this.src='https://placehold.co/150x150/1F4229/ccff00?text=FurioZOs'" class="w-20 h-20 object-cover rounded-xl border border-gray-200 shrink-0">
            <div class="flex-grow flex flex-col justify-between">
                <div class="flex justify-between items-start gap-2">
                    <h4 class="font-bold text-sm text-gray-800 leading-tight">${item.name}</h4>
                    <button onclick="window.removeFromCart('${item.cartItemId}')" class="text-gray-400 hover:text-red-500 transition-colors"><i class="fa-solid fa-trash"></i></button>
                </div>
                <p class="text-xs text-gray-500 font-semibold mt-0.5">
                    Tam: <strong class="text-gray-800">${item.size}</strong> • Unit: ${unitFormatted}
                </p>
                <div class="flex flex-wrap gap-1 my-1.5">
                    ${badgesHTML}
                </div>
                <div class="flex justify-between items-center mt-1">
                    <div class="flex items-center border border-gray-200 rounded-lg px-2 py-0.5 bg-gray-50">
                        <button onclick="window.updateQuantity('${item.cartItemId}', -1)" class="text-gray-500 hover:text-furiozo-dark px-1"><i class="fa-solid fa-minus text-[10px]"></i></button>
                        <span class="mx-2 text-xs font-bold w-4 text-center">${item.quantity}</span>
                        <button onclick="window.updateQuantity('${item.cartItemId}', 1)" class="text-gray-500 hover:text-furiozo-dark px-1"><i class="fa-solid fa-plus text-[10px]"></i></button>
                    </div>
                    <span class="font-black text-furiozo-dark text-sm">${subFormatted}</span>
                </div>
            </div>
        </div>
        `;
    }).join('');

    cartTotalEl.textContent = formatPrice(totalValue);
}

// ============================================================================
// 7. CHECKOUT, REPASSE DE PARCELAMENTO (1x A 12x) E API MERCADO PAGO
// ============================================================================
function buildInstallmentsDropdown(baseSubtotal) {
    const select = document.getElementById('card-installments');
    if (!select) return;

    const optionsHTML = [];
    for (let i = 1; i <= 12; i++) {
        const rate = INSTALLMENT_RATES[i] ? INSTALLMENT_RATES[i] : 0.05;
        const totalWithFee = Number((baseSubtotal / (1 - rate)).toFixed(2));
        const installmentVal = Number((totalWithFee / i).toFixed(2));
        const label = i + 'x de ' + formatPrice(installmentVal) + ' (Total: ' + formatPrice(totalWithFee) + ')';
        optionsHTML.push('<option value="' + i + '" data-total="' + totalWithFee + '">' + label + '</option>');
    }
    select.innerHTML = optionsHTML.join('');
}

function updateCheckoutTotalsUI() {
    const baseSubtotal = getCartBaseSubtotal();
    const subtotalEl = document.getElementById('checkout-subtotal-display');
    const feeRow = document.getElementById('checkout-fee-row');
    const feeDisplay = document.getElementById('checkout-fee-display');
    const totalDisplay = document.getElementById('checkout-total-display');
    const summaryText = document.getElementById('checkout-installment-summary');

    if (subtotalEl) subtotalEl.textContent = formatPrice(baseSubtotal);

    if (selectedPaymentMethod === 'pix') {
        if (feeRow) {
            feeRow.classList.add('hidden');
            feeRow.classList.remove('flex');
        }
        if (totalDisplay) totalDisplay.textContent = formatPrice(baseSubtotal);
        if (summaryText) summaryText.textContent = "À vista no PIX (Sem taxas extras)";
    } else {
        const select = document.getElementById('card-installments');
        const rawInst = select ? select.value : '1';
        const installments = parseInt(rawInst, 10);
        const rate = INSTALLMENT_RATES[installments] ? INSTALLMENT_RATES[installments] : 0.0498;
        const finalCardTotal = Number((baseSubtotal / (1 - rate)).toFixed(2));
        const feeAmount = Math.max(0, finalCardTotal - baseSubtotal);
        const perInstallment = Number((finalCardTotal / installments).toFixed(2));

        if (feeRow) {
            feeRow.classList.remove('hidden');
            feeRow.classList.add('flex');
        }
        if (feeDisplay) feeDisplay.textContent = '+ ' + formatPrice(feeAmount);
        if (totalDisplay) totalDisplay.textContent = formatPrice(finalCardTotal);
        if (summaryText) summaryText.textContent = 'Em ' + installments + 'x de ' + formatPrice(perInstallment) + ' no Cartão';
    }
}

const cardInstEl = document.getElementById('card-installments');
if (cardInstEl) cardInstEl.addEventListener('change', updateCheckoutTotalsUI);

document.getElementById('btn-checkout').addEventListener('click', () => {
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

    if (userProfile.matricula) document.getElementById('checkout-matricula').value = userProfile.matricula;
    if (userProfile.cpf) document.getElementById('checkout-cpf').value = userProfile.cpf;
    if (userProfile.phone) document.getElementById('checkout-phone').value = userProfile.phone;

    document.getElementById('pix-qrcode-box').classList.add('hidden');
    document.getElementById('btn-submit-payment').classList.remove('hidden');

    window.selectPaymentMethod('pix');
    closeCartSidebar();
    showModal('checkout');
});

window.selectPaymentMethod = function(method) {
    selectedPaymentMethod = method;
    const tabPix = document.getElementById('tab-pay-pix');
    const tabCard = document.getElementById('tab-pay-card');
    const panelPix = document.getElementById('payment-pix-panel');
    const panelCard = document.getElementById('payment-card-panel');
    const btnSubmit = document.getElementById('btn-submit-payment');

    if (method === 'pix') {
        tabPix.className = "p-4 rounded-2xl border-2 border-furiozo-dark bg-furiozo-accent/50 font-black text-furiozo-dark flex flex-col items-center justify-center gap-1 transition-all shadow-sm";
        tabCard.className = "p-4 rounded-2xl border-2 border-gray-200 bg-white font-bold text-gray-600 flex flex-col items-center justify-center gap-1 transition-all";
        panelPix.classList.remove('hidden');
        panelCard.classList.add('hidden');
        btnSubmit.textContent = "Gerar QR Code PIX";
        if (!document.getElementById('pix-qrcode-box').classList.contains('hidden')) {
            btnSubmit.classList.add('hidden');
        } else {
            btnSubmit.classList.remove('hidden');
        }
    } else {
        tabCard.className = "p-4 rounded-2xl border-2 border-furiozo-dark bg-furiozo-accent/50 font-black text-furiozo-dark flex flex-col items-center justify-center gap-1 transition-all shadow-sm";
        tabPix.className = "p-4 rounded-2xl border-2 border-gray-200 bg-white font-bold text-gray-600 flex flex-col items-center justify-center gap-1 transition-all";
        panelCard.classList.remove('hidden');
        panelPix.classList.add('hidden');
        btnSubmit.classList.remove('hidden');
        btnSubmit.textContent = "Pagar com Cartão";
    }
    updateCheckoutTotalsUI();
};

async function callMercadoPagoApi(path, method = 'GET', bodyObj = null) {
    const targetUrl = 'https://api.mercadopago.com' + path;
    const headers = {
        'Authorization': 'Bearer ' + MERCADO_PAGO_CONFIG.accessToken,
        'Content-Type': 'application/json'
    };
    if (method === 'POST') {
        headers['X-Idempotency-Key'] = 'fz-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    }

    const fetchOptions = {
        method,
        headers,
        body: bodyObj ? JSON.stringify(bodyObj) : undefined
    };

    try {
        const res = await fetch(targetUrl, fetchOptions);
        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
    } catch (directErr) {
        const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(targetUrl);
        const res = await fetch(proxyUrl, fetchOptions);
        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
    }
}

function stopPixPolling() {
    if (pixPollingInterval) {
        clearInterval(pixPollingInterval);
        pixPollingInterval = null;
    }
}

async function checkPixPaymentStatus(paymentId, checkoutMeta, silent = false) {
    if (!paymentId) return;
    try {
        const { ok, data } = await callMercadoPagoApi('/v1/payments/' + paymentId, 'GET');
        if (ok && data && data.status === 'approved') {
            stopPixPolling();
            const statusInd = document.getElementById('pix-status-indicator');
            if (statusInd) {
                statusInd.innerHTML = '<i class="fa-solid fa-circle-check text-green-600"></i> Pagamento Aprovado pelo Banco!';
            }
            await finalizeOrderRecord({
                ...checkoutMeta,
                paymentMethod: 'PIX (Mercado Pago)',
                mpPaymentId: String(paymentId)
            });
        } else if (!silent) {
            showToast("O banco ainda aguarda a confirmação do pagamento PIX. Assim que pagar, aguarde alguns segundos!", "error");
        }
    } catch (err) {
        if (!silent) showToast("A verificar pagamento com o Mercado Pago...", "error");
    }
}

document.getElementById('checkout-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (cart.length === 0) return;

    const matricula = document.getElementById('checkout-matricula').value.replace(/\D/g, '');
    const cpf = document.getElementById('checkout-cpf').value.replace(/\D/g, '');
    const phone = document.getElementById('checkout-phone').value.trim();

    if (matricula.length !== 12) {
        showToast("A Matrícula UERJ deve conter exatamente 12 números (Ex: 202610123456).", "error");
        return;
    }
    if (cpf.length !== 11) {
        showToast("Digite um CPF válido com 11 dígitos.", "error");
        return;
    }
    if (phone.replace(/\D/g, '').length < 10) {
        showToast("Digite um WhatsApp válido com DDD.", "error");
        return;
    }

    const fallbackName = currentUser.displayName ? currentUser.displayName : (userProfile.name ? userProfile.name : 'Aluno FurioZOs');
    userProfile = {
        name: fallbackName,
        matricula,
        cpf: maskCPF(cpf),
        phone
    };
    await saveUserProfileData();

    const baseSubtotal = getCartBaseSubtotal();
    const btnSubmit = document.getElementById('btn-submit-payment');
    const fullName = fallbackName.trim();
    const nameParts = fullName.split(' ');
    const firstName = nameParts[0] ? nameParts[0] : 'Aluno';
    const lastName = nameParts.slice(1).join(' ') ? nameParts.slice(1).join(' ') : 'FurioZOs';

    if (selectedPaymentMethod === 'pix') {
        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Gerando PIX Oficial...';

        try {
            const payload = {
                transaction_amount: Number(baseSubtotal.toFixed(2)),
                description: 'Pedido Atletica FurioZOs - Matricula ' + matricula,
                payment_method_id: "pix",
                payer: {
                    email: currentUser.email ? currentUser.email : "aluno@uerj.br",
                    first_name: firstName,
                    last_name: lastName,
                    identification: {
                        type: "CPF",
                        number: cpf
                    }
                }
            };

            const { ok, data } = await callMercadoPagoApi('/v1/payments', 'POST', payload);
            const poi = data ? data.point_of_interaction : null;
            const txData = poi ? poi.transaction_data : null;

            if (!ok || !txData || !txData.qr_code) {
                const msg = (data && data.message) ? data.message : "Verifique o CPF informado ou tente novamente.";
                showToast('Não foi possível gerar o PIX: ' + msg, "error");
                btnSubmit.disabled = false;
                btnSubmit.textContent = "Gerar QR Code PIX";
                return;
            }

            activePixPaymentId = data.id;
            const qrImgEl = document.getElementById('pix-qr-img');
            if (txData.qr_code_base64) {
                qrImgEl.src = 'data:image/png;base64,' + txData.qr_code_base64;
            } else {
                qrImgEl.src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(txData.qr_code);
            }

            document.getElementById('pix-copia-cola').value = txData.qr_code;
            document.getElementById('pix-qrcode-box').classList.remove('hidden');
            btnSubmit.classList.add('hidden');
            showToast("QR Code PIX oficial gerado! Escaneie ou use o Copia e Cola no seu banco.");

            const checkoutMeta = {
                matricula,
                cpf: maskCPF(cpf),
                phone,
                subtotalAmount: baseSubtotal,
                feeAmount: 0,
                totalAmount: baseSubtotal,
                installments: 1
            };

            stopPixPolling();
            pixPollingInterval = setInterval(() => {
                checkPixPaymentStatus(activePixPaymentId, checkoutMeta, true);
            }, 4000);

            document.getElementById('btn-Verify-pix-now').onclick = () => {
                checkPixPaymentStatus(activePixPaymentId, checkoutMeta, false);
            };
        } catch (err) {
            console.error("Erro PIX Mercado Pago:", err);
            showToast("Erro de comunicação ao gerar PIX. Tente novamente.", "error");
        } finally {
            btnSubmit.disabled = false;
            btnSubmit.textContent = "Gerar QR Code PIX";
        }
    } else {
        const cardNumber = document.getElementById('card-number').value.replace(/\D/g, '');
        const cardHolder = document.getElementById('card-holder').value.trim();
        const cardExpiry = document.getElementById('card-expiry').value.trim();
        const cardCvv = document.getElementById('card-cvv').value.replace(/\D/g, '');
        const rawInst = document.getElementById('card-installments').value;
        const installments = parseInt(rawInst ? rawInst : '1', 10);

        const [expMonth, expYearShort] = cardExpiry.split('/');
        if (cardNumber.length < 13 || !cardHolder || !expMonth || !expYearShort || cardCvv.length < 3) {
            showToast("Preencha todos os dados do cartão corretamente.", "error");
            return;
        }

        const rate = INSTALLMENT_RATES[installments] ? INSTALLMENT_RATES[installments] : 0.0498;
        const finalCardTotal = Number((baseSubtotal / (1 - rate)).toFixed(2));
        const feeAmount = Math.max(0, finalCardTotal - baseSubtotal);

        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Processando Cartão...';

        try {
            if (!mpInstance && typeof window.MercadoPago !== 'undefined') {
                mpInstance = new window.MercadoPago(MERCADO_PAGO_CONFIG.publicKey, { locale: 'pt-BR' });
            }

            const expYearFull = expYearShort.length === 2 ? '20' + expYearShort : expYearShort;
            const tokenResponse = await mpInstance.createCardToken({
                cardNumber,
                cardholderName: cardHolder,
                cardExpirationMonth: expMonth,
                cardExpirationYear: expYearFull,
                securityCode: cardCvv,
                identificationType: 'CPF',
                identificationNumber: cpf
            });

            if (!tokenResponse || !tokenResponse.id) {
                showToast("Dados do cartão inválidos ou recusados.", "error");
                btnSubmit.disabled = false;
                btnSubmit.textContent = "Pagar com Cartão";
                return;
            }

            const paymentPayload = {
                transaction_amount: finalCardTotal,
                token: tokenResponse.id,
                description: 'Pedido Atletica FurioZOs - Matricula ' + matricula,
                installments,
                payer: {
                    email: currentUser.email ? currentUser.email : "aluno@uerj.br",
                    first_name: firstName,
                    last_name: lastName,
                    identification: {
                        type: "CPF",
                        number: cpf
                    }
                }
            };

            const { ok, data } = await callMercadoPagoApi('/v1/payments', 'POST', paymentPayload);
            if (ok && (data.status === 'approved' || data.status === 'in_process')) {
                await finalizeOrderRecord({
                    matricula,
                    cpf: maskCPF(cpf),
                    phone,
                    subtotalAmount: baseSubtotal,
                    feeAmount,
                    totalAmount: finalCardTotal,
                    installments,
                    paymentMethod: 'Cartão de Crédito (' + installments + 'x)',
                    mpPaymentId: String(data.id)
                });
            } else {
                const detail = (data && data.status_detail) ? data.status_detail : "Transação não autorizada pela operadora.";
                showToast('Cartão recusado: ' + detail, "error");
            }
        } catch (cardErr) {
            console.error("Erro no processamento do cartão:", cardErr);
            showToast("Cartão recusado ou dados inválidos. Verifique número, validade e CVV.", "error");
        } finally {
            btnSubmit.disabled = false;
            btnSubmit.textContent = "Pagar com Cartão";
        }
    }
});

document.getElementById('btn-copy-pix').addEventListener('click', () => {
    const input = document.getElementById('pix-copia-cola');
    navigator.clipboard.writeText(input.value);
    showToast("Código PIX Copia e Cola copiado!");
});

// ============================================================================
// 8. FINALIZAÇÃO DO PEDIDO + CONFIRMAÇÃO WHATSAPP E E-MAIL
// ============================================================================
function formatCustomDetailsText(item) {
    const hasCustom = Boolean(item.customName || item.customNumber);
    if (!hasCustom) return '';
    const nStr = item.customName ? item.customName : '-';
    const numStr = item.customNumber ? item.customNumber : '-';
    return ' - Nome: ' + nStr + ' / Nº: ' + numStr;
}

function buildOrderReceiptMessage(order) {
    const itemsArr = order.items ? order.items : [];
    const itemsLines = itemsArr.map(i => {
        const customInfo = formatCustomDetailsText(i);
        const modeLabel = i.deliveryMode === 'imediata' ? 'Pronta Entrega' : 'Lote';
        const lineTotal = formatPrice(i.price * i.quantity);
        return '• ' + i.quantity + 'x ' + i.name + ' (Tam: ' + i.size + customInfo + ') [' + modeLabel + '] - ' + lineTotal;
    }).join('\n');

    const txId = order.mpPaymentId ? order.mpPaymentId : 'Confirmado';

    return [
        '🐸 *CONFIRMAÇÃO DE PEDIDO - ATLÉTICA FURIOZOS*',
        '━━━━━━━━━━━━━━━━━━━━',
        '*Pedido:* #' + order.orderId,
        '*Transação MP:* ' + txId,
        '*Aluno:* ' + order.customerName,
        '*Matrícula UERJ:* ' + order.customerMatricula,
        '*CPF:* ' + order.customerCpf,
        '*WhatsApp:* ' + order.customerPhone,
        '━━━━━━━━━━━━━━━━━━━━',
        '*ITENS DO PEDIDO:*',
        itemsLines,
        '━━━━━━━━━━━━━━━━━━━━',
        '*Forma de Pagamento:* ' + order.paymentMethod,
        '*Total Pago:* ' + formatPrice(order.total),
        '*Status:* ✅ ' + order.status
    ].join('\n');
}

function showOrderReceiptModal(order) {
    lastConfirmedOrder = order;
    const box = document.getElementById('receipt-details-box');
    const itemsArr = order.items ? order.items : [];

    const itemsHTML = itemsArr.map(i => {
        const nStr = i.customName ? i.customName : '-';
        const numStr = i.customNumber ? i.customNumber : '-';
        const customStr = (i.customName || i.customNumber)
            ? '<span class="block text-[11px] text-[#8A9A4A] font-bold">Personalização: ' + nStr + ' • Nº ' + numStr + '</span>'
            : '';
        const itemSubtotal = formatPrice(i.price * i.quantity);

        return `
            <div class="flex justify-between items-start py-1.5 border-b border-gray-200/70">
                <div>
                    <strong class="text-gray-800">${i.quantity}x ${i.name} (Tam: ${i.size})</strong>
                    ${customStr}
                </div>
                <span class="font-bold text-furiozo-dark">${itemSubtotal}</span>
            </div>
        `;
    }).join('');

    const totalFormatted = formatPrice(order.total);

    box.innerHTML = `
        <div class="flex justify-between items-center border-b border-gray-200 pb-2 mb-2">
            <span class="font-black text-furiozo-dark uppercase">Pedido #${order.orderId}</span>
            <span class="bg-green-100 text-green-800 font-black px-2 py-0.5 rounded text-[10px] uppercase">${order.status}</span>
        </div>
        <p><strong>Aluno:</strong> ${order.customerName}</p>
        <p><strong>Matrícula UERJ:</strong> <span class="font-mono">${order.customerMatricula}</span></p>
        <p><strong>Pagamento:</strong> ${order.paymentMethod}</p>
        <div class="mt-2 pt-2 border-t border-gray-200">${itemsHTML}</div>
        <div class="flex justify-between items-center pt-2 text-sm font-black text-furiozo-dark">
            <span>TOTAL PAGO:</span>
            <span class="text-lg">${totalFormatted}</span>
        </div>
    `;

    const msgText = buildOrderReceiptMessage(order);
    const waLink = 'https://wa.me/' + MERCADO_PAGO_CONFIG.atleticaWhatsapp + '?text=' + encodeURIComponent(msgText);
    document.getElementById('btn-receipt-whatsapp').href = waLink;

    document.getElementById('btn-receipt-email').onclick = () => {
        const subject = 'Confirmação de Pedido #' + order.orderId + ' - Atlética FurioZOs';
        window.location.href = 'mailto:' + order.customerEmail + '?cc=' + MERCADO_PAGO_CONFIG.atleticaEmail + '&subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(msgText);
    };

    showModal('receipt');
}

async function finalizeOrderRecord({ matricula, cpf, phone, subtotalAmount, feeAmount, totalAmount, installments, paymentMethod, mpPaymentId }) {
    const uName = (currentUser && currentUser.displayName)
        ? currentUser.displayName
        : (userProfile.name ? userProfile.name : 'Aluno FurioZOs');
    const uEmail = (currentUser && currentUser.email) ? currentUser.email : 'sem-email@furiozos.com';

    const newOrder = {
        orderId: 'FZ-' + Date.now().toString().slice(-6),
        mpPaymentId: mpPaymentId ? mpPaymentId : '',
        userId: currentUser ? currentUser.uid : 'guest',
        customerName: uName,
        customerEmail: uEmail,
        customerPhone: phone,
        customerCpf: cpf,
        customerMatricula: matricula,
        items: [...cart],
        subtotal: subtotalAmount,
        installmentFee: feeAmount ? feeAmount : 0,
        installments: installments ? installments : 1,
        total: totalAmount,
        paymentMethod,
        status: 'Pago / Confirmado',
        createdAtISO: new Date().toISOString()
    };

    try {
        for (const item of cart) {
            if (item.deliveryMode === 'imediata') {
                const prod = productsCatalog.find(p => p.id === item.id);
                if (prod) {
                    const currentStock = prod.immediateStock ? prod.immediateStock : 0;
                    prod.immediateStock = Math.max(0, Number(currentStock) - item.quantity);
                    await saveProductToFirestore(prod);
                }
            }
        }

        await saveOrderToFirestore(newOrder);

        cart = [];
        await saveCartData();
        updateCartUI();
        closeModal('checkout');
        renderProducts();
        updateBatchCountersUI();
        showToast('Pagamento aprovado! Pedido #' + newOrder.orderId + ' confirmado.');
        setTimeout(() => showOrderReceiptModal(newOrder), 250);
    } catch (error) {
        console.error("Erro ao registar pedido:", error);
        showToast("Erro ao guardar pedido na base de dados.", "error");
    }
}

// ============================================================================
// 9. SINCRONIZAÇÃO COM O CLOUD FIRESTORE
// ============================================================================
async function loadInitialData() {
    try {
        const productsCol = collection(db, 'artifacts', appId, 'public', 'data', 'products');
        const snap = await getDocs(productsCol);
        if (snap.empty) {
            for (const p of DEFAULT_PRODUCTS) {
                await setDoc(doc(productsCol, p.id), p);
            }
            productsCatalog = [...DEFAULT_PRODUCTS];
        } else {
            productsCatalog = snap.docs.map(d => d.data());
        }

        const ordersCol = collection(db, 'artifacts', appId, 'public', 'data', 'orders');
        const ordersSnap = await getDocs(ordersCol);
        ordersList = ordersSnap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => {
                const dateA = a.createdAtISO ? a.createdAtISO : '';
                const dateB = b.createdAtISO ? b.createdAtISO : '';
                return dateB.localeCompare(dateA);
            });

        renderProducts();
        updateBatchCountersUI();
    } catch (err) {
        console.error("Erro ao sincronizar dados com Firestore:", err);
        renderProducts();
    }
}

async function saveProductToFirestore(product) {
    const idx = productsCatalog.findIndex(p => p.id === product.id);
    if (idx > -1) productsCatalog[idx] = product;
    const prodRef = doc(db, 'artifacts', appId, 'public', 'data', 'products', product.id);
    await setDoc(prodRef, product, { merge: true });
}

async function saveOrderToFirestore(order) {
    ordersList.unshift(order);
    const ordersCol = collection(db, 'artifacts', appId, 'public', 'data', 'orders');
    await addDoc(ordersCol, { ...order, createdAt: serverTimestamp() });
}

async function loadCartData() {
    if (!currentUser) return;
    try {
        const cartRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'cart', 'current');
        const docSnap = await getDoc(cartRef);
        if (docSnap.exists()) {
            const dataItems = docSnap.data().items;
            cart = dataItems ? dataItems : [];
        } else {
            cart = [];
        }
        updateCartUI();
    } catch (error) {
        console.error("Erro ao carregar carrinho:", error);
    }
}

async function saveCartData() {
    if (!currentUser) return;
    try {
        const cartRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'cart', 'current');
        await setDoc(cartRef, { items: cart, updatedAt: serverTimestamp() }, { merge: true });
    } catch (error) {
        console.error("Erro ao guardar carrinho:", error);
    }
}

async function loadUserProfileData() {
    if (!currentUser || currentUser.isAnonymous) return;
    try {
        const profRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'cart', 'profile');
        const snap = await getDoc(profRef);
        const fallbackName = currentUser.displayName ? currentUser.displayName : '';
        if (snap.exists()) {
            const d = snap.data();
            userProfile = {
                name: d.name ? d.name : fallbackName,
                matricula: d.matricula ? d.matricula : '',
                cpf: d.cpf ? d.cpf : '',
                phone: d.phone ? d.phone : ''
            };
        } else {
            userProfile = { name: fallbackName, matricula: '', cpf: '', phone: '' };
        }
    } catch (err) {
        console.error("Erro ao carregar perfil:", err);
    }
}

async function saveUserProfileData() {
    if (!currentUser || currentUser.isAnonymous) return;
    try {
        const profRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'cart', 'profile');
        await setDoc(profRef, { ...userProfile, updatedAt: serverTimestamp() }, { merge: true });
    } catch (err) {
        console.error("Erro ao guardar perfil:", err);
    }
}

// ============================================================================
// 10. MODAL "MEU PERFIL" (DADOS, MATRÍCULA, TROCA DE SENHA E MEUS PEDIDOS)
// ============================================================================
function openProfileModal() {
    if (!currentUser || currentUser.isAnonymous) {
        openAuthModal();
        return;
    }
    const uEmail = currentUser.email ? currentUser.email : '';
    const uName = userProfile.name ? userProfile.name : (currentUser.displayName ? currentUser.displayName : '');

    document.getElementById('profile-header-email').textContent = uEmail;
    document.getElementById('profile-name').value = uName;
    document.getElementById('profile-matricula').value = userProfile.matricula ? userProfile.matricula : '';
    document.getElementById('profile-cpf').value = userProfile.cpf ? userProfile.cpf : '';
    document.getElementById('profile-phone').value = userProfile.phone ? userProfile.phone : '';
    document.getElementById('profile-new-password').value = '';

    window.switchProfileTab('dados');
    showModal('profile');
}

window.switchProfileTab = function(tab) {
    const btnData = document.getElementById('tab-profile-data');
    const btnOrders = document.getElementById('tab-profile-orders');
    const formPanel = document.getElementById('profile-form');
    const ordersPanel = document.getElementById('profile-orders-panel');

    if (tab === 'dados') {
        btnData.className = "flex-1 py-2.5 text-xs font-black uppercase rounded-xl bg-white shadow-sm text-furiozo-dark transition-all";
        btnOrders.className = "flex-1 py-2.5 text-xs font-black uppercase rounded-xl text-gray-500 hover:text-furiozo-dark transition-all";
        formPanel.classList.remove('hidden');
        ordersPanel.classList.add('hidden');
    } else {
        btnOrders.className = "flex-1 py-2.5 text-xs font-black uppercase rounded-xl bg-white shadow-sm text-furiozo-dark transition-all";
        btnData.className = "flex-1 py-2.5 text-xs font-black uppercase rounded-xl text-gray-500 hover:text-furiozo-dark transition-all";
        formPanel.classList.add('hidden');
        ordersPanel.classList.remove('hidden');
        renderUserOrdersHistory();
    }
};

function renderUserOrdersHistory() {
    const container = document.getElementById('profile-orders-panel');
    if (!container || !currentUser) return;

    const myOrders = ordersList.filter(o => o.userId === currentUser.uid || o.customerEmail === currentUser.email);
    if (myOrders.length === 0) {
        container.innerHTML = `
            <div class="text-center py-10 text-gray-400">
                <i class="fa-solid fa-bag-shopping text-4xl mb-2"></i>
                <p class="font-bold text-sm">Ainda não realizou nenhum pedido.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = myOrders.map(o => {
        const dateStr = o.createdAtISO ? new Date(o.createdAtISO).toLocaleString('pt-BR') : '';
        const itemsArr = o.items ? o.items : [];
        const itemsList = itemsArr.map(i => {
            const nVal = i.customName ? i.customName : '-';
            const numVal = i.customNumber ? i.customNumber : '-';
            const customTag = (i.customName || i.customNumber)
                ? ' [Nome: ' + nVal + ' / Nº: ' + numVal + ']'
                : '';
            return '<div class="text-xs text-gray-700">• <strong>' + i.quantity + 'x ' + i.name + '</strong> (Tam: ' + i.size + ')' + customTag + '</div>';
        }).join('');

        const totalFormatted = formatPrice(o.total);

        return `
            <div class="bg-gray-50 p-4 rounded-2xl border border-gray-200 space-y-2">
                <div class="flex justify-between items-center">
                    <span class="font-sport font-black text-sm text-furiozo-dark">Pedido #${o.orderId}</span>
                    <span class="bg-green-100 text-green-800 text-[10px] font-black px-2.5 py-0.5 rounded-full uppercase">${o.status}</span>
                </div>
                <p class="text-[11px] text-gray-500">${dateStr} • ${o.paymentMethod}</p>
                <div class="space-y-1 pt-1 border-t border-gray-200">${itemsList}</div>
                <div class="flex justify-between items-center pt-2 border-t border-gray-200">
                    <span class="font-black text-furiozo-dark text-sm">Total: ${totalFormatted}</span>
                    <button type="button" onclick="window.reopenOrderReceipt('${o.orderId}')" class="text-xs font-bold text-green-700 hover:underline flex items-center gap-1">
                        <i class="fa-brands fa-whatsapp"></i> Ver Comprovante
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

window.reopenOrderReceipt = function(orderId) {
    const found = ordersList.find(o => o.orderId === orderId);
    if (found) {
        closeModal('profile');
        setTimeout(() => showOrderReceiptModal(found), 200);
    }
};

document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser || currentUser.isAnonymous) return;

    const name = document.getElementById('profile-name').value.trim();
    const matricula = document.getElementById('profile-matricula').value.replace(/\D/g, '');
    const cpf = document.getElementById('profile-cpf').value.trim();
    const phone = document.getElementById('profile-phone').value.trim();
    const newPass = document.getElementById('profile-new-password').value;

    if (matricula && matricula.length !== 12) {
        showToast("A Matrícula UERJ deve ter exatamente 12 dígitos.", "error");
        return;
    }

    try {
        if (name && name !== currentUser.displayName) {
            await updateProfile(currentUser, { displayName: name });
        }
        userProfile = { name, matricula, cpf, phone };
        await saveUserProfileData();

        if (newPass && newPass.length >= 6) {
            await updatePassword(currentUser, newPass);
            document.getElementById('profile-new-password').value = '';
            showToast("Perfil e nova senha guardados com sucesso!");
        } else {
            showToast("Dados do perfil atualizados com sucesso!");
        }
        updateAuthUI();
    } catch (err) {
        console.error("Erro ao atualizar perfil/senha:", err);
        if (err.code === 'auth/requires-recent-login') {
            showToast("Para alterar a senha, saia e entre novamente na conta por segurança.", "error");
        } else {
            showToast("Dados guardados! (Erro ao atualizar senha).", "error");
        }
    }
});

// ============================================================================
// 11. PAINEL DA DIRETORIA (ADMIN) E EXPORTAÇÃO EXCEL (.XLSX)
// ============================================================================
function calculateBatchMetrics() {
    let totalShirtsInBatch = 0;
    let totalRevenue = 0;

    ordersList.forEach(order => {
        const orderTotal = order.total ? order.total : 0;
        totalRevenue += Number(orderTotal);
        const itemsArr = order.items ? order.items : [];
        itemsArr.forEach(item => {
            if (item.isShirt && item.deliveryMode === 'lote') {
                const itemQty = item.quantity ? item.quantity : 0;
                totalShirtsInBatch += Number(itemQty);
            }
        });
    });

    return { totalShirtsInBatch, totalRevenue, totalOrders: ordersList.length };
}

function updateBatchCountersUI() {
    const { totalShirtsInBatch, totalRevenue, totalOrders } = calculateBatchMetrics();
    const goal = PRICING_RULES.BATCH_MIN_GOAL;

    const adminBatchCount = document.getElementById('admin-batch-count');
    const adminBatchBar = document.getElementById('admin-batch-bar');
    const adminBatchBadge = document.getElementById('admin-batch-status-badge');
    const adminOrdersCount = document.getElementById('admin-orders-count');
    const adminRevenueTotal = document.getElementById('admin-revenue-total');

    if (adminBatchCount) adminBatchCount.textContent = totalShirtsInBatch + ' / ' + goal + ' camisas';
    if (adminBatchBar) {
        const pct = Math.min(100, Math.round((totalShirtsInBatch / goal) * 100));
        adminBatchBar.style.width = pct + '%';
    }
    if (adminBatchBadge) {
        if (totalShirtsInBatch >= goal) {
            adminBatchBadge.textContent = "Meta Atingida! Pronto p/ Fábrica";
            adminBatchBadge.className = "text-[11px] font-black px-2.5 py-0.5 rounded-full bg-green-100 text-green-800";
        } else {
            const remaining = goal - totalShirtsInBatch;
            adminBatchBadge.textContent = 'Faltam ' + remaining + ' p/ fechar lote';
            adminBatchBadge.className = "text-[11px] font-black px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800";
        }
    }
    if (adminOrdersCount) adminOrdersCount.textContent = String(totalOrders);
    if (adminRevenueTotal) adminRevenueTotal.textContent = formatPrice(totalRevenue);
}

function renderAdminPanel() {
    if (!isCurrentUserAdmin()) {
        showToast("Acesso restrito ao administrador.", "error");
        return;
    }

    updateBatchCountersUI();

    const prodTbody = document.getElementById('admin-products-tbody');
    if (prodTbody) {
        prodTbody.innerHTML = productsCatalog.map(p => {
            const selDisp = p.status === 'disponivel' ? 'selected' : '';
            const selBreve = p.status === 'em_breve' ? 'selected' : '';
            const selEsg = p.status === 'esgotado' ? 'selected' : '';
            const stVal = p.immediateStock ? p.immediateStock : 0;

            return `
            <tr class="hover:bg-gray-50">
                <td class="py-3 px-3 font-bold text-furiozo-dark">${p.name}</td>
                <td class="py-3 px-3">
                    <select id="admin-status-${p.id}" class="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs font-bold bg-white">
                        <option value="disponivel" ${selDisp}>Disponível p/ Compra</option>
                        <option value="em_breve" ${selBreve}>Selo "EM BREVE" (Ocultar Preço)</option>
                        <option value="esgotado" ${selEsg}>Esgotado</option>
                    </select>
                </td>
                <td class="py-3 px-3">
                    <input type="number" step="0.50" id="admin-price-${p.id}" value="${p.price}" class="w-24 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs font-bold">
                </td>
                <td class="py-3 px-3">
                    <input type="number" min="0" id="admin-stock-${p.id}" value="${stVal}" class="w-20 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-center">
                </td>
                <td class="py-3 px-3 text-right">
                    <button onclick="window.saveAdminProduct('${p.id}')" class="bg-furiozo-dark text-[#ccff00] hover:bg-[#ccff00] hover:text-furiozo-dark font-black px-3 py-1.5 rounded-lg text-xs uppercase transition-all">
                        Salvar
                    </button>
                </td>
            </tr>
            `;
        }).join('');
    }

    const ordersTbody = document.getElementById('admin-orders-tbody');
    if (ordersTbody) {
        if (ordersList.length === 0) {
            ordersTbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-gray-400 font-medium">Nenhum pedido registado até ao momento.</td></tr>';
        } else {
            ordersTbody.innerHTML = ordersList.map(o => {
                const dateFormatted = o.createdAtISO ? new Date(o.createdAtISO).toLocaleString('pt-BR') : 'Recente';
                const itemsArr = o.items ? o.items : [];
                const itemsSummary = itemsArr.map(i => {
                    const nVal = i.customName ? i.customName : '-';
                    const numVal = i.customNumber ? i.customNumber : '-';
                    const customStr = (i.customName || i.customNumber)
                        ? ' [Nome: <strong>' + nVal + '</strong> / Nº: <strong>' + numVal + '</strong>]'
                        : ' [Sem personalização]';
                    return '<div class="text-xs mb-1"><strong>' + i.quantity + 'x ' + i.name + '</strong> (Tam: ' + i.size + ')' + customStr + '</div>';
                }).join('');

                const modesSummary = itemsArr.map(i =>
                    i.deliveryMode === 'imediata'
                        ? '<span class="inline-block bg-[#ccff00] text-furiozo-dark text-[10px] font-black px-2 py-0.5 rounded uppercase">Pronta Entrega</span>'
                        : '<span class="inline-block bg-gray-100 text-gray-700 text-[10px] font-bold px-2 py-0.5 rounded uppercase">Lote</span>'
                ).join('<br>');

                const oId = o.orderId ? o.orderId : '-';
                const matVal = o.customerMatricula ? o.customerMatricula : (o.customerCourse ? o.customerCourse : '-');
                const payVal = o.paymentMethod ? o.paymentMethod : 'PIX';
                const totFormatted = formatPrice(o.total);

                return `
                    <tr class="hover:bg-gray-50 align-top">
                        <td class="py-3 px-2 text-xs text-gray-500 font-mono">
                            <strong>#${oId}</strong><br>${dateFormatted}
                        </td>
                        <td class="py-3 px-2 text-xs">
                            <strong class="text-gray-800">${o.customerName}</strong><br>
                            <span class="font-mono text-[11px] text-furiozo-dark font-bold">Mat: ${matVal}</span><br>
                            <span class="text-gray-500">${o.customerPhone}</span>
                        </td>
                        <td class="py-3 px-2">${itemsSummary}</td>
                        <td class="py-3 px-2">${modesSummary}</td>
                        <td class="py-3 px-2 text-xs font-bold text-teal-700">
                            ${payVal}<br>
                            <span class="text-[10px] text-green-600 uppercase">${o.status}</span>
                        </td>
                        <td class="py-3 px-2 font-black text-furiozo-dark text-sm">${totFormatted}</td>
                    </tr>
                `;
            }).join('');
        }
    }
}

window.saveAdminProduct = async function(productId) {
    if (!isCurrentUserAdmin()) return;
    const prod = productsCatalog.find(p => p.id === productId);
    if (!prod) return;

    const newStatus = document.getElementById('admin-status-' + productId).value;
    const newPrice = parseFloat(document.getElementById('admin-price-' + productId).value);
    const rawStock = parseInt(document.getElementById('admin-stock-' + productId).value, 10);
    const newStock = isNaN(rawStock) ? 0 : rawStock;

    prod.status = newStatus;
    if (!isNaN(newPrice) && newPrice >= 0) prod.price = newPrice;
    prod.immediateStock = Math.max(0, newStock);

    await saveProductToFirestore(prod);
    renderProducts();
    renderAdminPanel();
    showToast('Produto "' + prod.name + '" atualizado na vitrine!');
};

document.getElementById('btn-export-excel').addEventListener('click', () => {
    if (!isCurrentUserAdmin()) return;
    if (typeof XLSX === 'undefined') {
        showToast("Biblioteca Excel ainda a carregar. Tente novamente.", "error");
        return;
    }
    if (ordersList.length === 0) {
        showToast("Não há pedidos registados para exportar.", "error");
        return;
    }

    const factoryRows = [];
    const financialRows = [];

    ordersList.forEach(order => {
        const dateStr = order.createdAtISO ? new Date(order.createdAtISO).toLocaleString('pt-BR') : '';
        const matriculaStr = order.customerMatricula ? order.customerMatricula : (order.customerCourse ? order.customerCourse : '');
        const subVal = order.subtotal ? order.subtotal : (order.total ? order.total : 0);
        const feeVal = order.installmentFee ? order.installmentFee : 0;
        const totVal = order.total ? order.total : 0;

        financialRows.push({
            "ID Pedido": order.orderId ? order.orderId : '',
            "ID Transação MP": order.mpPaymentId ? order.mpPaymentId : '',
            "Data": dateStr,
            "Aluno": order.customerName ? order.customerName : '',
            "Matrícula UERJ": matriculaStr,
            "E-mail": order.customerEmail ? order.customerEmail : '',
            "WhatsApp": order.customerPhone ? order.customerPhone : '',
            "CPF": order.customerCpf ? order.customerCpf : '',
            "Método Pagamento": order.paymentMethod ? order.paymentMethod : '',
            "Status": order.status ? order.status : '',
            "Subtotal Produtos (R$)": Number(subVal),
            "Taxa Parcelamento (R$)": Number(feeVal),
            "Valor Total Pago (R$)": Number(totVal)
        });

        const itemsArr = order.items ? order.items : [];
        itemsArr.forEach(item => {
            const qtyNum = Number(item.quantity ? item.quantity : 1);
            const priceNum = Number(item.price ? item.price : 0);
            factoryRows.push({
                "ID Pedido": order.orderId ? order.orderId : '',
                "Data": dateStr,
                "Aluno": order.customerName ? order.customerName : '',
                "Matrícula UERJ": matriculaStr,
                "WhatsApp": order.customerPhone ? order.customerPhone : '',
                "Produto": item.name ? item.name : '',
                "Tamanho": item.size ? item.size : 'Único',
                "Nome Personalizado (Costas)": item.customName ? item.customName : 'SEM NOME',
                "Número (Costas)": item.customNumber !== '' ? item.customNumber : 'SEM NÚMERO',
                "Modalidade Entrega": item.deliveryMode === 'imediata' ? 'PRONTA ENTREGA (+R$ 10)' : 'LOTE (ENCOMENDA)',
                "Quantidade": qtyNum,
                "Valor Unitário (R$)": priceNum,
                "Subtotal Item (R$)": Number(priceNum * qtyNum),
                "Status Pagamento": order.status ? order.status : 'Confirmado'
            });
        });
    });

    const wb = XLSX.utils.book_new();
    const wsFactory = XLSX.utils.json_to_sheet(factoryRows);
    const wsFinancial = XLSX.utils.json_to_sheet(financialRows);

    XLSX.utils.book_append_sheet(wb, wsFactory, "Itens_Para_Fabrica");
    XLSX.utils.book_append_sheet(wb, wsFinancial, "Resumo_Financeiro");

    const fileName = 'Relatorio_Pedidos_FurioZOs_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    XLSX.writeFile(wb, fileName);
    showToast("Relatório Excel (.xlsx) gerado com sucesso!");
});

// ============================================================================
// 12. AUTENTICAÇÃO E CONTROLO DE MODAIS
// ============================================================================
function openCartSidebar() {
    modalBackdrop.classList.remove('hidden');
    setTimeout(() => {
        modalBackdrop.classList.remove('opacity-0');
        cartSidebar.classList.remove('translate-x-full');
    }, 10);
}

function closeCartSidebar() {
    cartSidebar.classList.add('translate-x-full');
    modalBackdrop.classList.add('opacity-0');
    setTimeout(() => { modalBackdrop.classList.add('hidden'); }, 250);
}

function getModalElements(type) {
    if (type === 'product') return { target: productModal, content: productModalContent };
    if (type === 'checkout') return { target: checkoutModal, content: checkoutModalContent };
    if (type === 'admin') return { target: adminModal, content: adminModalContent };
    if (type === 'profile') return { target: profileModal, content: profileModalContent };
    if (type === 'receipt') return { target: receiptModal, content: receiptModalContent };
    return { target: authModal, content: authModalContent };
}

function showModal(type) {
    modalBackdrop.classList.remove('hidden');
    const { target, content } = getModalElements(type);
    target.classList.remove('hidden');
    setTimeout(() => {
        modalBackdrop.classList.remove('opacity-0');
        content.classList.remove('scale-95', 'opacity-0');
    }, 10);
}

function closeModal(type) {
    if (type === 'checkout') stopPixPolling();
    const { target, content } = getModalElements(type);
    if (!target || !content) return;
    content.classList.add('scale-95', 'opacity-0');
    modalBackdrop.classList.add('opacity-0');
    setTimeout(() => {
        target.classList.add('hidden');
        if (cartSidebar.classList.contains('translate-x-full')) {
            modalBackdrop.classList.add('hidden');
        }
    }, 200);
}

document.getElementById('btn-cart-nav').addEventListener('click', openCartSidebar);
document.getElementById('btn-cart-mobile').addEventListener('click', openCartSidebar);
document.getElementById('close-cart').addEventListener('click', closeCartSidebar);
document.getElementById('btn-continue-shopping').addEventListener('click', closeCartSidebar);

document.getElementById('close-product').addEventListener('click', () => closeModal('product'));
document.getElementById('close-product-mobile').addEventListener('click', () => closeModal('product'));
document.getElementById('close-auth').addEventListener('click', () => closeModal('auth'));
document.getElementById('close-checkout').addEventListener('click', () => closeModal('checkout'));
document.getElementById('close-admin').addEventListener('click', () => closeModal('admin'));
document.getElementById('close-profile').addEventListener('click', () => closeModal('profile'));
document.getElementById('close-receipt').addEventListener('click', () => closeModal('receipt'));

document.getElementById('btn-profile-nav').addEventListener('click', openProfileModal);
document.getElementById('btn-profile-mobile').addEventListener('click', () => {
    document.getElementById('mobile-menu').classList.add('hidden');
    openProfileModal();
});

document.getElementById('btn-admin-nav').addEventListener('click', async () => {
    if (!isCurrentUserAdmin()) return;
    await loadInitialData();
    renderAdminPanel();
    showModal('admin');
});
document.getElementById('btn-admin-mobile').addEventListener('click', async () => {
    if (!isCurrentUserAdmin()) return;
    document.getElementById('mobile-menu').classList.add('hidden');
    await loadInitialData();
    renderAdminPanel();
    showModal('admin');
});

modalBackdrop.addEventListener('click', () => {
    closeModal('product');
    closeModal('auth');
    closeModal('checkout');
    closeModal('admin');
    closeModal('profile');
    closeModal('receipt');
    closeCartSidebar();
});

let authMode = 'login';
const authForm = document.getElementById('auth-form');
const authError = document.getElementById('auth-error');

function openAuthModal() {
    setAuthMode('login');
    authForm.reset();
    authError.classList.add('hidden');
    showModal('auth');
}

function setAuthMode(mode) {
    authMode = mode;
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const nameField = document.getElementById('name-field');
    const extraFields = document.getElementById('register-extra-fields');
    const btnSubmit = document.getElementById('btn-auth-submit');
    const authTitle = document.getElementById('auth-title');

    authError.classList.add('hidden');

    if (mode === 'login') {
        tabLogin.className = "flex-1 py-2 text-sm font-bold rounded-lg bg-white shadow-sm text-furiozo-dark transition-all";
        tabRegister.className = "flex-1 py-2 text-sm font-bold rounded-lg text-gray-500 hover:text-furiozo-dark transition-all bg-transparent";
        nameField.classList.add('hidden');
        extraFields.classList.add('hidden');
        document.getElementById('auth-name').removeAttribute('required');
        btnSubmit.textContent = 'Entrar';
        authTitle.textContent = 'Acessar Conta';
    } else {
        tabRegister.className = "flex-1 py-2 text-sm font-bold rounded-md bg-white shadow-sm text-furiozo-dark transition-all";
        tabLogin.className = "flex-1 py-2 text-sm font-bold rounded-md text-gray-500 hover:text-furiozo-dark transition-all bg-transparent";
        nameField.classList.remove('hidden');
        extraFields.classList.remove('hidden');
        document.getElementById('auth-name').setAttribute('required', 'true');
        btnSubmit.textContent = 'Cadastrar';
        authTitle.textContent = 'Criar Conta';
    }
}

document.getElementById('tab-login').addEventListener('click', () => setAuthMode('login'));
document.getElementById('tab-register').addEventListener('click', () => setAuthMode('register'));

document.getElementById('btn-forgot-password').addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value.trim();
    if (!email) {
        authError.classList.remove('hidden');
        authError.textContent = 'Digite o seu e-mail no campo acima para receber o link de recuperação.';
        return;
    }
    try {
        await sendPasswordResetEmail(auth, email);
        showToast('Link de recuperação enviado para ' + email + '! Verifique a caixa de entrada e o spam.');
        authError.classList.add('hidden');
    } catch (err) {
        authError.classList.remove('hidden');
        authError.textContent = 'Não foi possível enviar o e-mail de recuperação. Verifique o endereço introduzido.';
    }
});

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const pass = document.getElementById('auth-pass').value;
    const name = document.getElementById('auth-name').value.trim();
    const matricula = document.getElementById('auth-matricula').value.replace(/\D/g, '');
    const btn = document.getElementById('btn-auth-submit');

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Aguarde...';
    authError.classList.add('hidden');

    try {
        if (authMode === 'login') {
            await signInWithEmailAndPassword(auth, email, pass);
            showToast("Login realizado com sucesso!");
        } else {
            const userCredential = await createUserWithEmailAndPassword(auth, email, pass);
            await updateProfile(userCredential.user, { displayName: name });
            userProfile = { name, matricula: matricula.slice(0, 12), cpf: '', phone: '' };
            await saveUserProfileData();
            showToast("Conta criada com sucesso!");
        }
        closeModal('auth');
    } catch (error) {
        console.error("Auth Error:", error);
        authError.classList.remove('hidden');
        if (error.code === 'auth/email-already-in-use') authError.textContent = 'E-mail já registado.';
        else if (error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') authError.textContent = 'E-mail ou senha incorretos.';
        else if (error.code === 'auth/weak-password') authError.textContent = 'A senha deve ter pelo menos 6 caracteres.';
        else authError.textContent = 'Erro ao autenticar. Tente novamente.';
    } finally {
        btn.disabled = false;
        btn.textContent = authMode === 'login' ? 'Entrar' : 'Cadastrar';
    }
});

function updateAuthUI() {
    const isGuest = !currentUser || currentUser.isAnonymous;
    const btnLoginNav = document.getElementById('btn-login-nav');
    const userInfoNav = document.getElementById('user-info-nav');
    const usernameSpan = document.getElementById('nav-username');
    const btnLoginMobile = document.getElementById('btn-login-mobile');
    const userInfoMobile = document.getElementById('user-info-mobile');
    const usernameMobile = document.getElementById('mobile-username');
    const btnAdminNav = document.getElementById('btn-admin-nav');
    const btnAdminMobile = document.getElementById('btn-admin-mobile');

    if (isCurrentUserAdmin()) {
        btnAdminNav.classList.remove('hidden');
        btnAdminMobile.classList.remove('hidden');
    } else {
        btnAdminNav.classList.add('hidden');
        btnAdminMobile.classList.add('hidden');
    }

    if (isGuest) {
        btnLoginNav.classList.remove('hidden');
        userInfoNav.classList.add('hidden');
        userInfoNav.classList.remove('flex');
        btnLoginMobile.classList.remove('hidden');
        userInfoMobile.classList.add('hidden');
        userInfoMobile.classList.remove('flex');
    } else {
        const emailPrefix = currentUser.email ? currentUser.email.split('@')[0] : 'Meu Perfil';
        const displayName = userProfile.name ? userProfile.name : (currentUser.displayName ? currentUser.displayName : emailPrefix);
        btnLoginNav.classList.add('hidden');
        userInfoNav.classList.remove('hidden');
        userInfoNav.classList.add('flex');
        usernameSpan.textContent = displayName;

        btnLoginMobile.classList.add('hidden');
        userInfoMobile.classList.remove('hidden');
        userInfoMobile.classList.add('flex');
        usernameMobile.textContent = displayName;
    }
}

document.getElementById('btn-login-nav').addEventListener('click', openAuthModal);
document.getElementById('btn-login-mobile').addEventListener('click', () => {
    document.getElementById('mobile-menu').classList.add('hidden');
    openAuthModal();
});

const handleLogout = async () => {
    try {
        await signOut(auth);
        userProfile = { name: '', matricula: '', cpf: '', phone: '' };
        await signInAnonymously(auth);
        closeModal('admin');
        closeModal('profile');
        showToast("Sessão terminada.");
    } catch (err) {
        console.error(err);
    }
};

document.getElementById('btn-logout').addEventListener('click', handleLogout);
document.getElementById('btn-logout-mobile').addEventListener('click', handleLogout);

async function initAuthAndData() {
    await loadInitialData();

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            currentUser = user;
            await loadUserProfileData();
            updateAuthUI();
            await loadCartData();
        } else {
            currentUser = null;
            cart = [];
            updateCartUI();
            updateAuthUI();
        }
    });

    try {
        await signInAnonymously(auth);
    } catch (err) {
        console.error("Auth init error:", err);
    }
}

const swiperMain = new Swiper('.mySwiper', {
    loop: true,
    grabCursor: true,
    autoplay: { delay: 5000, disableOnInteraction: false },
    navigation: { nextEl: '#next-slide', prevEl: '#prev-slide' },
});

document.getElementById('mobile-menu-btn').addEventListener('click', () => {
    document.getElementById('mobile-menu').classList.toggle('hidden');
});

initAuthAndData();