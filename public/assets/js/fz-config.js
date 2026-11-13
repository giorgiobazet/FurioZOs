// Configuracao compartilhada pelas paginas internas (painel da diretoria e portaria).
// A configuracao web do Firebase e publica por natureza: a protecao real esta
// nas regras do Firestore e no Worker.
export const APP_ID = "furiozos-app";
export const WORKER_URL = "https://furiozos-pagamento.bblackgamerbr.workers.dev";
export const SITE_URL = "https://atletica-furiozos.web.app";

export const firebaseConfig = {
    apiKey: "AIzaSyDq8DjGLsN_yLlTP2brfyhfLgU23ROP38M",
    authDomain: "atletica-furiozos.firebaseapp.com",
    projectId: "atletica-furiozos",
    storageBucket: "atletica-furiozos.firebasestorage.app",
    messagingSenderId: "968429095494",
    appId: "1:968429095494:web:16c2514234a7a2ac4bd847",
    measurementId: "G-P39HJJCQLN"
};

export function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"'`]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;", "`": "&#96;" }[c];
    });
}

export function money(value) {
    return "R\x24 " + Number(value || 0).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === "function") return v.toDate();
    if (typeof v.seconds === "number") return new Date(v.seconds * 1000);
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

export function pad2(n) {
    return String(n).padStart(2, "0");
}

export function shortDateTime(d) {
    if (!d) return "—";
    return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear() + " " + pad2(d.getHours()) + "h" + pad2(d.getMinutes());
}

// Chamada autenticada ao Worker (mesmo contrato do site principal)
export async function callWorker(user, path, method, bodyObj) {
    if (!user) return { ok: false, status: 401, data: { message: "Faça login para continuar." } };
    const idToken = await user.getIdToken();
    const res = await fetch(WORKER_URL + path, {
        method: method,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
        body: bodyObj ? JSON.stringify(bodyObj) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    return { ok: res.ok, status: res.status, data: data };
}
