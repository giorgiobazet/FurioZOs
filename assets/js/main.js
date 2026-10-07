// main.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// Global State & Config
const appId = typeof __app_id !== 'undefined' ? __app_id : 'furiozos-app';
let firebaseConfig;
try {
    firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
        // Dummy config fallback, will fail without real environment but structure is correct
        apiKey: "mock-api-key", projectId: "mock-project", appId: "mock-app"
    };
} catch (e) { console.error("Error parsing firebase config", e); }

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let currentUser = null;
let cart = [];
let isAuthLoading = true;

// Mock Product Data
const PRODUCTS = [
    { id: 'p1', name: 'Caneca FurioZOs', price: 45.00, img: 'https://placehold.co/400x400/1F4229/8A9A4A?text=Caneca+Oficial', hasSize: false, desc: 'Caneca oficial da atlética, 500ml de pura energia da ZO. Perfeita para as choppadas.' },
    { id: 'p2', name: 'Camisa Especial Limitada', price: 120.00, img: 'https://placehold.co/400x400/8A9A4A/1F4229?text=Camisa+Diretoria', hasSize: true, desc: 'Edição limitada "Sapo Bombado". Tecido premium dry-fit, detalhes em dourado e verde oliva.' },
    { id: 'p3', name: 'Camisa de Jogo', price: 85.00, img: 'https://placehold.co/400x400/1F4229/FFFFFF?text=Camisa+de+Jogo', hasSize: true, desc: 'Camisa oficial para atletas e guerreiros. Material leve, ideal para a prática esportiva.' },
    { id: 'p4', name: 'Camisa de Torcida', price: 70.00, img: 'https://placehold.co/400x400/E5F0D8/1F4229?text=Camisa+Torcida', hasSize: true, desc: 'Mostre seu apoio nas arquibancadas! Malha 100% algodão, confortável e com estampa exclusiva.' },
    { id: 'p5', name: 'Bandana FurioZOs', price: 25.00, img: 'https://placehold.co/400x400/1F4229/8A9A4A?text=Bandana', hasSize: false, desc: 'Acessório indispensável. Use na cabeça, no pescoço ou amarrada na mochila. Estilo puramente ZO.' },
];

let selectedProduct = null;
let selectedSize = null;

// DOM Elements
const grid = document.getElementById('product-grid');
const modalBackdrop = document.getElementById('modal-backdrop');
const productModal = document.getElementById('product-modal');
const productModalContent = document.getElementById('product-modal-content');
const cartSidebar = document.getElementById('cart-sidebar');
const authModal = document.getElementById('auth-modal');
const authModalContent = document.getElementById('auth-modal-content');

// Cart UI
const cartBadge = document.getElementById('cart-badge');
const cartBadgeMobile = document.getElementById('cart-badge-mobile');
const cartItemsContainer = document.getElementById('cart-items-container');
const cartTotalEl = document.getElementById('cart-total');
const emptyCartMsg = document.getElementById('empty-cart-msg');

// Utils
const formatPrice = (price) => `R$ ${price.toFixed(2).replace('.', ',')}`;
const showToast = (message, type = 'success') => {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? '!bg-red-600' : ''}`;
    toast.innerHTML = `<i class="fa-solid ${type === 'error' ? 'fa-triangle-exclamation' : 'fa-check-circle'}"></i> ${message}`;
    document.getElementById('toast-container').appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
};

// Render Products
function renderProducts() {
    grid.innerHTML = PRODUCTS.map(p => `
        <div class="bg-white rounded-2xl shadow-md overflow-hidden hover:shadow-xl transition-shadow duration-300 flex flex-col border border-gray-100">
            <div class="relative pb-[100%] cursor-pointer group" onclick="window.openProductModal('${p.id}')">
                <img src="${p.img}" alt="${p.name}" class="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
            </div>
            <div class="p-5 flex flex-col flex-grow">
                <h3 class="font-sport text-lg text-furiozo-dark uppercase mb-1 flex-grow cursor-pointer hover:text-furiozo-light transition-colors" onclick="window.openProductModal('${p.id}')">${p.name}</h3>
                <div class="flex justify-between items-center mt-4">
                    <span class="font-bold text-xl text-gray-800">${formatPrice(p.price)}</span>
                    <button onclick="window.openProductModal('${p.id}')" class="bg-furiozo-light text-white w-10 h-10 rounded-full flex items-center justify-center hover:bg-furiozo-dark transition-colors shadow-sm">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
            </div>
        </div>
    `).join('');
}

// Initialize Auth
async function initAuth() {
    try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
            await signInWithCustomToken(auth, __initial_auth_token);
        } else {
            await signInAnonymously(auth);
        }
    } catch (err) {
        console.error("Auth init error:", err);
    }
}

onAuthStateChanged(auth, async (user) => {
    isAuthLoading = false;
    if (user) {
        currentUser = user;
        updateAuthUI();
        await loadCartFromFirestore();
    } else {
        currentUser = null;
        cart = [];
        updateCartUI();
        updateAuthUI();
    }
});

initAuth();

// Cart Logic
async function loadCartFromFirestore() {
    if (!currentUser) return;
    try {
        const cartRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'cart', 'current');
        const docSnap = await getDoc(cartRef);
        if (docSnap.exists()) {
            cart = docSnap.data().items || [];
        } else {
            cart = [];
        }
        updateCartUI();
    } catch (error) {
        console.error("Error loading cart:", error);
    }
}

async function saveCartToFirestore() {
    if (!currentUser) return;
    try {
        const cartRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'cart', 'current');
        await setDoc(cartRef, { items: cart, updatedAt: serverTimestamp() }, { merge: true });
    } catch (error) {
        console.error("Error saving cart:", error);
        showToast("Erro ao salvar carrinho no servidor.", "error");
    }
}

window.addToCart = async function() {
    if (!selectedProduct) return;
    
    const qty = parseInt(document.getElementById('qty-input').value);
    
    if (selectedProduct.hasSize && !selectedSize) {
        document.getElementById('size-error').classList.remove('hidden');
        return;
    }

    const cartItem = {
        id: selectedProduct.id,
        name: selectedProduct.name,
        price: selectedProduct.price,
        img: selectedProduct.img,
        size: selectedSize || 'Único',
        quantity: qty,
        cartItemId: `${selectedProduct.id}-${selectedSize || 'unico'}`
    };

    const existingIndex = cart.findIndex(item => item.cartItemId === cartItem.cartItemId);
    if (existingIndex > -1) {
        cart[existingIndex].quantity += qty;
    } else {
        cart.push(cartItem);
    }

    updateCartUI();
    closeModal('product');
    showToast(`${qty}x ${selectedProduct.name} adicionado!`);
    
    await saveCartToFirestore();
    setTimeout(openCartSidebar, 300);
};

window.removeFromCart = async function(cartItemId) {
    cart = cart.filter(item => item.cartItemId !== cartItemId);
    updateCartUI();
    await saveCartToFirestore();
};

window.updateQuantity = async function(cartItemId, delta) {
    const item = cart.find(i => i.cartItemId === cartItemId);
    if (item) {
        item.quantity += delta;
        if (item.quantity <= 0) {
            window.removeFromCart(cartItemId);
        } else {
            updateCartUI();
            await saveCartToFirestore();
        }
    }
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
        return `
        <div class="flex gap-4 bg-white p-3 rounded-lg shadow-sm border border-gray-100">
            <img src="${item.img}" class="w-20 h-20 object-cover rounded-md border border-gray-200">
            <div class="flex-grow flex flex-col justify-between">
                <div class="flex justify-between items-start">
                    <h4 class="font-bold text-sm text-gray-800 leading-tight">${item.name}</h4>
                    <button onclick="window.removeFromCart('${item.cartItemId}')" class="text-gray-400 hover:text-red-500 transition-colors"><i class="fa-solid fa-trash"></i></button>
                </div>
                <p class="text-xs text-gray-500 mb-1">Tam: ${item.size}</p>
                <div class="flex justify-between items-center mt-auto">
                    <div class="flex items-center border border-gray-200 rounded px-2 py-1 bg-gray-50">
                        <button onclick="window.updateQuantity('${item.cartItemId}', -1)" class="text-gray-500 hover:text-furiozo-dark px-1"><i class="fa-solid fa-minus text-[10px]"></i></button>
                        <span class="mx-2 text-sm font-medium w-4 text-center">${item.quantity}</span>
                        <button onclick="window.updateQuantity('${item.cartItemId}', 1)" class="text-gray-500 hover:text-furiozo-dark px-1"><i class="fa-solid fa-plus text-[10px]"></i></button>
                    </div>
                    <span class="font-bold text-furiozo-dark">${formatPrice(itemTotal)}</span>
                </div>
            </div>
        </div>
        `;
    }).join('');

    cartTotalEl.textContent = formatPrice(totalValue);
}

// Checkout
document.getElementById('btn-checkout').addEventListener('click', async () => {
    if (cart.length === 0) return;
    
    if (!currentUser || currentUser.isAnonymous) {
        closeCartSidebar();
        openAuthModal();
        showToast("Por favor, faça login ou cadastre-se para finalizar a compra.", "error");
        return;
    }

    try {
        const orderRef = collection(db, 'artifacts', appId, 'users', currentUser.uid, 'orders');
        await addDoc(orderRef, {
            items: cart,
            total: cart.reduce((sum, item) => sum + (item.price * item.quantity), 0),
            status: 'pendente_pagamento',
            createdAt: serverTimestamp()
        });
        
        cart = [];
        await saveCartToFirestore();
        updateCartUI();
        closeCartSidebar();
        
        const msg = `Pedido realizado com sucesso!\nEntraremos em contato para finalizar o pagamento via PIX.`;
        showToast(msg);
        
    } catch (err) {
        console.error("Checkout error:", err);
        showToast("Erro ao finalizar compra.", "error");
    }
});

// Modals Setup
window.openProductModal = function(id) {
    selectedProduct = PRODUCTS.find(p => p.id === id);
    if (!selectedProduct) return;

    selectedSize = null;
    document.getElementById('modal-product-img').src = selectedProduct.img;
    document.getElementById('modal-product-name').textContent = selectedProduct.name;
    document.getElementById('modal-product-price').textContent = formatPrice(selectedProduct.price);
    document.getElementById('modal-product-desc').textContent = selectedProduct.desc;
    document.getElementById('qty-input').value = 1;
    document.getElementById('size-error').classList.add('hidden');

    const sizeContainer = document.getElementById('size-selector-container');
    const sizeOptions = document.getElementById('size-options');
    
    if (selectedProduct.hasSize) {
        sizeContainer.classList.remove('hidden');
        sizeOptions.innerHTML = ['P', 'M', 'G', 'GG'].map(size => `
            <button onclick="window.selectSize('${size}', this)" class="size-btn w-10 h-10 rounded-full border-2 border-gray-300 font-bold text-gray-600 hover:border-furiozo-light hover:text-furiozo-dark transition-all focus:outline-none">
                ${size}
            </button>
        `).join('');
    } else {
        sizeContainer.classList.add('hidden');
    }

    showModal('product');
};

window.selectSize = function(size, btnElement) {
    selectedSize = size;
    document.getElementById('size-error').classList.add('hidden');
    document.querySelectorAll('.size-btn').forEach(btn => {
        btn.classList.remove('bg-furiozo-light', 'text-white', 'border-furiozo-light');
        btn.classList.add('border-gray-300', 'text-gray-600');
    });
    btnElement.classList.remove('border-gray-300', 'text-gray-600');
    btnElement.classList.add('bg-furiozo-light', 'text-white', 'border-furiozo-light');
};

document.getElementById('qty-plus').addEventListener('click', () => {
    const input = document.getElementById('qty-input');
    if(input.value < 10) input.value = parseInt(input.value) + 1;
});
document.getElementById('qty-minus').addEventListener('click', () => {
    const input = document.getElementById('qty-input');
    if(input.value > 1) input.value = parseInt(input.value) - 1;
});

document.getElementById('btn-add-to-cart').addEventListener('click', window.addToCart);

// Sidebar Handling
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
    setTimeout(() => {
        modalBackdrop.classList.add('hidden');
    }, 300);
}

function showModal(type) {
    modalBackdrop.classList.remove('hidden');
    const target = type === 'product' ? productModal : authModal;
    const content = type === 'product' ? productModalContent : authModalContent;
    
    target.classList.remove('hidden');
    
    setTimeout(() => {
        modalBackdrop.classList.remove('opacity-0');
        content.classList.remove('scale-95', 'opacity-0');
    }, 10);
}

function closeModal(type) {
    const target = type === 'product' ? productModal : authModal;
    const content = type === 'product' ? productModalContent : authModalContent;
    
    content.classList.add('scale-95', 'opacity-0');
    modalBackdrop.classList.add('opacity-0');
    
    setTimeout(() => {
        target.classList.add('hidden');
        if (cartSidebar.classList.contains('translate-x-full')) {
            modalBackdrop.classList.add('hidden');
        }
    }, 300);
}

document.getElementById('btn-cart-nav').addEventListener('click', openCartSidebar);
document.getElementById('btn-cart-mobile').addEventListener('click', openCartSidebar);
document.getElementById('close-cart').addEventListener('click', closeCartSidebar);
document.getElementById('btn-continue-shopping').addEventListener('click', closeCartSidebar);

document.getElementById('close-product').addEventListener('click', () => closeModal('product'));
document.getElementById('close-product-mobile').addEventListener('click', () => closeModal('product'));
document.getElementById('close-auth').addEventListener('click', () => closeModal('auth'));

modalBackdrop.addEventListener('click', () => {
    closeModal('product');
    closeModal('auth');
    closeCartSidebar();
});

// Auth Flow Setup
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
    const btnSubmit = document.getElementById('btn-auth-submit');
    const authTitle = document.getElementById('auth-title');

    authError.classList.add('hidden');

    if (mode === 'login') {
        tabLogin.className = "flex-1 py-2 text-sm font-bold rounded-md bg-white shadow-sm text-furiozo-dark transition-all";
        tabRegister.className = "flex-1 py-2 text-sm font-bold rounded-md text-gray-500 hover:text-furiozo-dark transition-all bg-transparent";
        nameField.classList.add('hidden');
        document.getElementById('auth-name').removeAttribute('required');
        btnSubmit.textContent = 'Entrar';
        authTitle.textContent = 'Acessar Conta';
    } else {
        tabRegister.className = "flex-1 py-2 text-sm font-bold rounded-md bg-white shadow-sm text-furiozo-dark transition-all";
        tabLogin.className = "flex-1 py-2 text-sm font-bold rounded-md text-gray-500 hover:text-furiozo-dark transition-all bg-transparent";
        nameField.classList.remove('hidden');
        document.getElementById('auth-name').setAttribute('required', 'true');
        btnSubmit.textContent = 'Cadastrar';
        authTitle.textContent = 'Criar Conta';
    }
}

document.getElementById('tab-login').addEventListener('click', () => setAuthMode('login'));
document.getElementById('tab-register').addEventListener('click', () => setAuthMode('register'));

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;
    const pass = document.getElementById('auth-pass').value;
    const name = document.getElementById('auth-name').value;
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
            showToast("Conta criada com sucesso!");
        }
        closeModal('auth');
    } catch (error) {
        console.error("Auth Error:", error);
        authError.classList.remove('hidden');
        if(error.code === 'auth/email-already-in-use') authError.textContent = 'E-mail já cadastrado.';
        else if(error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') authError.textContent = 'E-mail ou senha incorretos.';
        else if(error.code === 'auth/weak-password') authError.textContent = 'A senha deve ter pelo menos 6 caracteres.';
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

    if (isGuest) {
        btnLoginNav.classList.remove('hidden');
        userInfoNav.classList.add('hidden');
        btnLoginMobile.classList.remove('hidden');
        userInfoMobile.classList.add('hidden');
    } else {
        btnLoginNav.classList.add('hidden');
        userInfoNav.classList.remove('hidden');
        userInfoNav.classList.add('flex');
        usernameSpan.textContent = currentUser.displayName || currentUser.email.split('@')[0];
        
        btnLoginMobile.classList.add('hidden');
        userInfoMobile.classList.remove('hidden');
        userInfoMobile.classList.add('flex');
        usernameMobile.textContent = currentUser.displayName || currentUser.email.split('@')[0];
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
        await signInAnonymously(auth);
        showToast("Logout realizado.");
    } catch (err) {
        console.error(err);
    }
};

document.getElementById('btn-logout').addEventListener('click', handleLogout);
document.getElementById('btn-logout-mobile').addEventListener('click', handleLogout);

// Carousel Setup
const carousel = document.getElementById('carousel');
let currentSlide = 0;
const totalSlides = 2;

function goToSlide(index) {
    currentSlide = (index + totalSlides) % totalSlides;
    carousel.style.transform = `translateX(-${currentSlide * 100}%)`;
}

document.getElementById('next-slide').addEventListener('click', () => goToSlide(currentSlide + 1));
document.getElementById('prev-slide').addEventListener('click', () => goToSlide(currentSlide - 1));

setInterval(() => {
    goToSlide(currentSlide + 1);
}, 5000);

document.getElementById('mobile-menu-btn').addEventListener('click', () => {
    const menu = document.getElementById('mobile-menu');
    menu.classList.toggle('hidden');
});

// Initialization
renderProducts();
updateCartUI();
