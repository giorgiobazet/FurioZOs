// Service worker da Portaria (escopo /portaria): guarda a "casca" do app para
// abrir sem internet. NAO intercepta Firestore, login nem o Worker de pagamento:
// os dados dos ingressos ficam no IndexedDB, controlados por portaria.js.
const CACHE = "fz-portaria-v1";
const NETWORK_WAIT_MS = 3000;

const SHELL = [
    "/portaria",
    "/portaria.webmanifest",
    "/assets/css/style.css",
    "/assets/js/tailwind-config.js",
    "/assets/js/fz-config.js",
    "/assets/js/portaria.js",
    "/assets/img/logo-atletica.jpg"
];

const CDN_HOSTS = [
    "cdn.tailwindcss.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "cdnjs.cloudflare.com",
    "cdn.jsdelivr.net"
];

function cacheable(url) {
    if (url.origin === self.location.origin) {
        return url.pathname === "/portaria" || url.pathname === "/portaria.html" ||
            url.pathname === "/portaria.webmanifest" || url.pathname.indexOf("/assets/") === 0;
    }
    if (url.hostname === "www.gstatic.com") return url.pathname.indexOf("/firebasejs/") === 0;
    return CDN_HOSTS.indexOf(url.hostname) !== -1;
}

// A pagina e guardada sempre na mesma chave, venha de /portaria ou /portaria.html
function pageKey(url) {
    const isPage = url.origin === self.location.origin && (url.pathname === "/portaria" || url.pathname === "/portaria.html");
    return isPage ? new URL("/portaria", self.location.origin).href : "";
}

// Baixa e guarda. Tenta com CORS (serve para qualquer tipo de pedido) e, se o
// servidor nao permitir, guarda a resposta opaca.
async function store(cache, href) {
    const url = new URL(href, self.location.origin);
    if (!cacheable(url)) return false;
    try {
        let res;
        if (url.origin === self.location.origin) {
            res = await fetch(url.href, { cache: "no-cache" });
        } else {
            try {
                res = await fetch(url.href, { mode: "cors", credentials: "omit" });
            } catch (e) {
                res = await fetch(url.href, { mode: "no-cors" });
            }
        }
        if (res && (res.ok || res.type === "opaque")) {
            await cache.put(pageKey(url) || url.href, res);
            return true;
        }
    } catch (e) { /* sem rede: fica para a proxima */ }
    return false;
}

self.addEventListener("install", function (event) {
    event.waitUntil((async function () {
        const cache = await caches.open(CACHE);
        await Promise.all(SHELL.map(function (u) { return store(cache, u); }));
        await self.skipWaiting();
    })());
});

self.addEventListener("activate", function (event) {
    event.waitUntil((async function () {
        const names = await caches.keys();
        await Promise.all(names.filter(function (n) { return n.indexOf("fz-portaria-") === 0 && n !== CACHE; })
            .map(function (n) { return caches.delete(n); }));
        await self.clients.claim();
    })());
});

// A pagina manda a lista de tudo que carregou (fontes, SDK do Firebase, etc.)
self.addEventListener("message", function (event) {
    const data = event.data || {};
    if (data.type !== "precache" || !Array.isArray(data.urls)) return;
    event.waitUntil((async function () {
        const cache = await caches.open(CACHE);
        let ok = 0;
        for (const u of data.urls.slice(0, 80)) {
            const full = new URL(u, self.location.origin);
            const hit = await cache.match(pageKey(full) || full.href);
            if (hit || (await store(cache, u))) ok++;
        }
        if (event.source) event.source.postMessage({ type: "precache-done", count: ok });
    })());
});

// Arquivos do proprio site: rede primeiro (uma correcao publicada chega na
// primeira abertura), com a copia guardada se a rede nao responder em 3 s.
// Bibliotecas de CDN (versao fixa): copia guardada na hora, atualiza depois.
self.addEventListener("fetch", function (event) {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (!cacheable(url)) return;

    const isPage = req.mode === "navigate";
    const key = isPage ? new URL("/portaria", self.location.origin).href : url.href;

    event.respondWith((async function () {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(key);
        const refresh = fetch(isPage ? new Request(req.url, { cache: "no-cache" }) : req).then(function (res) {
            if (res && (res.ok || res.type === "opaque")) cache.put(key, res.clone());
            return res;
        }).catch(function () { return null; });

        if (cached && url.origin === self.location.origin) {
            const fresh = await Promise.race([refresh, new Promise(function (r) { setTimeout(r, NETWORK_WAIT_MS, null); })]);
            if (fresh && fresh.ok) return fresh;
            event.waitUntil(refresh);
            return cached;
        }
        if (cached) {
            event.waitUntil(refresh);
            return cached;
        }
        const fresh = await refresh;
        if (fresh) return fresh;
        return new Response("Sem conexão e sem cópia local deste arquivo.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    })());
});
