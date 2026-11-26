// Gem.AI · service worker mínimo (sem cache, sem offline).
//
// Por que existe: o Chrome no Android só oferece "Instalar aplicativo" quando há
// um service worker com listener de `fetch`. O app, porém, depende 100% de rede
// (Supabase + Groq) e o GitHub Pages é republicado a cada commit — qualquer
// cache de HTML/JS deixaria o front dessincronizado da Edge Function.
//
// Estratégia: network-only para GET same-origin. Requisições cross-origin
// (Supabase Storage, REST, Groq via Function, pdf.js via CDN) e todos os
// POST/PATCH/DELETE passam direto, sem interceptação.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});
