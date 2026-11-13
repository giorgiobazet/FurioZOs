/**
 * ============================================================================
 * WORKER DE PAGAMENTO - ATLETICA FURIOZOS (Cloudflare Workers)
 * ============================================================================
 * Substitui o antigo proxy aberto do Mercado Pago. Agora o servidor:
 *   - exige login (ID token do Firebase, nao anonimo);
 *   - recalcula TODOS os precos a partir do catalogo no Firestore;
 *   - cria o pedido como "Aguardando pagamento" e so confirma apos o
 *     Mercado Pago aprovar (consulta direta na API, com valor conferido);
 *   - baixa o estoque de pronta entrega uma unica vez (idempotente);
 *   - recebe o webhook do Mercado Pago.
 *
 * Rotas:
 *   POST /checkout                -> cria pedido + pagamento (PIX ou cartao)
 *   GET  /orders/:orderId         -> status do pedido do proprio usuario
 *   POST /webhook/mercadopago     -> notificacoes do Mercado Pago
 *
 * Bilheteria de eventos (PRD_EVENTOS.md):
 *   POST /api/events/checkout          -> reserva vaga no lote + PIX de 10 min
 *   GET  /api/events/orders/:orderId   -> status do pedido de ingresso
 *   POST /api/webhooks/mercadopago     -> mesmo webhook (aceita os dois caminhos)
 *   POST /api/tickets/transfer         -> transferencia (offer | accept | cancel)
 *   GET  /api/events/:eventId/portaria-key -> chave do evento para a portaria offline
 *   POST /api/events/courtesy          -> cortesias/VIP (so diretoria)
 *   POST /api/admin/roles              -> cadastra equipe da portaria / socio (so diretoria)
 *   cron (a cada 2 min)                -> devolve ao lote as reservas vencidas
 *
 * Variaveis (wrangler.toml ou painel): FIREBASE_PROJECT_ID, APP_ID, ALLOWED_ORIGINS,
 *          TRANSFER_CUTOFF_HOURS
 * Secrets: MP_ACCESS_TOKEN, GCP_SA_CLIENT_EMAIL, GCP_SA_PRIVATE_KEY,
 *          MP_WEBHOOK_SECRET (opcional, recomendado),
 *          TICKET_SECRET_KEY (assinatura HMAC dos ingressos)
 * Sem dependencias externas: pode ser colado direto no editor do painel.
 * ============================================================================
 */

const MP_API = "https://api.mercadopago.com";
const FIREBASE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Mesmas regras de preco do site (aqui elas sao a fonte da verdade)
const PRICING_RULES = {
    CUSTOM_NAME_FEE: 5.0,
    CUSTOM_NUMBER_FEE: 5.0,
    IMMEDIATE_DELIVERY_FEE: 10.0
};

const INSTALLMENT_RATES = {
    1: 0.0498, 2: 0.0750, 3: 0.0920, 4: 0.1080, 5: 0.1230, 6: 0.1380,
    7: 0.1550, 8: 0.1700, 9: 0.1850, 10: 0.2000, 11: 0.2150, 12: 0.2300
};

const SIZES = ["PP", "P", "M", "G", "GG", "XG", "XXG"];
const MAX_QTY_PER_ITEM = 10;
const MAX_CART_ITEMS = 20;
const PIX_EXPIRATION_MINUTES = 30;
const CUSTOM_NAME_REGEX = /^[A-Z0-9ÀÁÂÃÄÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ .'-]*$/;

const STATUS = {
    PENDING: "Aguardando pagamento",
    REVIEW: "Em análise",
    PAID: "Pago / Confirmado",
    REJECTED: "Pagamento recusado",
    CANCELLED: "Cancelado",
    REFUNDED: "Estornado"
};
const FINAL_STATUSES = [STATUS.PAID, STATUS.REJECTED, STATUS.CANCELLED, STATUS.REFUNDED];

class HttpError extends Error {
    constructor(status, message, detail) {
        super(message);
        this.status = status;
        this.detail = detail || "";
    }
}

// ============================================================================
// ENTRADA
// ============================================================================
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const cors = corsHeaders(request, env);

        // Limite por IP. Alunos na mesma rede (Wi-Fi da UERJ) dividem o IP e a
        // tela do PIX consulta o status a cada 10 s, por isso o teto e generoso.
        // Camada 1: binding da Cloudflare (compartilhado na localidade).
        // Camada 2: memoria da instancia (vale mesmo sem o binding).
        const isWebhookPath = url.pathname === "/webhook/mercadopago" || url.pathname === "/api/webhooks/mercadopago";
        if (request.method !== "OPTIONS" && !isWebhookPath) {
            const ip = request.headers.get("CF-Connecting-IP") || "unknown";
            const blocked = !(await bindingAllows(env.IP_LIMITER, "ip:" + ip))
                || isRateLimited("ip:" + ip, 600, 60 * 1000);
            if (blocked) {
                return json({ message: "Muitas requisições. Aguarde um minuto." }, 429, cors || {});
            }
        }

        if (request.method === "OPTIONS") {
            return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
        }

        try {
            if (isWebhookPath && request.method === "POST") {
                return await handleWebhook(request, env, url);
            }

            if (!cors) {
                return json({ message: "Origem não permitida." }, 403);
            }

            if (url.pathname === "/checkout" && request.method === "POST") {
                return json(await handleCheckout(request, env, url), 200, cors);
            }

            const orderMatch = url.pathname.match(/^\/orders\/(FZ-[A-Z0-9]{6,20})$/);
            if (orderMatch && request.method === "GET") {
                return json(await handleOrderStatus(request, env, orderMatch[1]), 200, cors);
            }

            // ---- Bilheteria de eventos ----
            if (url.pathname === "/api/events/checkout" && request.method === "POST") {
                return json(await handleEventCheckout(request, env, url), 200, cors);
            }
            const ticketOrderMatch = url.pathname.match(/^\/api\/events\/orders\/(EV-[A-Z0-9]{6,20})$/);
            if (ticketOrderMatch && request.method === "GET") {
                return json(await handleTicketOrderStatus(request, env, ticketOrderMatch[1]), 200, cors);
            }
            if (url.pathname === "/api/tickets/transfer" && request.method === "POST") {
                return json(await handleTicketTransfer(request, env), 200, cors);
            }
            if (url.pathname === "/api/events/courtesy" && request.method === "POST") {
                return json(await handleCourtesy(request, env), 200, cors);
            }
            if (url.pathname === "/api/admin/roles" && request.method === "POST") {
                return json(await handleAdminRole(request, env), 200, cors);
            }
            const keyMatch = url.pathname.match(/^\/api\/events\/([a-z0-9][a-z0-9-]{1,60})\/portaria-key$/);
            if (keyMatch && request.method === "GET") {
                return json(await handlePortariaKey(request, env, keyMatch[1]), 200, cors);
            }

            return json({ message: "Rota não encontrada." }, 404, cors);
        } catch (err) {
            const isKnown = err instanceof HttpError;
            if (!isKnown) console.error(err && err.stack ? err.stack : err);
            return json(
                {
                    message: isKnown ? err.message : "Erro interno no servidor de pagamento.",
                    statusDetail: isKnown ? err.detail : ""
                },
                isKnown ? err.status : 500,
                cors || {}
            );
        }
    },

    // Cron: devolve ao lote as vagas de PIX que venceram sem pagamento
    async scheduled(event, env, ctx) {
        ctx.waitUntil(
            sweepExpiredReservations(env, null).catch(function (e) {
                console.error("sweep:", e && e.stack ? e.stack : e);
            })
        );
    }
};

// ============================================================================
// CHECKOUT
// ============================================================================
async function handleCheckout(request, env, url) {
    const user = await requireUser(request, env);
    // Checkout por conta: ate 3 por minuto (binding) e 5 a cada 10 minutos (memoria)
    const checkoutBlocked = !(await bindingAllows(env.CHECKOUT_LIMITER, "checkout:" + user.sub))
        || isRateLimited("checkout:" + user.sub, 5, 10 * 60 * 1000);
    if (checkoutBlocked) {
        throw new HttpError(429, "Muitas tentativas de pagamento. Aguarde alguns minutos.");
    }
    if (user.email_verified !== true) {
        throw new HttpError(403, "Confirme seu e-mail antes de pagar. Abra o link que enviamos e tente de novo.");
    }
    const body = await readJson(request);

    if (!user.email) throw new HttpError(400, "Sua conta precisa ter um e-mail para pagar.");

    const customer = validateCustomer(body.customer);
    const payment = validatePayment(body.payment);
    const catalog = await loadCatalog(env);
    const items = priceItems(body.items, catalog);

    let subtotal = 0;
    for (const it of items) subtotal += it.price * it.quantity;
    subtotal = round2(subtotal);

    let total = subtotal;
    let installmentFee = 0;
    let installments = 1;
    if (payment.method === "card") {
        installments = payment.installments;
        total = round2(subtotal / (1 - INSTALLMENT_RATES[installments]));
        installmentFee = round2(Math.max(0, total - subtotal));
    }

    const orderId = newOrderId();
    const nowIso = new Date().toISOString();
    const customerName = sanitizeText(body.customer && body.customer.name ? body.customer.name : (user.name || "Aluno FurioZOs"), 80) || "Aluno FurioZOs";

    const order = {
        orderId: orderId,
        userId: user.sub,
        customerName: customerName,
        customerEmail: user.email,
        customerPhone: customer.phone,
        customerCpf: maskCpfPartial(customer.cpf),
        customerMatricula: customer.matricula,
        items: items,
        subtotal: subtotal,
        installmentFee: installmentFee,
        installments: installments,
        total: total,
        paymentMethod: payment.method === "pix" ? "PIX (Mercado Pago)" : "Cartão de Crédito (" + installments + "x)",
        status: STATUS.PENDING,
        mpPaymentId: "",
        mpStatus: "",
        mpStatusDetail: "",
        stockApplied: false,
        createdAtISO: nowIso,
        updatedAtISO: nowIso,
        createdAt: new Date(nowIso)
    };

    const orderPath = orderDocPath(env, orderId);
    await fsCreate(env, ordersCollectionPath(env), orderId, order);

    const names = splitName(customerName);
    const mpBody = {
        transaction_amount: total,
        description: "Pedido " + orderId + " - Atletica FurioZOs",
        external_reference: orderId,
        notification_url: url.origin + "/webhook/mercadopago",
        metadata: { order_id: orderId, user_id: user.sub },
        payer: {
            email: user.email,
            first_name: names.first,
            last_name: names.last,
            identification: { type: "CPF", number: customer.cpf }
        }
    };

    if (payment.method === "pix") {
        mpBody.payment_method_id = "pix";
        mpBody.date_of_expiration = mpDate(Date.now() + PIX_EXPIRATION_MINUTES * 60 * 1000);
    } else {
        mpBody.token = payment.token;
        mpBody.installments = installments;
        mpBody.payment_method_id = payment.paymentMethodId;
        if (payment.issuerId) mpBody.issuer_id = Number(payment.issuerId);
    }

    let mpRes;
    try {
        mpRes = await mpFetch(env, "/v1/payments", {
            method: "POST",
            headers: { "X-Idempotency-Key": orderId },
            body: JSON.stringify(mpBody)
        });
    } catch (e) {
        await safeCancel(env, orderPath, "erro_comunicacao");
        throw new HttpError(502, "Não foi possível comunicar com o Mercado Pago. Tente novamente.");
    }

    if (!mpRes.ok || !mpRes.data || !mpRes.data.id) {
        const d = mpRes.data || {};
        await safeCancel(env, orderPath, String(d.status_detail || d.error || "erro_mp"));
        throw new HttpError(400, String(d.message || "Pagamento não aceito pelo Mercado Pago."), String(d.status_detail || ""));
    }

    const p = mpRes.data;
    await fsPatch(env, orderPath, {
        mpPaymentId: String(p.id),
        mpStatus: String(p.status || ""),
        mpStatusDetail: String(p.status_detail || "")
    });

    const result = await reconcilePayment(env, p);
    const finalOrder = result ? result.order : Object.assign({}, order, { mpPaymentId: String(p.id) });

    const response = {
        orderId: orderId,
        status: finalOrder.status,
        statusDetail: String(p.status_detail || ""),
        total: total,
        order: publicOrder(finalOrder)
    };

    if (payment.method === "pix") {
        const tx = p.point_of_interaction && p.point_of_interaction.transaction_data;
        if (!tx || !tx.qr_code) {
            await safeCancel(env, orderPath, "pix_sem_qrcode");
            throw new HttpError(502, "O Mercado Pago não retornou o QR Code do PIX. Tente novamente.");
        }
        response.pix = {
            qrCode: String(tx.qr_code),
            qrCodeBase64: String(tx.qr_code_base64 || ""),
            expiresAt: String(p.date_of_expiration || "")
        };
    }

    return response;
}

// ============================================================================
// STATUS DO PEDIDO (consulta do proprio usuario + reconciliacao)
// ============================================================================
async function handleOrderStatus(request, env, orderId) {
    const user = await requireUser(request, env);
    const docSnap = await fsGet(env, orderDocPath(env, orderId));
    if (!docSnap || docSnap.data.userId !== user.sub) {
        throw new HttpError(404, "Pedido não encontrado.");
    }

    let order = docSnap.data;
    if (order.mpPaymentId && FINAL_STATUSES.indexOf(order.status) === -1) {
        const mp = await mpFetch(env, "/v1/payments/" + encodeURIComponent(order.mpPaymentId), { method: "GET" });
        if (mp.ok && mp.data) {
            const r = await reconcilePayment(env, mp.data);
            if (r) order = r.order;
        }
    }

    return { orderId: orderId, status: order.status, order: publicOrder(order) };
}

// ============================================================================
// WEBHOOK DO MERCADO PAGO
// ============================================================================
async function handleWebhook(request, env, url) {
    let body = {};
    try {
        body = await request.json();
    } catch (e) {
        body = {};
    }

    const type = url.searchParams.get("type") || url.searchParams.get("topic") || body.type || body.topic || "";
    const dataId = String(url.searchParams.get("data.id") || url.searchParams.get("id") || (body.data && body.data.id) || "");

    if (type !== "payment" || !/^\d{1,20}$/.test(dataId)) {
        return new Response("ignored", { status: 200 });
    }

    // Assinatura: valida quando o segredo esta configurado e o cabecalho veio.
    // Mesmo sem assinatura o processamento e seguro, pois o status e o valor
    // sao sempre consultados direto na API do Mercado Pago com o seu token.
    // Com o segredo configurado a assinatura passa a ser obrigatoria.
    if (env.MP_WEBHOOK_SECRET) {
        const valid = request.headers.get("x-signature")
            ? await verifyMpSignature(request, env.MP_WEBHOOK_SECRET, dataId)
            : false;
        if (!valid) return new Response("invalid signature", { status: 401 });
    }

    const mp = await mpFetch(env, "/v1/payments/" + dataId, { method: "GET" });
    if (!mp.ok || !mp.data) {
        return new Response("payment unavailable", { status: mp.status === 404 ? 200 : 502 });
    }

    // Pedidos da loja comecam com FZ-; pedidos de ingresso, com EV-
    if (/^EV-/.test(String(mp.data.external_reference || ""))) {
        await reconcileTicketPayment(env, mp.data);
    } else {
        await reconcilePayment(env, mp.data);
    }
    return new Response("ok", { status: 200 });
}

async function verifyMpSignature(request, secret, dataId) {
    const sigHeader = request.headers.get("x-signature") || "";
    const requestId = request.headers.get("x-request-id") || "";
    const parts = {};
    sigHeader.split(",").forEach(function (piece) {
        const idx = piece.indexOf("=");
        if (idx > 0) parts[piece.slice(0, idx).trim()] = piece.slice(idx + 1).trim();
    });
    if (!parts.ts || !parts.v1) return false;

    let manifest = "id:" + dataId.toLowerCase() + ";";
    if (requestId) manifest += "request-id:" + requestId + ";";
    manifest += "ts:" + parts.ts + ";";

    const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(manifest)));
    const hex = Array.from(mac).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    return timingSafeEqual(hex, parts.v1.toLowerCase());
}

// ============================================================================
// RECONCILIACAO (idempotente e protegida contra concorrencia)
// ============================================================================
function mapMpStatus(mpStatus) {
    switch (mpStatus) {
        case "approved": return STATUS.PAID;
        case "pending": return STATUS.PENDING;
        case "authorized":
        case "in_process":
        case "in_mediation": return STATUS.REVIEW;
        case "rejected": return STATUS.REJECTED;
        case "cancelled": return STATUS.CANCELLED;
        case "refunded":
        case "charged_back": return STATUS.REFUNDED;
        default: return STATUS.PENDING;
    }
}

function canTransition(current, next) {
    if (current === next) return false;
    if (current === STATUS.REFUNDED) return false;
    if (current === STATUS.PAID) return next === STATUS.REFUNDED;
    if (current === STATUS.CANCELLED || current === STATUS.REJECTED) return next === STATUS.PAID;
    return true;
}

async function reconcilePayment(env, payment) {
    const orderId = String(payment && payment.external_reference ? payment.external_reference : "");
    if (!/^FZ-[A-Z0-9]{6,20}$/.test(orderId)) return null;

    const path = orderDocPath(env, orderId);

    for (let attempt = 0; attempt < 4; attempt++) {
        const snap = await fsGet(env, path);
        if (!snap) return null;
        const order = snap.data;

        // O pedido so aceita o pagamento que foi criado para ele
        if (order.mpPaymentId && order.mpPaymentId !== String(payment.id)) {
            return { order: order, status: order.status };
        }

        const amountOk = Math.abs(Number(payment.transaction_amount) - Number(order.total)) < 0.01 &&
            String(payment.currency_id || "BRL") === "BRL";

        let next = mapMpStatus(String(payment.status || ""));
        if (next === STATUS.PAID && !amountOk) next = STATUS.REVIEW;

        if (!canTransition(order.status, next)) {
            return { order: order, status: order.status };
        }

        const nowIso = new Date().toISOString();
        const patch = {
            status: next,
            mpPaymentId: String(payment.id),
            mpStatus: String(payment.status || ""),
            mpStatusDetail: String(payment.status_detail || ""),
            updatedAtISO: nowIso
        };
        const mustApplyStock = next === STATUS.PAID && !order.stockApplied;
        if (next === STATUS.PAID) {
            patch.paidAtISO = String(payment.date_approved || nowIso);
            patch.stockApplied = true;
        }
        if (!amountOk) {
            patch.adminNote = "Valor recebido diverge do total do pedido. Conferir no Mercado Pago.";
        }

        // Precondicao updateTime: se outro processo atualizou antes, relemos
        const saved = await fsPatch(env, path, patch, snap.updateTime);
        if (!saved) continue;

        if (mustApplyStock) await applyImmediateStock(env, order.items || []);
        return { order: Object.assign({}, order, patch), status: next };
    }

    throw new Error("Conflito repetido ao atualizar o pedido " + orderId);
}

async function applyImmediateStock(env, items) {
    const perProduct = {};
    for (const it of items) {
        if (it.deliveryMode === "imediata") {
            perProduct[it.id] = (perProduct[it.id] || 0) + Number(it.quantity || 0);
        }
    }

    for (const productId of Object.keys(perProduct)) {
        const path = productsCollectionPath(env) + "/" + encodeURIComponent(productId);
        for (let attempt = 0; attempt < 4; attempt++) {
            const snap = await fsGet(env, path);
            if (!snap) break;
            const current = Number(snap.data.immediateStock || 0);
            const next = Math.max(0, current - perProduct[productId]);
            const ok = await fsPatch(env, path, { immediateStock: next }, snap.updateTime);
            if (ok) break;
        }
    }
}

async function safeCancel(env, orderPath, reason) {
    try {
        await fsPatch(env, orderPath, {
            status: STATUS.CANCELLED,
            mpStatusDetail: String(reason).slice(0, 120),
            updatedAtISO: new Date().toISOString()
        });
    } catch (e) {
        console.error("Falha ao cancelar pedido:", e);
    }
}

function publicOrder(order) {
    const copy = Object.assign({}, order);
    delete copy.adminNote;
    delete copy.stockApplied;
    delete copy.createdAt;
    return copy;
}

// ============================================================================
// VALIDACAO E PRECOS
// ============================================================================
function validateCustomer(c) {
    c = c || {};
    const matricula = String(c.matricula || "").replace(/\D/g, "");
    if (matricula.length !== 12) throw new HttpError(400, "A Matrícula UERJ deve ter exatamente 12 dígitos.");

    const cpf = String(c.cpf || "").replace(/\D/g, "");
    if (!isValidCpf(cpf)) throw new HttpError(400, "CPF inválido.");

    const phone = String(c.phone || "").replace(/\D/g, "");
    if (phone.length < 10 || phone.length > 11) throw new HttpError(400, "WhatsApp inválido. Informe o DDD.");

    return { matricula: matricula, cpf: cpf, phone: formatPhone(phone) };
}

function validatePayment(p) {
    p = p || {};
    if (p.method === "pix") return { method: "pix" };

    if (p.method === "card") {
        const installments = Number(p.installments);
        if (!Number.isInteger(installments) || !INSTALLMENT_RATES[installments]) {
            throw new HttpError(400, "Quantidade de parcelas inválida.");
        }
        const token = String(p.token || "");
        if (!/^[A-Za-z0-9]{16,64}$/.test(token)) throw new HttpError(400, "Token do cartão inválido.");
        const paymentMethodId = String(p.paymentMethodId || "");
        if (!/^[a-z_]{2,30}$/.test(paymentMethodId)) throw new HttpError(400, "Bandeira do cartão inválida.");
        const issuerId = p.issuerId ? String(p.issuerId) : "";
        if (issuerId && !/^\d{1,12}$/.test(issuerId)) throw new HttpError(400, "Emissor do cartão inválido.");
        return { method: "card", installments: installments, token: token, paymentMethodId: paymentMethodId, issuerId: issuerId };
    }

    throw new HttpError(400, "Forma de pagamento inválida.");
}

function priceItems(rawItems, catalog) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw new HttpError(400, "Seu carrinho está vazio.");
    if (rawItems.length > MAX_CART_ITEMS) throw new HttpError(400, "Carrinho com itens demais.");

    const immediateRequested = {};

    return rawItems.map(function (raw) {
        raw = raw || {};
        // Busca so entre os produtos reais (ignora chaves internas como "__proto__")
        const productKey = String(raw.id || "");
        const product = Object.prototype.hasOwnProperty.call(catalog, productKey) ? catalog[productKey] : null;
        if (!product) throw new HttpError(400, "Um produto do carrinho não existe mais. Atualize a página.");
        if (product.status !== "disponivel") throw new HttpError(400, "\"" + product.name + "\" não está disponível no momento.");

        const quantity = Number(raw.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_ITEM) {
            throw new HttpError(400, "Quantidade inválida para \"" + product.name + "\" (máximo " + MAX_QTY_PER_ITEM + ").");
        }

        // Modelo (ex.: camisa de jogo Linha / Goleiro): obrigatorio quando o produto tem modelos
        let variant = null;
        const variantList = Array.isArray(product.variants) ? product.variants.filter(function (v) { return v && v.id; }) : [];
        if (variantList.length > 0) {
            const wanted = String(raw.variant || "");
            variant = variantList.find(function (v) { return String(v.id) === wanted; }) || null;
            if (!variant) throw new HttpError(400, "Escolha o modelo de \"" + product.name + "\" (Linha ou Goleiro).");
        }

        let size = "Único";
        if (product.hasSize) {
            size = String(raw.size || "");
            if (SIZES.indexOf(size) === -1) throw new HttpError(400, "Tamanho inválido para \"" + product.name + "\".");
        }

        let customName = "";
        let customNumber = "";
        if (product.isShirt) {
            customName = String(raw.customName || "").trim().toUpperCase();
            customNumber = String(raw.customNumber || "").trim();
            if (customName.length > 10 || !CUSTOM_NAME_REGEX.test(customName)) {
                throw new HttpError(400, "Nome personalizado inválido (até 10 letras).");
            }
            if (!/^\d{0,2}$/.test(customNumber)) throw new HttpError(400, "Número personalizado inválido (0 a 99).");
        }

        const customFee = (customName ? PRICING_RULES.CUSTOM_NAME_FEE : 0) + (customNumber ? PRICING_RULES.CUSTOM_NUMBER_FEE : 0);
        const deliveryMode = raw.deliveryMode === "imediata" ? "imediata" : "lote";

        if (deliveryMode === "imediata") {
            if (customFee > 0) throw new HttpError(400, "Peças com nome ou número só podem ser pedidas no Lote.");
            immediateRequested[product.id] = (immediateRequested[product.id] || 0) + quantity;
            if (immediateRequested[product.id] > Number(product.immediateStock || 0)) {
                throw new HttpError(400, "Estoque insuficiente para pronta entrega de \"" + product.name + "\".");
            }
        }

        const basePrice = round2(Number(product.price));
        if (!(basePrice > 0)) throw new HttpError(400, "\"" + product.name + "\" está sem preço configurado.");
        const deliveryFee = deliveryMode === "imediata" ? PRICING_RULES.IMMEDIATE_DELIVERY_FEE : 0;

        const variantImages = variant && Array.isArray(variant.images) && variant.images[0] ? variant.images : null;
        const images = variantImages || product.images;

        return {
            id: product.id,
            name: String(product.name || "") + (variant ? " (" + String(variant.label || variant.id) + ")" : ""),
            variant: variant ? String(variant.id) : "",
            variantLabel: variant ? String(variant.label || variant.id) : "",
            size: size,
            customName: customName,
            customNumber: customNumber,
            deliveryMode: deliveryMode,
            isShirt: Boolean(product.isShirt),
            quantity: quantity,
            basePrice: basePrice,
            customFee: customFee,
            deliveryFee: deliveryFee,
            price: round2(basePrice + customFee + deliveryFee),
            img: (Array.isArray(images) && images[0]) ? String(images[0]) : "assets/img/logo-atletica.jpg"
        };
    });
}

async function loadCatalog(env) {
    const docs = await fsList(env, productsCollectionPath(env));
    const catalog = Object.create(null);
    for (const d of docs) {
        const id = String(d.data.id || d.id);
        catalog[id] = Object.assign({}, d.data, { id: id });
    }
    return catalog;
}

function isValidCpf(cpf) {
    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
    for (const t of [9, 10]) {
        let sum = 0;
        for (let i = 0; i < t; i++) sum += Number(cpf[i]) * (t + 1 - i);
        const digit = ((sum * 10) % 11) % 10;
        if (digit !== Number(cpf[t])) return false;
    }
    return true;
}

function maskCpfPartial(cpf) {
    return "***." + cpf.slice(3, 6) + "." + cpf.slice(6, 9) + "-**";
}

function formatPhone(d) {
    if (d.length === 11) return "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7);
    return "(" + d.slice(0, 2) + ") " + d.slice(2, 6) + "-" + d.slice(6);
}

function splitName(fullName) {
    const parts = String(fullName).trim().split(/\s+/);
    return { first: parts[0] || "Aluno", last: parts.slice(1).join(" ") || "FurioZOs" };
}

function sanitizeText(value, max) {
    return String(value || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max);
}

function round2(n) {
    return Number(Number(n).toFixed(2));
}

function newOrderId() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let out = "";
    for (const b of bytes) out += alphabet[b % alphabet.length];
    return "FZ-" + out;
}

// Data no fuso de Brasilia, formato aceito pelo Mercado Pago
function mpDate(ms) {
    return new Date(ms - 3 * 3600 * 1000).toISOString().replace("Z", "-03:00");
}

// ============================================================================
// AUTENTICACAO FIREBASE (verificacao do ID token sem bibliotecas)
// ============================================================================
async function requireUser(request, env) {
    const header = request.headers.get("Authorization") || "";
    const match = header.match(/^Bearer\s+(.+)$/);
    if (!match) throw new HttpError(401, "Faça login para continuar.");

    let claims;
    try {
        claims = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
    } catch (e) {
        throw new HttpError(401, "Sessão expirada. Saia e entre novamente na sua conta.");
    }

    const provider = claims.firebase && claims.firebase.sign_in_provider;
    if (provider === "anonymous") throw new HttpError(401, "Faça login para continuar.");
    return claims;
}

let jwksCache = null;

async function getFirebaseJwks(forceRefresh) {
    if (!forceRefresh && jwksCache && jwksCache.exp > Date.now()) return jwksCache.keys;
    const res = await fetch(FIREBASE_JWKS_URL);
    if (!res.ok) throw new Error("JWKS indisponível");
    const data = await res.json();
    const cacheControl = res.headers.get("Cache-Control") || "";
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
    const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
    jwksCache = { keys: data.keys || [], exp: Date.now() + maxAge * 1000 };
    return jwksCache.keys;
}

async function verifyFirebaseIdToken(token, projectId) {
    const parts = String(token).split(".");
    if (parts.length !== 3) throw new Error("Token malformado");

    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (header.alg !== "RS256" || !header.kid) throw new Error("Algoritmo inválido");

    let keys = await getFirebaseJwks(false);
    let jwk = keys.find(function (k) { return k.kid === header.kid; });
    if (!jwk) {
        keys = await getFirebaseJwks(true);
        jwk = keys.find(function (k) { return k.kid === header.kid; });
    }
    if (!jwk) throw new Error("Chave desconhecida");

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), utf8(parts[0] + "." + parts[1]));
    if (!valid) throw new Error("Assinatura inválida");

    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== projectId) throw new Error("aud inválido");
    if (payload.iss !== "https://securetoken.google.com/" + projectId) throw new Error("iss inválido");
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("sub inválido");
    if (!(payload.exp > now)) throw new Error("Token expirado");
    if (payload.iat > now + 300) throw new Error("iat no futuro");
    return payload;
}

// ============================================================================
// FIRESTORE VIA REST (conta de servico; ignora as regras do cliente)
// ============================================================================
const googleTokenCache = {};
const SCOPE_DATASTORE = "https://www.googleapis.com/auth/datastore";
const SCOPE_IDENTITY = "https://www.googleapis.com/auth/identitytoolkit";

async function getGoogleAccessToken(env, scope) {
    scope = scope || SCOPE_DATASTORE;
    const now = Math.floor(Date.now() / 1000);
    const cached = googleTokenCache[scope];
    if (cached && cached.exp - 120 > now) return cached.token;

    const header = b64urlJson({ alg: "RS256", typ: "JWT" });
    const claims = b64urlJson({
        iss: env.GCP_SA_CLIENT_EMAIL,
        scope: scope,
        aud: GOOGLE_TOKEN_URL,
        iat: now,
        exp: now + 3600
    });
    const unsigned = header + "." + claims;
    const key = await importServiceAccountKey(env.GCP_SA_PRIVATE_KEY);
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(unsigned)));
    const assertion = unsigned + "." + b64urlBytes(signature);

    const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: assertion }).toString()
    });
    if (!res.ok) throw new Error("Falha ao autenticar a conta de serviço: " + (await res.text()));
    const data = await res.json();
    googleTokenCache[scope] = { token: data.access_token, exp: now + Number(data.expires_in || 3600) };
    return data.access_token;
}

async function importServiceAccountKey(pem) {
    const clean = String(pem || "")
        .replace(/\\n/g, "\n")
        .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, "")
        .replace(/\s+/g, "");
    const der = Uint8Array.from(atob(clean), function (c) { return c.charCodeAt(0); });
    return crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

function fsBase(env) {
    return "https://firestore.googleapis.com/v1/projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents";
}
function appIdOf(env) {
    return env.APP_ID || "furiozos-app";
}
function productsCollectionPath(env) {
    return "artifacts/" + appIdOf(env) + "/public/data/products";
}
function ordersCollectionPath(env) {
    return "artifacts/" + appIdOf(env) + "/public/data/orders";
}
function orderDocPath(env, orderId) {
    return ordersCollectionPath(env) + "/" + orderId;
}

async function fsFetch(env, method, pathAndQuery, body) {
    const token = await getGoogleAccessToken(env);
    return fetch(fsBase(env) + "/" + pathAndQuery, {
        method: method,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
    });
}

async function fsGet(env, docPath) {
    const res = await fsFetch(env, "GET", docPath);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("Firestore GET " + res.status + ": " + (await res.text()));
    const d = await res.json();
    return { data: decodeFields(d.fields || {}), updateTime: d.updateTime };
}

async function fsList(env, collectionPath) {
    const out = [];
    let pageToken = "";
    for (let page = 0; page < 20; page++) {
        const q = "?pageSize=300" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
        const res = await fsFetch(env, "GET", collectionPath + q);
        if (!res.ok) throw new Error("Firestore LIST " + res.status + ": " + (await res.text()));
        const data = await res.json();
        for (const d of data.documents || []) {
            out.push({ id: d.name.split("/").pop(), data: decodeFields(d.fields || {}), updateTime: d.updateTime });
        }
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
    }
    return out;
}

async function fsCreate(env, collectionPath, docId, data) {
    const res = await fsFetch(env, "POST", collectionPath + "?documentId=" + encodeURIComponent(docId), { fields: encodeFields(data) });
    if (!res.ok) throw new Error("Firestore CREATE " + res.status + ": " + (await res.text()));
}

// Retorna false quando a precondicao (updateTime) falha por concorrencia
async function fsPatch(env, docPath, data, updateTime) {
    const params = Object.keys(data).map(function (k) { return "updateMask.fieldPaths=" + encodeURIComponent(k); });
    if (updateTime) params.push("currentDocument.updateTime=" + encodeURIComponent(updateTime));
    else params.push("currentDocument.exists=true");

    const res = await fsFetch(env, "PATCH", docPath + "?" + params.join("&"), { fields: encodeFields(data) });
    if (res.ok) return true;

    const text = await res.text();
    if (updateTime && /FAILED_PRECONDITION|ABORTED/.test(text)) return false;
    throw new Error("Firestore PATCH " + res.status + ": " + text);
}

function encodeValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "string") return { stringValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
    if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
    return { stringValue: String(v) };
}

function encodeFields(obj) {
    const fields = {};
    for (const k of Object.keys(obj)) fields[k] = encodeValue(obj[k]);
    return fields;
}

function decodeValue(v) {
    if (!v) return null;
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return Number(v.doubleValue);
    if ("booleanValue" in v) return v.booleanValue;
    if ("nullValue" in v) return null;
    if ("timestampValue" in v) return v.timestampValue;
    if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
    if ("referenceValue" in v) return v.referenceValue;
    return null;
}

function decodeFields(fields) {
    const out = {};
    for (const k of Object.keys(fields)) out[k] = decodeValue(fields[k]);
    return out;
}

// ============================================================================
// MERCADO PAGO E UTILITARIOS
// ============================================================================
async function mpFetch(env, path, init) {
    init = init || {};
    const res = await fetch(MP_API + path, {
        method: init.method || "GET",
        headers: Object.assign(
            { Authorization: "Bearer " + env.MP_ACCESS_TOKEN, "Content-Type": "application/json" },
            init.headers || {}
        ),
        body: init.body
    });
    let data = null;
    try {
        data = await res.json();
    } catch (e) {
        data = null;
    }
    return { ok: res.ok, status: res.status, data: data };
}

function corsHeaders(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    if (!origin || allowed.indexOf(origin) === -1) return null;
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
    };
}

function json(data, status, extraHeaders) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: Object.assign(
            { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
            extraHeaders || {}
        )
    });
}

// Rate Limiting binding da Cloudflare. Se o binding nao existir ou falhar,
// libera e deixa a camada em memoria decidir (nunca derruba o pagamento).
async function bindingAllows(limiter, key) {
    if (!limiter || typeof limiter.limit !== "function") return true;
    try {
        const r = await limiter.limit({ key: key });
        return !r || r.success !== false;
    } catch (e) {
        console.error("rate limit binding:", e && e.message ? e.message : e);
        return true;
    }
}

const rateBuckets = new Map();

function isRateLimited(key, max, windowMs) {
    const now = Date.now();
    if (rateBuckets.size > 5000) {
        rateBuckets.forEach(function (v, k) { if (v.reset <= now) rateBuckets.delete(k); });
    }
    let b = rateBuckets.get(key);
    if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(key, b); }
    b.count++;
    return b.count > max;
}

async function readJson(request) {
    const text = await request.text();
    if (text.length > 50000) throw new HttpError(413, "Requisição muito grande.");
    try {
        return JSON.parse(text || "{}");
    } catch (e) {
        throw new HttpError(400, "JSON inválido.");
    }
}

function utf8(s) {
    return new TextEncoder().encode(s);
}

function b64urlBytes(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj) {
    return b64urlBytes(utf8(JSON.stringify(obj)));
}

function b64urlDecode(str) {
    let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// ============================================================================
// ============================================================================
// BILHETERIA DE EVENTOS (PRD_EVENTOS.md)
// ----------------------------------------------------------------------------
// Tudo aqui e independente da loja: colecoes proprias (events, tickets,
// ticketOrders), pedidos com prefixo EV- e nenhuma funcao da loja alterada.
// ============================================================================
// ============================================================================
const TICKET_PIX_MINUTES = 10;
const RESERVATION_GRACE_MS = 2 * 60 * 1000; // folga antes de devolver a vaga
const MAX_TICKETS_PER_ORDER = 5;
const MAX_COURTESY_PER_REQUEST = 20;
const TRANSFER_OFFER_HOURS = 48;
const EVENT_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,60}$/;
const BATCH_ID_REGEX = /^[A-Za-z0-9_-]{1,40}$/;
const TICKET_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TORDER = {
    RESERVED: "reserved",
    PAID: "paid",
    EXPIRED: "expired",
    CANCELLED: "cancelled",
    REFUNDED: "refunded",
    REVIEW: "review"
};

function dataRoot(env) {
    return "artifacts/" + appIdOf(env) + "/public/data";
}
function eventDocPath(env, eventId) {
    return dataRoot(env) + "/events/" + eventId;
}
function batchDocPath(env, eventId, batchId) {
    return eventDocPath(env, eventId) + "/batches/" + batchId;
}
function ticketDocPath(env, ticketId) {
    return dataRoot(env) + "/tickets/" + ticketId;
}
function ticketOrderDocPath(env, orderId) {
    return dataRoot(env) + "/ticketOrders/" + orderId;
}

function toMs(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        const t = Date.parse(v);
        return isNaN(t) ? 0 : t;
    }
    return 0;
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function requireTicketSecret(env) {
    if (!env.TICKET_SECRET_KEY || String(env.TICKET_SECRET_KEY).length < 16) {
        throw new HttpError(503, "A bilheteria ainda não foi configurada pela diretoria.");
    }
}

async function isAdminUser(env, uid) {
    return Boolean(await fsGet(env, "artifacts/" + appIdOf(env) + "/admins/" + encodeURIComponent(uid)));
}
async function isStaffUser(env, uid) {
    if (await isAdminUser(env, uid)) return true;
    return Boolean(await fsGet(env, "artifacts/" + appIdOf(env) + "/staff/" + encodeURIComponent(uid)));
}
async function isMemberUser(env, uid) {
    return Boolean(await fsGet(env, "artifacts/" + appIdOf(env) + "/members/" + encodeURIComponent(uid)));
}

// ---------------------------------------------------------------------------
// Assinatura dos ingressos
// A chave-mestra (TICKET_SECRET_KEY) nunca sai do Worker. Cada evento tem uma
// chave derivada dela; e essa chave derivada que a portaria baixa para validar
// offline. Se um aparelho da portaria vazar, so aquele evento e afetado.
// Token: v1:{ticketId}:{eventId}:{ownerUid}:{issuedAt}.{HMAC-SHA256 base64url}
// (k1: no lugar de v1: para o QR de retirada do kit)
// ---------------------------------------------------------------------------
async function hmacSha256(keyBytes, message) {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(message)));
}

async function eventKeyBytes(env, eventId) {
    return hmacSha256(utf8(String(env.TICKET_SECRET_KEY)), "furiozos-ticket-key:v1:" + eventId);
}

async function signTicketToken(env, prefix, ticketId, eventId, ownerUid, issuedAt) {
    const payload = [prefix, ticketId, eventId, ownerUid, String(issuedAt)].join(":");
    const mac = await hmacSha256(await eventKeyBytes(env, eventId), payload);
    return payload + "." + b64urlBytes(mac);
}

async function sha256Hex(text) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
    return Array.from(digest).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function randomToken(bytes) {
    return b64urlBytes(crypto.getRandomValues(new Uint8Array(bytes)));
}

function newTicketOrderId() {
    return "EV-" + newOrderId().slice(3);
}

// ---------------------------------------------------------------------------
// Firestore: gravacao atomica (commit) e consulta por igualdade
// ---------------------------------------------------------------------------
function fsDocName(env, docPath) {
    return "projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/" + docPath;
}

// opts: { updateTime, exists, increments: { campo: +n } }
function wUpdate(env, docPath, data, opts) {
    opts = opts || {};
    const w = {
        update: { name: fsDocName(env, docPath), fields: encodeFields(data) },
        updateMask: { fieldPaths: Object.keys(data) }
    };
    if (opts.updateTime) w.currentDocument = { updateTime: opts.updateTime };
    else if (opts.exists !== undefined) w.currentDocument = { exists: opts.exists };
    if (opts.increments) {
        w.updateTransforms = Object.keys(opts.increments).map(function (field) {
            return { fieldPath: field, increment: { integerValue: String(opts.increments[field]) } };
        });
    }
    return w;
}

function wCreate(env, docPath, data) {
    return {
        update: { name: fsDocName(env, docPath), fields: encodeFields(data) },
        currentDocument: { exists: false }
    };
}

// Tudo ou nada. Retorna false quando alguma precondicao falha (concorrencia).
async function fsCommit(env, writes) {
    const token = await getGoogleAccessToken(env);
    const res = await fetch(fsBase(env) + ":commit", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ writes: writes })
    });
    if (res.ok) return true;
    const text = await res.text();
    if (/FAILED_PRECONDITION|ABORTED|ALREADY_EXISTS|NOT_FOUND/.test(text)) return false;
    throw new Error("Firestore COMMIT " + res.status + ": " + text);
}

async function fsQueryEq(env, parentPath, collectionId, field, value, limit) {
    const res = await fsFetch(env, "POST", parentPath + ":runQuery", {
        structuredQuery: {
            from: [{ collectionId: collectionId }],
            where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: encodeValue(value) } },
            limit: limit || 100
        }
    });
    if (!res.ok) throw new Error("Firestore QUERY " + res.status + ": " + (await res.text()));
    const rows = await res.json();
    const out = [];
    for (const r of rows || []) {
        if (r && r.document) {
            out.push({
                id: r.document.name.split("/").pop(),
                data: decodeFields(r.document.fields || {}),
                updateTime: r.document.updateTime
            });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Validacao do titular
// ---------------------------------------------------------------------------
function validateTicketHolder(c, fallbackName) {
    c = c || {};
    const name = sanitizeText(c.name || fallbackName || "", 80);
    if (name.length < 3) throw new HttpError(400, "Informe o nome completo do titular do ingresso.");

    const cpf = String(c.cpf || "").replace(/\D/g, "");
    if (!isValidCpf(cpf)) throw new HttpError(400, "CPF inválido.");

    const matricula = String(c.matricula || "").replace(/\D/g, "");
    if (matricula && matricula.length !== 12) throw new HttpError(400, "A Matrícula UERJ deve ter exatamente 12 dígitos.");

    const phoneDigits = String(c.phone || "").replace(/\D/g, "");
    if (phoneDigits && (phoneDigits.length < 10 || phoneDigits.length > 11)) {
        throw new HttpError(400, "WhatsApp inválido. Informe o DDD.");
    }

    return { name: name, cpf: cpf, matricula: matricula, phone: phoneDigits ? formatPhone(phoneDigits) : "" };
}

function ticketUnitPrice(batch, kind, isMember) {
    const price = round2(Number(batch.price));
    const memberPrice = round2(Number(batch.memberPrice || 0));
    const memberDiscount = (isMember && memberPrice > 0 && memberPrice < price) ? round2(price - memberPrice) : 0;

    let unit = price;
    if (kind === "combo") {
        const comboPrice = round2(Number(batch.comboPrice || 0));
        if (comboPrice > 0) unit = comboPrice;
    }
    unit = round2(unit - memberDiscount);
    if (!(unit > 0)) throw new HttpError(400, "Este lote está sem preço configurado.");
    return { unit: unit, memberApplied: memberDiscount > 0 };
}

function publicTicketOrder(order) {
    const copy = Object.assign({}, order);
    delete copy.adminNote;
    delete copy.createdAt;
    delete copy.stockApplied;
    return copy;
}

// ============================================================================
// 3.1 RESERVA ATOMICA E ANTI-OVERBOOKING  (POST /api/events/checkout)
// ============================================================================
async function handleEventCheckout(request, env, url) {
    const user = await requireUser(request, env);
    const blocked = !(await bindingAllows(env.CHECKOUT_LIMITER, "evcheckout:" + user.sub))
        || isRateLimited("evcheckout:" + user.sub, 6, 10 * 60 * 1000);
    if (blocked) throw new HttpError(429, "Muitas tentativas de compra. Aguarde alguns minutos.");
    if (user.email_verified !== true) {
        throw new HttpError(403, "Confirme seu e-mail antes de comprar. Abra o link que enviamos e tente de novo.");
    }
    if (!user.email) throw new HttpError(400, "Sua conta precisa ter um e-mail para comprar.");
    requireTicketSecret(env);

    const body = await readJson(request);
    const eventId = String(body.eventId || "");
    if (!EVENT_ID_REGEX.test(eventId)) throw new HttpError(400, "Evento inválido.");

    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TICKETS_PER_ORDER) {
        throw new HttpError(400, "Quantidade inválida (máximo " + MAX_TICKETS_PER_ORDER + " ingressos por compra).");
    }
    const kind = body.kind === "combo" ? "combo" : "avulso";
    const buyer = validateTicketHolder(body.customer, user.name);

    const evSnap = await fsGet(env, eventDocPath(env, eventId));
    if (!evSnap) throw new HttpError(404, "Evento não encontrado.");
    const ev = evSnap.data;
    if (ev.status !== "published") throw new HttpError(400, "As vendas deste evento não estão abertas no momento.");
    const endsAtMs = toMs(ev.endsAt) || toMs(ev.startsAt);
    if (endsAtMs && endsAtMs < Date.now()) throw new HttpError(400, "Este evento já aconteceu.");

    const batchId = String(ev.activeBatchId || "");
    if (!BATCH_ID_REGEX.test(batchId)) throw new HttpError(400, "Este evento ainda não tem lote aberto.");
    const batchPath = batchDocPath(env, eventId, batchId);

    const isMember = await isMemberUser(env, user.sub);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAtMs = nowMs + TICKET_PIX_MINUTES * 60 * 1000;

    let order = null;
    let swept = false;

    for (let attempt = 0; attempt < 7 && !order; attempt++) {
        const batchSnap = await fsGet(env, batchPath);
        if (!batchSnap) throw new HttpError(400, "O lote deste evento não está mais disponível. Atualize a página.");
        const batch = batchSnap.data;

        const totalQty = Number(batch.totalQuantity || 0);
        const taken = Number(batch.soldQuantity || 0) + Number(batch.reservedQuantity || 0);
        const left = totalQty - taken;

        if (left < quantity) {
            // Antes de recusar, devolve as vagas de PIX vencidos deste lote
            if (!swept) {
                swept = true;
                const freed = await sweepExpiredReservations(env, { eventId: eventId, batchId: batchId });
                if (freed > 0) continue;
            }
            if (left <= 0) throw new HttpError(409, "Este lote esgotou. Atualize a página para ver o próximo lote.", "sold_out");
            throw new HttpError(409, "Restam só " + left + " ingresso(s) neste lote.", "not_enough");
        }

        const comboIds = Array.isArray(batch.comboItems) ? batch.comboItems.map(String).filter(Boolean).slice(0, 10) : [];
        if (kind === "combo" && comboIds.length === 0) throw new HttpError(400, "Este lote não tem combo.");
        const pricing = ticketUnitPrice(batch, kind, isMember);
        const total = round2(pricing.unit * quantity);

        // Nomes dos produtos do combo (so para exibir no ingresso e na retirada)
        const comboNames = [];
        if (kind === "combo") {
            for (const pid of comboIds) {
                const pSnap = await fsGet(env, productsCollectionPath(env) + "/" + encodeURIComponent(pid));
                comboNames.push(pSnap ? String(pSnap.data.name || pid) : pid);
            }
        }

        const orderId = newTicketOrderId();
        const ticketIds = [];
        for (let i = 0; i < quantity; i++) ticketIds.push(crypto.randomUUID());

        const candidate = {
            orderId: orderId,
            userId: user.sub,
            eventId: eventId,
            eventTitle: String(ev.title || ""),
            batchId: batchId,
            batchName: String(batch.name || ""),
            kind: kind,
            quantity: quantity,
            unitPrice: pricing.unit,
            memberPrice: pricing.memberApplied,
            total: total,
            comboItems: kind === "combo" ? comboIds : [],
            comboItemNames: comboNames,
            ticketIds: ticketIds,
            customerName: buyer.name,
            customerEmail: user.email,
            customerPhone: buyer.phone,
            customerCpf: maskCpfPartial(buyer.cpf),
            customerMatricula: buyer.matricula,
            status: TORDER.RESERVED,
            expiresAtMs: expiresAtMs,
            expiresAtISO: new Date(expiresAtMs).toISOString(),
            mpPaymentId: "",
            mpStatus: "",
            mpStatusDetail: "",
            stockApplied: false,
            createdAtISO: nowIso,
            updatedAtISO: nowIso,
            createdAt: new Date(nowIso)
        };

        // Atomico: a vaga so e travada se ninguem mexeu no lote desde a leitura
        const writes = [
            wUpdate(env, batchPath, { updatedAtISO: nowIso }, {
                updateTime: batchSnap.updateTime,
                increments: { reservedQuantity: quantity }
            }),
            wCreate(env, ticketOrderDocPath(env, orderId), candidate)
        ];
        for (const tid of ticketIds) {
            writes.push(wCreate(env, ticketDocPath(env, tid), {
                id: tid,
                eventId: eventId,
                eventTitle: candidate.eventTitle,
                eventStartsAt: ev.startsAt ? new Date(toMs(ev.startsAt)) : null,
                batchId: batchId,
                batchName: candidate.batchName,
                orderId: orderId,
                ownerUid: user.sub,
                ownerName: buyer.name,
                ownerCpf: candidate.customerCpf,
                ownerMatricula: buyer.matricula,
                status: "reserved",
                qrSignature: "",
                kitSignature: "",
                isCombo: kind === "combo",
                comboItems: comboNames,
                comboRedeemed: false,
                courtesy: false,
                price: pricing.unit,
                checkedInAt: null,
                checkedInBy: null,
                transferHistory: [],
                createdAtISO: nowIso
            }));
        }

        if (await fsCommit(env, writes)) {
            order = candidate;
        } else {
            await sleep(40 + Math.floor(Math.random() * 120) * (attempt + 1));
        }
    }

    if (!order) {
        throw new HttpError(409, "Muita gente comprando ao mesmo tempo. Tente de novo em alguns segundos.", "busy");
    }

    // ---- PIX no Mercado Pago (10 minutos) ----
    const names = splitName(order.customerName);
    const mpBody = {
        transaction_amount: order.total,
        description: "Ingresso " + order.orderId + " - " + sanitizeText(order.eventTitle, 60),
        external_reference: order.orderId,
        notification_url: url.origin + "/api/webhooks/mercadopago",
        metadata: { order_id: order.orderId, user_id: user.sub, event_id: eventId, ticket_ids: order.ticketIds.join(",") },
        payment_method_id: "pix",
        date_of_expiration: mpDate(expiresAtMs),
        payer: {
            email: user.email,
            first_name: names.first,
            last_name: names.last,
            identification: { type: "CPF", number: buyer.cpf }
        }
    };

    let mpRes = null;
    try {
        mpRes = await mpFetch(env, "/v1/payments", {
            method: "POST",
            headers: { "X-Idempotency-Key": order.orderId },
            body: JSON.stringify(mpBody)
        });
    } catch (e) {
        mpRes = null;
    }

    const p = mpRes && mpRes.ok && mpRes.data && mpRes.data.id ? mpRes.data : null;
    const tx = p && p.point_of_interaction && p.point_of_interaction.transaction_data;
    if (!p || !tx || !tx.qr_code) {
        const d = (mpRes && mpRes.data) || {};
        await releaseReservation(env, order.orderId, TORDER.CANCELLED, String(d.status_detail || d.error || "erro_mp"));
        if (!mpRes) throw new HttpError(502, "Não foi possível comunicar com o Mercado Pago. Tente novamente.");
        throw new HttpError(p ? 502 : 400, String(d.message || "O Mercado Pago não gerou o PIX. Tente novamente."), String(d.status_detail || ""));
    }

    await fsPatch(env, ticketOrderDocPath(env, order.orderId), {
        mpPaymentId: String(p.id),
        mpStatus: String(p.status || ""),
        mpStatusDetail: String(p.status_detail || "")
    });
    order.mpPaymentId = String(p.id);

    return {
        orderId: order.orderId,
        status: order.status,
        total: order.total,
        expiresAtMs: expiresAtMs,
        order: publicTicketOrder(order),
        pix: {
            qrCode: String(tx.qr_code),
            qrCodeBase64: String(tx.qr_code_base64 || ""),
            expiresAt: new Date(expiresAtMs).toISOString()
        }
    };
}

// Devolve a vaga ao lote. Idempotente: so age se o pedido ainda esta "reserved".
async function releaseReservation(env, orderId, newStatus, reason) {
    const path = ticketOrderDocPath(env, orderId);
    for (let attempt = 0; attempt < 4; attempt++) {
        const snap = await fsGet(env, path);
        if (!snap || snap.data.status !== TORDER.RESERVED) return false;
        const order = snap.data;
        const nowIso = new Date().toISOString();

        const writes = [
            wUpdate(env, path, {
                status: newStatus || TORDER.EXPIRED,
                mpStatusDetail: String(reason || "").slice(0, 120),
                updatedAtISO: nowIso
            }, { updateTime: snap.updateTime }),
            wUpdate(env, batchDocPath(env, order.eventId, order.batchId), { updatedAtISO: nowIso }, {
                exists: true,
                increments: { reservedQuantity: -Number(order.quantity || 0) }
            })
        ];
        for (const tid of order.ticketIds || []) {
            writes.push(wUpdate(env, ticketDocPath(env, tid), { status: "cancelled" }, { exists: true }));
        }
        if (await fsCommit(env, writes)) return true;
    }
    return false;
}

// Varre as reservas vencidas. Antes de devolver a vaga confere no Mercado Pago
// se o PIX nao foi pago (protege contra webhook perdido).
async function sweepExpiredReservations(env, filter) {
    const rows = await fsQueryEq(env, dataRoot(env), "ticketOrders", "status", TORDER.RESERVED, 200);
    const now = Date.now();
    let freed = 0;
    let handled = 0;

    for (const row of rows) {
        const o = row.data;
        if (filter && (o.eventId !== filter.eventId || o.batchId !== filter.batchId)) continue;
        if (Number(o.expiresAtMs || 0) + RESERVATION_GRACE_MS > now) continue;
        if (handled++ >= 30) break;

        try {
            if (o.mpPaymentId) {
                const mp = await mpFetch(env, "/v1/payments/" + encodeURIComponent(o.mpPaymentId), { method: "GET" });
                if (mp.ok && mp.data && String(mp.data.status) === "approved") {
                    await reconcileTicketPayment(env, mp.data);
                    continue;
                }
            }
            if (await releaseReservation(env, row.id, TORDER.EXPIRED, "pix_expirado")) {
                freed += Number(o.quantity || 0);
            }
        } catch (e) {
            console.error("sweep " + row.id + ":", e && e.message ? e.message : e);
        }
    }
    return freed;
}

// ============================================================================
// STATUS DO PEDIDO DE INGRESSO (GET /api/events/orders/:orderId)
// ============================================================================
async function handleTicketOrderStatus(request, env, orderId) {
    const user = await requireUser(request, env);
    const path = ticketOrderDocPath(env, orderId);
    let snap = await fsGet(env, path);
    if (!snap || snap.data.userId !== user.sub) throw new HttpError(404, "Pedido não encontrado.");

    if (snap.data.status === TORDER.RESERVED && snap.data.mpPaymentId) {
        const mp = await mpFetch(env, "/v1/payments/" + encodeURIComponent(snap.data.mpPaymentId), { method: "GET" });
        if (mp.ok && mp.data) await reconcileTicketPayment(env, mp.data);
        snap = (await fsGet(env, path)) || snap;
        if (snap.data.status === TORDER.RESERVED && Number(snap.data.expiresAtMs || 0) + RESERVATION_GRACE_MS < Date.now()) {
            await releaseReservation(env, orderId, TORDER.EXPIRED, "pix_expirado");
            snap = (await fsGet(env, path)) || snap;
        }
    }
    return { orderId: orderId, status: snap.data.status, order: publicTicketOrder(snap.data) };
}

// ============================================================================
// 3.2 EMISSAO CRIPTOGRAFICA E VIRADA DE LOTE (webhook aprovado)
// ============================================================================
async function reconcileTicketPayment(env, payment) {
    const orderId = String(payment && payment.external_reference ? payment.external_reference : "");
    if (!/^EV-[A-Z0-9]{6,20}$/.test(orderId)) return null;
    const path = ticketOrderDocPath(env, orderId);
    const mpStatus = String(payment.status || "");

    for (let attempt = 0; attempt < 5; attempt++) {
        const snap = await fsGet(env, path);
        if (!snap) return null;
        const order = snap.data;

        // O pedido so aceita o pagamento que foi criado para ele
        if (order.mpPaymentId && order.mpPaymentId !== String(payment.id)) return { order: order };

        const nowIso = new Date().toISOString();
        const mpFields = {
            mpPaymentId: String(payment.id),
            mpStatus: mpStatus,
            mpStatusDetail: String(payment.status_detail || ""),
            updatedAtISO: nowIso
        };
        const batchPath = batchDocPath(env, order.eventId, order.batchId);
        const qty = Number(order.quantity || 0);

        // ---------------- APROVADO: emite os ingressos ----------------
        if (mpStatus === "approved") {
            if (order.status === TORDER.PAID || order.status === TORDER.REFUNDED) return { order: order };

            const amountOk = Math.abs(Number(payment.transaction_amount) - Number(order.total)) < 0.01 &&
                String(payment.currency_id || "BRL") === "BRL";
            if (!amountOk) {
                if (order.status === TORDER.REVIEW) return { order: order };
                const review = Object.assign({}, mpFields, {
                    status: TORDER.REVIEW,
                    adminNote: "Valor recebido diverge do total do pedido. Conferir no Mercado Pago."
                });
                const writes = [wUpdate(env, path, review, { updateTime: snap.updateTime })];
                if (order.status === TORDER.RESERVED) {
                    writes.push(wUpdate(env, batchPath, { updatedAtISO: nowIso }, { exists: true, increments: { reservedQuantity: -qty } }));
                }
                if (await fsCommit(env, writes)) return { order: Object.assign({}, order, review) };
                continue;
            }

            requireTicketSecret(env);
            const issuedAt = Math.floor(Date.now() / 1000);
            const paid = Object.assign({}, mpFields, {
                status: TORDER.PAID,
                paidAtISO: String(payment.date_approved || nowIso),
                stockApplied: true
            });
            // Pagamento que chegou depois de a vaga ter sido devolvida: o cliente
            // pagou, entao o ingresso e emitido e a diretoria e avisada.
            const wasReserved = order.status === TORDER.RESERVED;
            if (!wasReserved) paid.adminNote = "Pago após o prazo da reserva. Ingresso emitido mesmo assim; conferir a lotação do lote.";

            const writes = [
                wUpdate(env, path, paid, { updateTime: snap.updateTime }),
                wUpdate(env, batchPath, { updatedAtISO: nowIso }, {
                    exists: true,
                    increments: wasReserved
                        ? { soldQuantity: qty, reservedQuantity: -qty }
                        : { soldQuantity: qty }
                })
            ];
            for (const tid of order.ticketIds || []) {
                const fields = {
                    status: "valid",
                    qrSignature: await signTicketToken(env, "v1", tid, order.eventId, order.userId, issuedAt),
                    kitSignature: order.kind === "combo"
                        ? await signTicketToken(env, "k1", tid, order.eventId, order.userId, issuedAt)
                        : "",
                    issuedAt: issuedAt,
                    paidAtISO: paid.paidAtISO
                };
                writes.push(wUpdate(env, ticketDocPath(env, tid), fields, { exists: true }));
            }

            if (!(await fsCommit(env, writes))) continue;

            // Pos-emissao (o pedido ja esta marcado; cada passo e seguro de repetir)
            try {
                await maybeTurnBatch(env, order.eventId, order.batchId);
            } catch (e) {
                console.error("virada de lote:", e && e.message ? e.message : e);
            }
            if (!order.stockApplied && order.kind === "combo") {
                try {
                    const perProduct = {};
                    for (const pid of order.comboItems || []) perProduct[pid] = (perProduct[pid] || 0) + qty;
                    await decrementProductStock(env, perProduct);
                } catch (e) {
                    console.error("estoque do combo:", e && e.message ? e.message : e);
                }
            }
            return { order: Object.assign({}, order, paid) };
        }

        // ---------------- ESTORNADO: cancela os ingressos ----------------
        if (mpStatus === "refunded" || mpStatus === "charged_back") {
            if (order.status !== TORDER.PAID) {
                if (order.status === TORDER.RESERVED) await releaseReservation(env, orderId, TORDER.CANCELLED, mpStatus);
                return { order: order };
            }
            const refunded = Object.assign({}, mpFields, { status: TORDER.REFUNDED });
            const writes = [
                wUpdate(env, path, refunded, { updateTime: snap.updateTime }),
                wUpdate(env, batchPath, { updatedAtISO: nowIso }, { exists: true, increments: { soldQuantity: -qty } })
            ];
            for (const tid of order.ticketIds || []) {
                writes.push(wUpdate(env, ticketDocPath(env, tid), { status: "cancelled", qrSignature: "", kitSignature: "" }, { exists: true }));
            }
            if (await fsCommit(env, writes)) return { order: Object.assign({}, order, refunded) };
            continue;
        }

        // ---------------- CANCELADO / RECUSADO / EXPIRADO: devolve a vaga ----------------
        if (mpStatus === "cancelled" || mpStatus === "rejected") {
            if (order.status === TORDER.RESERVED) {
                await releaseReservation(env, orderId, mpStatus === "cancelled" ? TORDER.EXPIRED : TORDER.CANCELLED, String(payment.status_detail || mpStatus));
            }
            return { order: order };
        }

        // pending / in_process: nada a fazer ainda
        return { order: order };
    }

    throw new Error("Conflito repetido ao atualizar o pedido de ingresso " + orderId);
}

// Lote esgotado + autoTurn: o evento passa a apontar para o proximo lote
async function maybeTurnBatch(env, eventId, batchId) {
    const batchSnap = await fsGet(env, batchDocPath(env, eventId, batchId));
    if (!batchSnap) return false;
    const b = batchSnap.data;
    if (b.autoTurn !== true) return false;
    if (Number(b.soldQuantity || 0) < Number(b.totalQuantity || 0)) return false;

    const batches = await fsList(env, eventDocPath(env, eventId) + "/batches");
    const currentOrder = Number(b.order || 0);
    let next = null;
    for (const row of batches) {
        const ord = Number(row.data.order || 0);
        if (ord > currentOrder && (!next || ord < Number(next.data.order || 0))) next = row;
    }
    if (!next) return false;

    for (let attempt = 0; attempt < 3; attempt++) {
        const evSnap = await fsGet(env, eventDocPath(env, eventId));
        if (!evSnap || evSnap.data.activeBatchId !== batchId) return false;
        const ok = await fsPatch(env, eventDocPath(env, eventId), {
            activeBatchId: next.id,
            updatedAt: new Date()
        }, evSnap.updateTime);
        if (ok) return true;
    }
    return false;
}

async function decrementProductStock(env, perProduct) {
    for (const productId of Object.keys(perProduct)) {
        const path = productsCollectionPath(env) + "/" + encodeURIComponent(productId);
        for (let attempt = 0; attempt < 4; attempt++) {
            const snap = await fsGet(env, path);
            if (!snap) break;
            const next = Math.max(0, Number(snap.data.immediateStock || 0) - perProduct[productId]);
            if (await fsPatch(env, path, { immediateStock: next }, snap.updateTime)) break;
        }
    }
}

// ============================================================================
// 3.3 TRANSFERENCIA DE TITULARIDADE  (POST /api/tickets/transfer)
// ----------------------------------------------------------------------------
// Duas etapas, para quem recebe consentir e informar os proprios dados:
//   { action: "offer",  ticketId }                 -> titular gera um codigo
//   { action: "cancel", ticketId }                 -> titular desiste
//   { action: "accept", code, customer:{name,cpf} } -> quem recebe assume
// ============================================================================
function transferCutoffHours(env) {
    const h = Number(env.TRANSFER_CUTOFF_HOURS);
    return isFinite(h) && h >= 0 && h <= 720 ? h : 6;
}

async function handleTicketTransfer(request, env) {
    const user = await requireUser(request, env);
    if (isRateLimited("transfer:" + user.sub, 20, 10 * 60 * 1000)) {
        throw new HttpError(429, "Muitas tentativas. Aguarde alguns minutos.");
    }
    requireTicketSecret(env);
    const body = await readJson(request);
    const action = String(body.action || "");

    if (action === "accept") return acceptTransfer(env, user, body);

    const ticketId = String(body.ticketId || "");
    if (!TICKET_ID_REGEX.test(ticketId)) throw new HttpError(400, "Ingresso inválido.");
    const path = ticketDocPath(env, ticketId);

    for (let attempt = 0; attempt < 4; attempt++) {
        const snap = await fsGet(env, path);
        if (!snap || snap.data.ownerUid !== user.sub) throw new HttpError(404, "Ingresso não encontrado.");
        const t = snap.data;

        if (action === "cancel") {
            const ok = await fsPatch(env, path, { transferCodeHash: "", transferDeadlineMs: 0 }, snap.updateTime);
            if (ok) return { ticketId: ticketId, cancelled: true };
            continue;
        }

        if (action !== "offer") throw new HttpError(400, "Ação inválida.");
        if (t.status !== "valid") throw new HttpError(400, "Só é possível transferir ingressos válidos e ainda não utilizados.");

        const evSnap = await fsGet(env, eventDocPath(env, t.eventId));
        if (!evSnap) throw new HttpError(400, "Evento não encontrado.");
        const startsAtMs = toMs(evSnap.data.startsAt);
        const endsAtMs = toMs(evSnap.data.endsAt) || startsAtMs;
        // Cortesia pode ser repassada ate o fim do evento; ingresso comum, ate X horas antes
        const limitMs = t.courtesy === true ? endsAtMs : startsAtMs - transferCutoffHours(env) * 3600 * 1000;
        if (!limitMs || Date.now() >= limitMs) {
            throw new HttpError(400, "O prazo para transferir este ingresso já acabou.");
        }

        const secret = randomToken(18);
        const deadlineMs = Math.min(limitMs, Date.now() + TRANSFER_OFFER_HOURS * 3600 * 1000);
        const ok = await fsPatch(env, path, {
            transferCodeHash: await sha256Hex(secret),
            transferDeadlineMs: deadlineMs
        }, snap.updateTime);
        if (ok) return { ticketId: ticketId, code: ticketId + "." + secret, expiresAtMs: deadlineMs };
    }
    throw new HttpError(409, "Não foi possível concluir agora. Tente de novo.");
}

async function acceptTransfer(env, user, body) {
    if (user.email_verified !== true) {
        throw new HttpError(403, "Confirme seu e-mail antes de receber um ingresso.");
    }
    const code = String(body.code || "");
    const dot = code.indexOf(".");
    const ticketId = dot > 0 ? code.slice(0, dot) : "";
    const secret = dot > 0 ? code.slice(dot + 1) : "";
    if (!TICKET_ID_REGEX.test(ticketId) || !/^[A-Za-z0-9_-]{16,64}$/.test(secret)) {
        throw new HttpError(400, "Código de transferência inválido.");
    }
    const holder = validateTicketHolder(body.customer, user.name);
    const secretHash = await sha256Hex(secret);
    const path = ticketDocPath(env, ticketId);
    const invalid = new HttpError(400, "Este código de transferência não vale mais. Peça um novo a quem te enviou.");

    for (let attempt = 0; attempt < 4; attempt++) {
        const snap = await fsGet(env, path);
        if (!snap) throw invalid;
        const t = snap.data;
        if (!t.transferCodeHash || !timingSafeEqual(String(t.transferCodeHash), secretHash)) throw invalid;
        if (Number(t.transferDeadlineMs || 0) <= Date.now()) throw invalid;
        if (t.status !== "valid") throw invalid;
        if (t.ownerUid === user.sub) throw new HttpError(400, "Este ingresso já é seu.");

        // Nova assinatura: o QR antigo deixa de bater com o ingresso
        const issuedAt = Math.floor(Date.now() / 1000);
        const nowIso = new Date().toISOString();
        const history = Array.isArray(t.transferHistory) ? t.transferHistory.slice(-20) : [];
        history.push({
            fromUid: String(t.ownerUid || ""),
            fromName: String(t.ownerName || ""),
            toUid: user.sub,
            toName: holder.name,
            atISO: nowIso,
            status: "transferred"
        });

        const patch = {
            ownerUid: user.sub,
            ownerName: holder.name,
            ownerCpf: maskCpfPartial(holder.cpf),
            ownerMatricula: holder.matricula,
            qrSignature: await signTicketToken(env, "v1", ticketId, t.eventId, user.sub, issuedAt),
            kitSignature: t.isCombo === true
                ? await signTicketToken(env, "k1", ticketId, t.eventId, user.sub, issuedAt)
                : "",
            issuedAt: issuedAt,
            transferHistory: history,
            transferCodeHash: "",
            transferDeadlineMs: 0,
            transferredAtISO: nowIso
        };
        if (await fsPatch(env, path, patch, snap.updateTime)) {
            return { ticketId: ticketId, eventId: t.eventId, eventTitle: String(t.eventTitle || ""), transferred: true };
        }
    }
    throw new HttpError(409, "Não foi possível concluir agora. Tente de novo.");
}

// ============================================================================
// PORTARIA: chave do evento para validar o QR offline (so equipe)
// ============================================================================
async function handlePortariaKey(request, env, eventId) {
    const user = await requireUser(request, env);
    if (!(await isStaffUser(env, user.sub))) throw new HttpError(403, "Acesso restrito à equipe da portaria.");
    requireTicketSecret(env);
    const evSnap = await fsGet(env, eventDocPath(env, eventId));
    if (!evSnap) throw new HttpError(404, "Evento não encontrado.");
    return { eventId: eventId, key: b64urlBytes(await eventKeyBytes(env, eventId)), alg: "HMAC-SHA256" };
}

// ============================================================================
// CORTESIAS / VIP (so diretoria). Os ingressos nascem na carteira de quem
// emitiu, ja com um codigo de transferencia para enviar ao convidado.
// ============================================================================
async function handleCourtesy(request, env) {
    const user = await requireUser(request, env);
    if (!(await isAdminUser(env, user.sub))) throw new HttpError(403, "Acesso restrito à diretoria.");
    requireTicketSecret(env);

    const body = await readJson(request);
    const eventId = String(body.eventId || "");
    if (!EVENT_ID_REGEX.test(eventId)) throw new HttpError(400, "Evento inválido.");
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_COURTESY_PER_REQUEST) {
        throw new HttpError(400, "Quantidade inválida (máximo " + MAX_COURTESY_PER_REQUEST + " por vez).");
    }
    const guestName = sanitizeText(body.guestName || "", 80) || "Cortesia";
    const note = sanitizeText(body.note || "", 200);

    const evSnap = await fsGet(env, eventDocPath(env, eventId));
    if (!evSnap) throw new HttpError(404, "Evento não encontrado.");
    const ev = evSnap.data;
    const endsAtMs = toMs(ev.endsAt) || toMs(ev.startsAt);
    if (!endsAtMs || endsAtMs < Date.now()) throw new HttpError(400, "Este evento já aconteceu.");

    const issuedAt = Math.floor(Date.now() / 1000);
    const nowIso = new Date().toISOString();
    const writes = [];
    const out = [];

    for (let i = 0; i < quantity; i++) {
        const tid = crypto.randomUUID();
        const secret = randomToken(18);
        writes.push(wCreate(env, ticketDocPath(env, tid), {
            id: tid,
            eventId: eventId,
            eventTitle: String(ev.title || ""),
            eventStartsAt: ev.startsAt ? new Date(toMs(ev.startsAt)) : null,
            batchId: "cortesia",
            batchName: "Cortesia",
            orderId: "CORTESIA",
            ownerUid: user.sub,
            ownerName: guestName,
            ownerCpf: "",
            ownerMatricula: "",
            status: "valid",
            qrSignature: await signTicketToken(env, "v1", tid, eventId, user.sub, issuedAt),
            kitSignature: "",
            isCombo: false,
            comboItems: [],
            comboRedeemed: false,
            courtesy: true,
            courtesyNote: note,
            issuedBy: user.sub,
            price: 0,
            issuedAt: issuedAt,
            checkedInAt: null,
            checkedInBy: null,
            transferHistory: [],
            transferCodeHash: await sha256Hex(secret),
            transferDeadlineMs: endsAtMs,
            createdAtISO: nowIso
        }));
        out.push({ ticketId: tid, code: tid + "." + secret });
    }

    if (!(await fsCommit(env, writes))) throw new HttpError(409, "Não foi possível emitir agora. Tente de novo.");
    return { eventId: eventId, tickets: out };
}

// ============================================================================
// EQUIPE DA PORTARIA E SOCIOS (so diretoria)
// A diretoria informa o e-mail da conta (ou o codigo/UID). O Worker acha a
// conta no Firebase Auth e grava o cadastro; remover e listar e pelo painel.
// ============================================================================
async function lookupAccount(env, query) {
    const token = await getGoogleAccessToken(env, SCOPE_IDENTITY);
    const res = await fetch("https://identitytoolkit.googleapis.com/v1/projects/" + env.FIREBASE_PROJECT_ID + "/accounts:lookup", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(query)
    });
    if (!res.ok) throw new Error("Auth lookup " + res.status + ": " + (await res.text()).slice(0, 300));
    const data = await res.json();
    const u = data && Array.isArray(data.users) ? data.users[0] : null;
    return u ? { uid: String(u.localId), email: String(u.email || ""), name: String(u.displayName || "") } : null;
}

async function handleAdminRole(request, env) {
    const user = await requireUser(request, env);
    if (!(await isAdminUser(env, user.sub))) throw new HttpError(403, "Acesso restrito à diretoria.");

    const body = await readJson(request);
    const role = body.role === "member" ? "members" : (body.role === "staff" ? "staff" : "");
    if (!role) throw new HttpError(400, "Tipo de cadastro inválido.");
    const identifier = String(body.identifier || "").trim();
    const isEmail = /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(identifier);
    const isUid = /^[A-Za-z0-9]{20,40}$/.test(identifier);
    if (!isEmail && !isUid) throw new HttpError(400, "Informe o e-mail da conta (ou o código da conta).");

    let account = null;
    try {
        account = await lookupAccount(env, isEmail ? { email: [identifier.toLowerCase()] } : { localId: [identifier] });
    } catch (e) {
        console.error("lookup:", e && e.message ? e.message : e);
        // Sem permissao de consulta no Firebase Auth: com o codigo da conta ainda da para cadastrar
        if (!isUid) throw new HttpError(501, "Não consegui procurar por e-mail. Peça à pessoa o código da conta (aparece na tela da portaria) e cadastre por ele.");
        account = { uid: identifier, email: "", name: "" };
    }
    if (!account) throw new HttpError(404, "Nenhuma conta do site usa esse e-mail. A pessoa precisa se cadastrar primeiro.");

    const data = {
        name: sanitizeText(body.name || account.name || "", 120),
        email: sanitizeText(account.email, 200),
        addedBy: user.sub,
        addedAt: new Date()
    };
    if (role === "members") data.matricula = String(body.matricula || "").replace(/\D/g, "").slice(0, 12);

    const path = "artifacts/" + appIdOf(env) + "/" + role + "/" + account.uid;
    if (!(await fsCommit(env, [wUpdate(env, path, data, {})]))) throw new HttpError(409, "Não foi possível salvar agora. Tente de novo.");
    return { role: body.role, uid: account.uid, email: data.email, name: data.name };
}
