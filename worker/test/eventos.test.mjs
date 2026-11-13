// Teste local do Worker (loja + bilheteria) com Firestore e Mercado Pago
// simulados em memoria. Nao toca em producao.
//   node worker/test/eventos.test.mjs
import assert from "node:assert/strict";
import { webcrypto as wc } from "node:crypto";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// O Worker e um modulo ES em arquivo .js; copia para .mjs so para o Node importar
const tmpWorker = join(mkdtempSync(join(tmpdir(), "fz-worker-")), "index.mjs");
copyFileSync(fileURLToPath(new URL("../src/index.js", import.meta.url)), tmpWorker);
const worker = (await import(pathToFileURL(tmpWorker).href)).default;

const PROJECT = "test-project";
const ORIGIN = "https://atletica-furiozos.web.app";
const DOCS = "https://firestore.googleapis.com/v1/projects/" + PROJECT + "/databases/(default)/documents";
const ROOT = "artifacts/furiozos-app/public/data";

// ---------------------------------------------------------------- chaves
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rsa = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const userKeys = await wc.subtle.generateKey(rsa, true, ["sign", "verify"]);
const jwk = Object.assign(await wc.subtle.exportKey("jwk", userKeys.publicKey), { kid: "k1", alg: "RS256", use: "sig" });
const saKeys = await wc.subtle.generateKey(rsa, true, ["sign", "verify"]);
const saPem = "-----BEGIN PRIVATE KEY-----\n" + Buffer.from(await wc.subtle.exportKey("pkcs8", saKeys.privateKey)).toString("base64") + "\n-----END PRIVATE KEY-----";

async function idToken(uid, extra) {
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: "RS256", kid: "k1" }));
    const body = b64u(JSON.stringify(Object.assign({
        aud: PROJECT, iss: "https://securetoken.google.com/" + PROJECT, sub: uid, iat: now - 10, exp: now + 3600,
        email: uid + "@teste.com", email_verified: true, name: "Aluno " + uid,
        firebase: { sign_in_provider: "password" }
    }, extra || {})));
    const sig = await wc.subtle.sign("RSASSA-PKCS1-v1_5", userKeys.privateKey, Buffer.from(head + "." + body));
    return head + "." + body + "." + b64u(sig);
}

// ---------------------------------------------------------------- Firestore falso
const store = new Map(); // path -> { fields, updateTime }
let clock = 0;
const tick = () => "2026-01-01T00:00:00." + String(++clock).padStart(6, "0") + "Z";

function enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "string") return { stringValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}
function dec(v) {
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return v.doubleValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("nullValue" in v) return null;
    if ("timestampValue" in v) return v.timestampValue;
    if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
    return null;
}
const seed = (path, data) => store.set(path, { fields: Object.fromEntries(Object.entries(data).map(([k, x]) => [k, enc(x)])), updateTime: tick() });
const read = (path) => { const d = store.get(path); return d ? Object.fromEntries(Object.entries(d.fields).map(([k, x]) => [k, dec(x)])) : null; };
const docJson = (path) => ({ name: "projects/" + PROJECT + "/databases/(default)/documents/" + path, fields: store.get(path).fields, updateTime: store.get(path).updateTime });
const fail = (status, code) => new Response(JSON.stringify({ error: { status: code } }), { status });

function preconditionOk(path, cur) {
    const d = store.get(path);
    if (!cur) return true;
    if (cur.exists === true) return Boolean(d);
    if (cur.exists === false) return !d;
    if (cur.updateTime) return Boolean(d) && d.updateTime === cur.updateTime;
    return true;
}

function fakeFirestore(url, init) {
    const u = new URL(url);
    let rest = decodeURIComponent(u.pathname.split("/documents")[1] || "");
    const method = (init && init.method) || "GET";
    const body = init && init.body ? JSON.parse(init.body) : null;

    if (rest === ":commit") {
        const nameToPath = (n) => n.split("/documents/")[1];
        for (const w of body.writes) if (!preconditionOk(nameToPath(w.update.name), w.currentDocument)) return fail(400, "FAILED_PRECONDITION");
        for (const w of body.writes) {
            const path = nameToPath(w.update.name);
            const old = store.get(path);
            let fields;
            if (w.updateMask) {
                fields = Object.assign({}, old ? old.fields : {});
                for (const f of w.updateMask.fieldPaths || []) fields[f] = w.update.fields[f];
            } else {
                fields = Object.assign({}, w.update.fields);
            }
            for (const t of w.updateTransforms || []) {
                const cur = fields[t.fieldPath] ? dec(fields[t.fieldPath]) : 0;
                fields[t.fieldPath] = enc(Number(cur) + Number(t.increment.integerValue));
            }
            store.set(path, { fields, updateTime: tick() });
        }
        return new Response("{}", { status: 200 });
    }

    if (rest.endsWith(":runQuery")) {
        const parent = rest.slice(1, -":runQuery".length);
        const q = body.structuredQuery;
        const col = q.from[0].collectionId;
        const f = q.where.fieldFilter;
        const out = [];
        for (const path of store.keys()) {
            if (!path.startsWith(parent + "/" + col + "/")) continue;
            if (path.slice((parent + "/" + col + "/").length).includes("/")) continue;
            if (JSON.stringify(store.get(path).fields[f.field.fieldPath]) === JSON.stringify(f.value)) out.push({ document: docJson(path) });
        }
        return new Response(JSON.stringify(out), { status: 200 });
    }

    const path = rest.slice(1);
    const segments = path.split("/").length;

    if (method === "GET" && segments % 2 === 1) {
        const documents = [];
        for (const p of store.keys()) {
            if (p.startsWith(path + "/") && !p.slice(path.length + 1).includes("/")) documents.push(docJson(p));
        }
        return new Response(JSON.stringify({ documents }), { status: 200 });
    }
    if (method === "GET") {
        return store.has(path) ? new Response(JSON.stringify(docJson(path)), { status: 200 }) : fail(404, "NOT_FOUND");
    }
    if (method === "POST") {
        const p = path + "/" + u.searchParams.get("documentId");
        if (store.has(p)) return fail(409, "ALREADY_EXISTS");
        store.set(p, { fields: body.fields, updateTime: tick() });
        return new Response(JSON.stringify(docJson(p)), { status: 200 });
    }
    if (method === "PATCH") {
        const cur = {};
        if (u.searchParams.get("currentDocument.updateTime")) cur.updateTime = u.searchParams.get("currentDocument.updateTime");
        if (u.searchParams.get("currentDocument.exists")) cur.exists = true;
        if (!preconditionOk(path, cur)) return fail(400, "FAILED_PRECONDITION");
        const old = store.get(path);
        const fields = Object.assign({}, old ? old.fields : {});
        for (const f of u.searchParams.getAll("updateMask.fieldPaths")) fields[f] = body.fields[f];
        store.set(path, { fields, updateTime: tick() });
        return new Response(JSON.stringify(docJson(path)), { status: 200 });
    }
    return fail(400, "UNSUPPORTED");
}

// ---------------------------------------------------------------- Mercado Pago falso
const payments = new Map();
let nextPaymentId = 1000;
function fakeMp(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || "GET";
    if (method === "POST" && u.pathname === "/v1/payments") {
        const b = JSON.parse(init.body);
        const id = ++nextPaymentId;
        const p = {
            id, status: "pending", status_detail: "pending_waiting_transfer", currency_id: "BRL",
            transaction_amount: b.transaction_amount, external_reference: b.external_reference,
            date_of_expiration: b.date_of_expiration, notification_url: b.notification_url,
            point_of_interaction: { transaction_data: { qr_code: "00020126PIX" + id, qr_code_base64: "QUJD" } }
        };
        payments.set(String(id), p);
        return new Response(JSON.stringify(p), { status: 201 });
    }
    const m = u.pathname.match(/^\/v1\/payments\/(\d+)$/);
    if (m && payments.has(m[1])) return new Response(JSON.stringify(payments.get(m[1])), { status: 200 });
    return new Response("{}", { status: 404 });
}

globalThis.fetch = async function (url, init) {
    url = String(url);
    if (url.startsWith("https://firestore.googleapis.com/")) return fakeFirestore(url, init);
    if (url.startsWith("https://api.mercadopago.com")) return fakeMp(url, init);
    if (url.includes("securetoken@system.gserviceaccount.com")) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "Cache-Control": "max-age=3600" } });
    if (url.startsWith("https://identitytoolkit.googleapis.com/")) {
        if (globalThis.__lookupDown) return new Response("{}", { status: 403 });
        const q = JSON.parse(init.body);
        const users = (q.email && q.email[0] === "porteiro@teste.com") || (q.localId && q.localId[0] === "uidPorteiro0000000000000001")
            ? [{ localId: "uidPorteiro0000000000000001", email: "porteiro@teste.com", displayName: "Porteiro Um" }] : [];
        return new Response(JSON.stringify({ users }), { status: 200 });
    }
    if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "fake", expires_in: 3600 }), { status: 200 });
    throw new Error("fetch inesperado: " + url);
};

// ---------------------------------------------------------------- utilitarios
const env = {
    FIREBASE_PROJECT_ID: PROJECT, APP_ID: "furiozos-app", ALLOWED_ORIGINS: ORIGIN,
    MP_ACCESS_TOKEN: "TEST", GCP_SA_CLIENT_EMAIL: "sa@test", GCP_SA_PRIVATE_KEY: saPem,
    TICKET_SECRET_KEY: "chave-de-teste-bem-comprida-0123456789", TRANSFER_CUTOFF_HOURS: "6"
};
let ipSeq = 0;
async function call(method, path, uid, body, envOverride, tokenExtra) {
    const headers = { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "10.0." + Math.floor(ipSeq / 250) + "." + (ipSeq++ % 250) };
    if (uid) headers.Authorization = "Bearer " + (await idToken(uid, tokenExtra));
    const res = await worker.fetch(new Request("https://worker.test" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), envOverride || env);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data };
}
async function webhook(paymentId, status, path) {
    payments.get(String(paymentId)).status = status;
    const res = await worker.fetch(new Request("https://worker.test" + (path || "/api/webhooks/mercadopago") + "?type=payment&data.id=" + paymentId, { method: "POST", body: "{}" }), env);
    return res.status;
}
const CPF = "52998224725";
const customer = { name: "Fulano de Tal", cpf: CPF, matricula: "202012345678", phone: "21999998888" };
const inDays = (d) => new Date(Date.now() + d * 86400000);

async function verifyToken(token, keyB64) {
    const dot = token.lastIndexOf(".");
    const key = await wc.subtle.importKey("raw", Buffer.from(keyB64, "base64url"), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return wc.subtle.verify("HMAC", key, Buffer.from(token.slice(dot + 1), "base64url"), Buffer.from(token.slice(0, dot)));
}

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log("  ok  " + name); }
    catch (e) { console.log("FALHA " + name + "\n" + (e && e.stack ? e.stack : e)); process.exitCode = 1; }
}

// ---------------------------------------------------------------- dados
seed("artifacts/furiozos-app/admins/admin1", { ok: true });
seed("artifacts/furiozos-app/staff/staff1", { name: "Portaria" });
seed("artifacts/furiozos-app/members/socio1", { name: "Socio" });
seed(ROOT + "/products/p1", { id: "p1", name: "Caneca FurioZOs", price: 35, status: "disponivel", immediateStock: 5, hasSize: false, isShirt: false, images: [] });
seed(ROOT + "/events/festa", { title: "Festa do Sapo", status: "published", startsAt: inDays(10), endsAt: inDays(10.3), activeBatchId: "l1" });
seed(ROOT + "/events/festa/batches/l1", { name: "1º Lote", order: 1, price: 40, memberPrice: 30, comboPrice: 70, comboItems: ["p1"], totalQuantity: 3, soldQuantity: 0, reservedQuantity: 0, autoTurn: true });
seed(ROOT + "/events/festa/batches/l2", { name: "2º Lote", order: 2, price: 50, totalQuantity: 100, soldQuantity: 0, reservedQuantity: 0, autoTurn: false });
const batch = (id) => read(ROOT + "/events/festa/batches/" + id);

console.log("Loja (regressão)");
await test("checkout PIX da loja continua funcionando e o webhook antigo confirma", async () => {
    const r = await call("POST", "/checkout", "lojista", { customer, payment: { method: "pix" }, items: [{ id: "p1", quantity: 1, deliveryMode: "imediata" }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.orderId, /^FZ-/);
    assert.equal(r.data.total, 45);
    const order = read(ROOT + "/orders/" + r.data.orderId);
    assert.equal(await webhook(order.mpPaymentId, "approved", "/webhook/mercadopago"), 200);
    assert.equal(read(ROOT + "/orders/" + r.data.orderId).status, "Pago / Confirmado");
    assert.equal(read(ROOT + "/products/p1").immediateStock, 4);
});

console.log("Bilheteria");
let order1, order2;
await test("reserva trava a vaga e gera PIX de 10 min", async () => {
    const r = await call("POST", "/api/events/checkout", "u1", { eventId: "festa", quantity: 2, kind: "avulso", customer });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    order1 = r.data;
    assert.match(order1.orderId, /^EV-/);
    assert.equal(order1.total, 80);
    assert.ok(order1.pix.qrCode);
    assert.ok(Math.abs(order1.expiresAtMs - Date.now() - 600000) < 5000);
    assert.equal(batch("l1").reservedQuantity, 2);
    assert.equal(batch("l1").soldQuantity, 0);
    const o = read(ROOT + "/ticketOrders/" + order1.orderId);
    assert.equal(o.status, "reserved");
    assert.equal(o.customerCpf, "***.982.247-**");
    assert.equal(read(ROOT + "/tickets/" + o.ticketIds[0]).status, "reserved");
});

await test("anti-overbooking: não vende além do lote", async () => {
    const r = await call("POST", "/api/events/checkout", "u2", { eventId: "festa", quantity: 2, customer });
    assert.equal(r.status, 409);
    assert.equal(r.data.statusDetail, "not_enough");
    const ok = await call("POST", "/api/events/checkout", "u2", { eventId: "festa", quantity: 1, customer });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    order2 = ok.data;
    const full = await call("POST", "/api/events/checkout", "u3", { eventId: "festa", quantity: 1, customer });
    assert.equal(full.status, 409);
    assert.equal(full.data.statusDetail, "sold_out");
    assert.equal(batch("l1").reservedQuantity, 3);
});

await test("exige login, e-mail verificado, CPF válido e evento publicado", async () => {
    assert.equal((await call("POST", "/api/events/checkout", null, { eventId: "festa", quantity: 1, customer })).status, 401);
    assert.equal((await call("POST", "/api/events/checkout", "u9", { eventId: "festa", quantity: 1, customer }, null, { email_verified: false })).status, 403);
    assert.equal((await call("POST", "/api/events/checkout", "u9", { eventId: "festa", quantity: 1, customer: { name: "Fulano", cpf: "11111111111" } })).status, 400);
    assert.equal((await call("POST", "/api/events/checkout", "u9", { eventId: "festa", quantity: 9, customer })).status, 400);
    seed(ROOT + "/events/rascunho", { title: "X", status: "draft", startsAt: inDays(5), endsAt: inDays(5), activeBatchId: "l1" });
    assert.equal((await call("POST", "/api/events/checkout", "u9", { eventId: "rascunho", quantity: 1, customer })).status, 400);
});

let portariaKey;
await test("webhook aprovado emite ingressos assinados (HMAC) e converte reserva em venda", async () => {
    const o = read(ROOT + "/ticketOrders/" + order1.orderId);
    assert.equal(await webhook(o.mpPaymentId, "approved"), 200);
    assert.equal(batch("l1").soldQuantity, 2);
    assert.equal(batch("l1").reservedQuantity, 1);
    assert.equal(read(ROOT + "/ticketOrders/" + order1.orderId).status, "paid");

    const k = await call("GET", "/api/events/festa/portaria-key", "staff1");
    assert.equal(k.status, 200);
    portariaKey = k.data.key;
    assert.equal((await call("GET", "/api/events/festa/portaria-key", "u1")).status, 403);

    for (const tid of o.ticketIds) {
        const t = read(ROOT + "/tickets/" + tid);
        assert.equal(t.status, "valid");
        assert.match(t.qrSignature, new RegExp("^v1:" + tid + ":festa:u1:\\d+\\.[A-Za-z0-9_-]{43}$"));
        assert.equal(await verifyToken(t.qrSignature, portariaKey), true);
        assert.equal(await verifyToken(t.qrSignature.replace(":u1:", ":u2:"), portariaKey), false);
        assert.equal(t.kitSignature, "");
    }
});

await test("webhook repetido não duplica a venda", async () => {
    const o = read(ROOT + "/ticketOrders/" + order1.orderId);
    assert.equal(await webhook(o.mpPaymentId, "approved"), 200);
    assert.equal(batch("l1").soldQuantity, 2);
    assert.equal(batch("l1").reservedQuantity, 1);
});

await test("lote esgotado com autoTurn vira para o próximo lote", async () => {
    const o = read(ROOT + "/ticketOrders/" + order2.orderId);
    assert.equal(await webhook(o.mpPaymentId, "approved"), 200);
    assert.equal(batch("l1").soldQuantity, 3);
    assert.equal(batch("l1").reservedQuantity, 0);
    assert.equal(read(ROOT + "/events/festa").activeBatchId, "l2");
    const r = await call("POST", "/api/events/checkout", "u4", { eventId: "festa", quantity: 1, customer });
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 50);
    assert.equal(r.data.order.batchId, "l2");
});

await test("PIX vencido devolve a vaga ao lote (cron) e cancela os ingressos reservados", async () => {
    const r = await call("POST", "/api/events/checkout", "u5", { eventId: "festa", quantity: 3, customer });
    assert.equal(r.status, 200);
    const before = batch("l2").reservedQuantity;
    const path = ROOT + "/ticketOrders/" + r.data.orderId;
    const o = read(path);
    const waits = [];
    await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.equal(batch("l2").reservedQuantity, before, "reserva ainda no prazo não pode ser devolvida");

    store.get(path).fields.expiresAtMs = enc(Date.now() - 5 * 60000);
    payments.get(o.mpPaymentId).status = "cancelled";
    await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.equal(batch("l2").reservedQuantity, before - 3);
    assert.equal(read(path).status, "expired");
    assert.equal(read(ROOT + "/tickets/" + o.ticketIds[0]).status, "cancelled");
});

await test("reserva vencida mas PAGA não é devolvida: o ingresso é emitido", async () => {
    const r = await call("POST", "/api/events/checkout", "u6", { eventId: "festa", quantity: 1, customer });
    const path = ROOT + "/ticketOrders/" + r.data.orderId;
    const o = read(path);
    store.get(path).fields.expiresAtMs = enc(Date.now() - 5 * 60000);
    payments.get(o.mpPaymentId).status = "approved";
    const waits = [];
    await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.equal(read(path).status, "paid");
    assert.equal(read(ROOT + "/tickets/" + o.ticketIds[0]).status, "valid");
});

await test("pagamento que chega depois da vaga devolvida ainda emite e avisa a diretoria", async () => {
    const r = await call("POST", "/api/events/checkout", "u7", { eventId: "festa", quantity: 1, customer });
    const path = ROOT + "/ticketOrders/" + r.data.orderId;
    const o = read(path);
    store.get(path).fields.expiresAtMs = enc(Date.now() - 5 * 60000);
    const st = await call("GET", "/api/events/orders/" + r.data.orderId, "u7");
    assert.equal(st.data.status, "expired");
    const sold = batch("l2").soldQuantity, reserved = batch("l2").reservedQuantity;
    assert.equal(await webhook(o.mpPaymentId, "approved"), 200);
    assert.equal(read(path).status, "paid");
    assert.match(read(path).adminNote, /prazo/);
    assert.equal(batch("l2").soldQuantity, sold + 1);
    assert.equal(batch("l2").reservedQuantity, reserved);
    assert.equal((await call("GET", "/api/events/orders/" + r.data.orderId, "outro")).status, 404);
});

await test("combo: preço do combo, QR de kit separado e baixa no estoque da loja", async () => {
    seed(ROOT + "/events/festa/batches/l3", { name: "Combo", order: 3, price: 40, memberPrice: 30, comboPrice: 70, comboItems: ["p1"], totalQuantity: 50, soldQuantity: 0, reservedQuantity: 0, autoTurn: false });
    store.get(ROOT + "/events/festa").fields.activeBatchId = enc("l3");
    const stock = read(ROOT + "/products/p1").immediateStock;
    const r = await call("POST", "/api/events/checkout", "u8", { eventId: "festa", quantity: 2, kind: "combo", customer });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.total, 140);
    const o = read(ROOT + "/ticketOrders/" + r.data.orderId);
    assert.equal(await webhook(o.mpPaymentId, "approved"), 200);
    assert.equal(read(ROOT + "/products/p1").immediateStock, stock - 2);
    const t = read(ROOT + "/tickets/" + o.ticketIds[0]);
    assert.equal(t.isCombo, true);
    assert.deepEqual(t.comboItems, ["Caneca FurioZOs"]);
    assert.match(t.kitSignature, /^k1:/);
    assert.equal(await verifyToken(t.kitSignature, portariaKey), true);
    assert.notEqual(t.kitSignature.split(".")[1], t.qrSignature.split(".")[1]);
});

await test("sócio paga o preço de sócio", async () => {
    const r = await call("POST", "/api/events/checkout", "socio1", { eventId: "festa", quantity: 1, customer });
    assert.equal(r.data.total, 30);
    assert.equal(r.data.order.memberPrice, true);
    const c = await call("POST", "/api/events/checkout", "socio1", { eventId: "festa", quantity: 1, kind: "combo", customer });
    assert.equal(c.data.total, 60);
});

await test("valor divergente vai para análise e não emite ingresso", async () => {
    const r = await call("POST", "/api/events/checkout", "u10", { eventId: "festa", quantity: 1, customer });
    const o = read(ROOT + "/ticketOrders/" + r.data.orderId);
    payments.get(o.mpPaymentId).transaction_amount = 1;
    const reserved = batch("l3").reservedQuantity;
    assert.equal(await webhook(o.mpPaymentId, "approved"), 200);
    assert.equal(read(ROOT + "/ticketOrders/" + r.data.orderId).status, "review");
    assert.equal(read(ROOT + "/tickets/" + o.ticketIds[0]).status, "reserved");
    assert.equal(batch("l3").reservedQuantity, reserved - 1);
});

await test("estorno cancela os ingressos e devolve a contagem", async () => {
    const r = await call("POST", "/api/events/checkout", "u11", { eventId: "festa", quantity: 1, customer });
    const o = read(ROOT + "/ticketOrders/" + r.data.orderId);
    await webhook(o.mpPaymentId, "approved");
    const sold = batch("l3").soldQuantity;
    await webhook(o.mpPaymentId, "refunded");
    assert.equal(read(ROOT + "/ticketOrders/" + r.data.orderId).status, "refunded");
    assert.equal(read(ROOT + "/tickets/" + o.ticketIds[0]).status, "cancelled");
    assert.equal(read(ROOT + "/tickets/" + o.ticketIds[0]).qrSignature, "");
    assert.equal(batch("l3").soldQuantity, sold - 1);
});

await test("concorrência: 12 compras simultâneas em lote de 5 nunca passam do limite", async () => {
    seed(ROOT + "/events/corrida", { title: "Corrida", status: "published", startsAt: inDays(3), endsAt: inDays(3.2), activeBatchId: "x" });
    seed(ROOT + "/events/corrida/batches/x", { name: "Único", order: 1, price: 10, totalQuantity: 5, soldQuantity: 0, reservedQuantity: 0, autoTurn: false });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        call("POST", "/api/events/checkout", "c" + i, { eventId: "corrida", quantity: 1, customer })));
    const okCount = results.filter((r) => r.status === 200).length;
    const b = read(ROOT + "/events/corrida/batches/x");
    assert.equal(b.reservedQuantity, okCount);
    assert.ok(okCount <= 5, "vendeu " + okCount);
    assert.ok(okCount >= 4, "só " + okCount + " de 5 conseguiram");
    assert.ok(results.every((r) => r.status === 200 || r.status === 409));
});

await test("uma conta não segura mais de 2 compras aguardando PIX", async () => {
    seed(ROOT + "/events/limite", { title: "Limite", status: "published", startsAt: inDays(4), endsAt: inDays(4.2), activeBatchId: "x" });
    seed(ROOT + "/events/limite/batches/x", { name: "Único", order: 1, price: 10, totalQuantity: 50, soldQuantity: 0, reservedQuantity: 0, autoTurn: false });
    const buy = () => call("POST", "/api/events/checkout", "acumulador", { eventId: "limite", quantity: 1, customer });
    const first = await buy();
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal((await buy()).status, 200);
    const third = await buy();
    assert.equal(third.status, 409);
    assert.equal(third.data.statusDetail, "too_many_open");
    assert.equal(read(ROOT + "/events/limite/batches/x").reservedQuantity, 2);
    // Pagou uma: abre espaço para outra compra
    assert.equal(await webhook(read(ROOT + "/ticketOrders/" + first.data.orderId).mpPaymentId, "approved"), 200);
    assert.equal((await buy()).status, 200);
});

await test("última peça paga por duas pessoas: estoque para em zero e a diretoria é avisada", async () => {
    seed(ROOT + "/products/p2", { id: "p2", name: "Tirante", price: 20, status: "disponivel", immediateStock: 1, hasSize: false, isShirt: false, images: [] });
    const items = [{ id: "p2", quantity: 1, deliveryMode: "imediata" }];
    const a = await call("POST", "/checkout", "loja-a", { customer, payment: { method: "pix" }, items });
    const b = await call("POST", "/checkout", "loja-b", { customer, payment: { method: "pix" }, items });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal(b.status, 200, JSON.stringify(b.data));
    await webhook(read(ROOT + "/orders/" + a.data.orderId).mpPaymentId, "approved", "/webhook/mercadopago");
    await webhook(read(ROOT + "/orders/" + b.data.orderId).mpPaymentId, "approved", "/webhook/mercadopago");
    assert.equal(read(ROOT + "/products/p2").immediateStock, 0);
    assert.equal(read(ROOT + "/orders/" + a.data.orderId).adminNote, undefined);
    assert.match(read(ROOT + "/orders/" + b.data.orderId).adminNote, /Estoque insuficiente.*Tirante/);

    // Combo com produto sem estoque: o ingresso sai, com aviso no pedido
    seed(ROOT + "/events/limite/batches/c", { name: "Combo", order: 2, price: 10, comboPrice: 25, comboItems: ["p2"], totalQuantity: 50, soldQuantity: 0, reservedQuantity: 0, autoTurn: false });
    store.get(ROOT + "/events/limite").fields.activeBatchId = enc("c");
    const c = await call("POST", "/api/events/checkout", "combo-sem-estoque", { eventId: "limite", quantity: 1, kind: "combo", customer });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    await webhook(read(ROOT + "/ticketOrders/" + c.data.orderId).mpPaymentId, "approved");
    const co = read(ROOT + "/ticketOrders/" + c.data.orderId);
    assert.equal(co.status, "paid");
    assert.match(co.adminNote, /Estoque insuficiente.*Tirante/);
});

console.log("Transferência");
let ticketId, oldToken;
await test("titular gera código; quem recebe assume com nova assinatura", async () => {
    ticketId = read(ROOT + "/ticketOrders/" + order1.orderId).ticketIds[0];
    oldToken = read(ROOT + "/tickets/" + ticketId).qrSignature;
    assert.equal((await call("POST", "/api/tickets/transfer", "u2", { action: "offer", ticketId })).status, 404);
    const offer = await call("POST", "/api/tickets/transfer", "u1", { action: "offer", ticketId });
    assert.equal(offer.status, 200, JSON.stringify(offer.data));
    assert.equal((await call("POST", "/api/tickets/transfer", "u1", { action: "accept", code: offer.data.code, customer })).status, 400);
    assert.equal((await call("POST", "/api/tickets/transfer", "amigo", { action: "accept", code: ticketId + ".AAAAAAAAAAAAAAAAAAAAAAAA", customer })).status, 400);

    const acc = await call("POST", "/api/tickets/transfer", "amigo", { action: "accept", code: offer.data.code, customer: { name: "Amigo Novo", cpf: "11144477735" } });
    assert.equal(acc.status, 200, JSON.stringify(acc.data));
    const t = read(ROOT + "/tickets/" + ticketId);
    assert.equal(t.ownerUid, "amigo");
    assert.equal(t.ownerName, "Amigo Novo");
    assert.equal(t.ownerCpf, "***.444.777-**");
    assert.notEqual(t.qrSignature, oldToken);
    assert.match(t.qrSignature, /:amigo:/);
    assert.equal(await verifyToken(t.qrSignature, portariaKey), true);
    assert.equal(t.transferHistory.length, 1);
    assert.equal(t.transferHistory[0].fromUid, "u1");
    assert.equal(t.transferCodeHash, "");
    assert.equal((await call("POST", "/api/tickets/transfer", "outro", { action: "accept", code: offer.data.code, customer })).status, 400);
});

await test("transferência bloqueada perto do evento e para ingresso usado", async () => {
    const other = read(ROOT + "/ticketOrders/" + order1.orderId).ticketIds[1];
    store.get(ROOT + "/tickets/" + other).fields.status = enc("used");
    assert.equal((await call("POST", "/api/tickets/transfer", "u1", { action: "offer", ticketId: other })).status, 400);
    store.get(ROOT + "/tickets/" + other).fields.status = enc("valid");
    store.get(ROOT + "/events/festa").fields.startsAt = enc(new Date(Date.now() + 2 * 3600000));
    assert.equal((await call("POST", "/api/tickets/transfer", "u1", { action: "offer", ticketId: other })).status, 400);
    store.get(ROOT + "/events/festa").fields.startsAt = enc(inDays(10));
    const offer = await call("POST", "/api/tickets/transfer", "u1", { action: "offer", ticketId: other });
    assert.equal(offer.status, 200);
    assert.equal((await call("POST", "/api/tickets/transfer", "u1", { action: "cancel", ticketId: other })).status, 200);
    assert.equal((await call("POST", "/api/tickets/transfer", "amigo", { action: "accept", code: offer.data.code, customer })).status, 400);
});

console.log("Diretoria e segurança");
await test("cortesia só pela diretoria, já com código para o convidado", async () => {
    assert.equal((await call("POST", "/api/events/courtesy", "u1", { eventId: "festa", quantity: 1 })).status, 403);
    const r = await call("POST", "/api/events/courtesy", "admin1", { eventId: "festa", quantity: 2, guestName: "DJ Convidado" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.tickets.length, 2);
    const t = read(ROOT + "/tickets/" + r.data.tickets[0].ticketId);
    assert.equal(t.courtesy, true);
    assert.equal(t.status, "valid");
    assert.equal(await verifyToken(t.qrSignature, portariaKey), true);
    const acc = await call("POST", "/api/tickets/transfer", "dj", { action: "accept", code: r.data.tickets[0].code, customer });
    assert.equal(acc.status, 200, JSON.stringify(acc.data));
});

await test("diretoria cadastra equipe e sócio por e-mail; sem consulta, só pelo código", async () => {
    assert.equal((await call("POST", "/api/admin/roles", "u1", { role: "staff", identifier: "porteiro@teste.com" })).status, 403);
    const r = await call("POST", "/api/admin/roles", "admin1", { role: "staff", identifier: "Porteiro@teste.com" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.uid, "uidPorteiro0000000000000001");
    assert.equal(read("artifacts/furiozos-app/staff/uidPorteiro0000000000000001").email, "porteiro@teste.com");
    assert.equal((await call("GET", "/api/events/festa/portaria-key", "uidPorteiro0000000000000001")).status, 200);
    assert.equal((await call("POST", "/api/admin/roles", "admin1", { role: "member", identifier: "ninguem@teste.com" })).status, 404);
    assert.equal((await call("POST", "/api/admin/roles", "admin1", { role: "xx", identifier: "porteiro@teste.com" })).status, 400);
    globalThis.__lookupDown = true;
    assert.equal((await call("POST", "/api/admin/roles", "admin1", { role: "member", identifier: "porteiro@teste.com" })).status, 501);
    const byUid = await call("POST", "/api/admin/roles", "admin1", { role: "member", identifier: "uidSocio00000000000000000002", name: "Sócia Dois", matricula: "202012345678" });
    assert.equal(byUid.status, 200, JSON.stringify(byUid.data));
    assert.equal(read("artifacts/furiozos-app/members/uidSocio00000000000000000002").matricula, "202012345678");
    globalThis.__lookupDown = false;
});

await test("sem TICKET_SECRET_KEY a bilheteria recusa, e a loja segue funcionando", async () => {
    const noKey = Object.assign({}, env, { TICKET_SECRET_KEY: "" });
    assert.equal((await call("POST", "/api/events/checkout", "u12", { eventId: "festa", quantity: 1, customer }, noKey)).status, 503);
    const r = await call("POST", "/checkout", "lojista2", { customer, payment: { method: "pix" }, items: [{ id: "p1", quantity: 1 }] }, noKey);
    assert.equal(r.status, 200, JSON.stringify(r.data));
});

await test("webhook com segredo configurado rejeita chamada sem assinatura", async () => {
    const res = await worker.fetch(new Request("https://worker.test/api/webhooks/mercadopago?type=payment&data.id=1001", { method: "POST", body: "{}" }),
        Object.assign({}, env, { MP_WEBHOOK_SECRET: "segredo" }));
    assert.equal(res.status, 401);
});

await test("origem não permitida é barrada", async () => {
    const res = await worker.fetch(new Request("https://worker.test/api/events/checkout", { method: "POST", headers: { Origin: "https://site-falso.com" }, body: "{}" }), env);
    assert.equal(res.status, 403);
});

console.log("\n" + passed + " testes passaram" + (process.exitCode ? " (com falhas acima)" : ""));
