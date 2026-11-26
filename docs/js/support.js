// Gem.AI · cliente do sistema de suporte (PostgREST, sem SDK)
//
// Backend: tabelas gem_support_faq / gem_support_tickets / gem_support_messages
// com RLS por x-gem-owner. Escritas passam por RPCs security definer; o canal
// alternativo é uma issue pré-preenchida no GitHub (sem token no navegador).
// Nenhuma chave, token ou conteúdo de conversa entra no diagnóstico.

import { getConfig, getRestUrl } from "./config.js";
import { getOwnerKey } from "./db.js";

export const APP_VERSION = "2026.11.26";
export const SUPPORT_REPO = "https://github.com/Sr-agente208/Gem.AI";

const OUTBOX_KEY = "gem.support.outbox";
const ERRORS_KEY = "gem.support.errors";

const CATEGORY_LABELS = {
  bug: "Problema / bug",
  duvida: "Dúvida",
  sugestao: "Sugestão",
  anexo: "Anexo / arquivo",
  outro: "Outro",
};
export const STATUS_LABELS = {
  aberto: "Aberto",
  em_analise: "Em análise",
  respondido: "Respondido",
  fechado: "Fechado",
};
export const categoryLabel = (key) => CATEGORY_LABELS[key] || "Outro";

function headers(extra = {}) {
  const cfg = getConfig();
  return {
    apikey: cfg.supabasePublishableKey,
    "Content-Type": "application/json",
    "x-gem-owner": getOwnerKey(),
    ...extra,
  };
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${getRestUrl()}/${path}`, {
      ...options,
      headers: headers(options.headers || {}),
    });
  } catch (error) {
    const wrapped = new Error(`Sem conexão com o Supabase: ${error?.message || error}`);
    wrapped.status = 0;
    throw wrapped;
  }
  if (!response.ok) {
    let message = await response.text().catch(() => "");
    try {
      const parsed = JSON.parse(message);
      message = parsed.message || parsed.hint || parsed.details || message;
    } catch { /* texto puro */ }
    const error = new Error(`Supabase ${response.status}: ${message || "erro desconhecido"}`);
    error.status = response.status;
    throw error;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function rpc(name, args) {
  return request(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

/* ------------------------------ Leituras ------------------------------ */

export function listFaq() {
  return request(
    "gem_support_faq?select=id,category,question,answer" +
      "&published=eq.true&order=sort_order.asc&limit=50",
  );
}

export function listTickets() {
  return request(
    "gem_support_tickets?select=id,category,subject,status,source,context,created_at,updated_at" +
      "&order=updated_at.desc&limit=30",
  );
}

export function listThreads(ticketIds) {
  const ids = (ticketIds || []).map(encodeURIComponent).join(",");
  if (!ids) return Promise.resolve([]);
  return request(
    "gem_support_messages?select=id,ticket_id,author,body,created_at" +
      `&ticket_id=in.(${ids})&order=created_at.asc&limit=300`,
  );
}

/* ------------------------------ Escritas ------------------------------ */

export function createTicket({ category, subject, message, contact, context }) {
  return rpc("gem_create_support_ticket", {
    p_category: category || "duvida",
    p_subject: subject,
    p_body: message,
    p_contact: contact || null,
    p_context: context || {},
  });
}

export function replyTicket(ticketId, body) {
  return rpc("gem_reply_support_ticket", { p_ticket_id: ticketId, p_body: body });
}

export function closeTicket(ticketId) {
  return rpc("gem_close_support_ticket", { p_ticket_id: ticketId });
}

/* --------------------------- Fila offline ----------------------------- */

export function readOutbox() {
  try {
    const list = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeOutbox(list) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(list.slice(-10)));
  } catch { /* storage cheio/bloqueado: segue sem fila */ }
}

export function enqueueTicket(payload) {
  const item = {
    id: globalThis.crypto?.randomUUID?.() || `draft-${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...payload,
  };
  writeOutbox([...readOutbox(), item]);
  return item;
}

export function discardDraft(id) {
  writeOutbox(readOutbox().filter((item) => item.id !== id));
}

/** Tenta reenviar rascunhos. Erros 4xx (validação) são descartados com aviso. */
export async function flushOutbox() {
  const list = readOutbox();
  const result = { sent: 0, pending: 0, errors: [] };
  for (const item of list) {
    try {
      await createTicket(item);
      discardDraft(item.id);
      result.sent += 1;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        discardDraft(item.id);
        result.errors.push(error.message);
      }
      // 0 (offline) e 5xx: mantém para a próxima tentativa.
    }
  }
  result.pending = readOutbox().length;
  return result;
}

/* --------------------------- Diagnóstico ------------------------------ */

export function getRecentErrors() {
  try {
    const list = JSON.parse(localStorage.getItem(ERRORS_KEY) || "[]");
    return Array.isArray(list) ? list.slice(-5) : [];
  } catch {
    return [];
  }
}

export function recordError(message) {
  const clean = String(message || "").slice(0, 300);
  if (!clean) return;
  try {
    const list = [...getRecentErrors(), { at: new Date().toISOString(), message: clean }].slice(-5);
    localStorage.setItem(ERRORS_KEY, JSON.stringify(list));
  } catch { /* ignora */ }
}

/** Captura erros de runtime para o usuário poder anexar ao chamado. */
export function captureRuntimeErrors() {
  if (typeof window === "undefined" || window.__gemSupportErrorsHooked) return;
  window.__gemSupportErrorsHooked = true;
  window.addEventListener("error", (event) => {
    recordError(event?.message || event?.error?.message || "erro de script");
  });
  window.addEventListener("unhandledrejection", (event) => {
    recordError(String(event?.reason?.message || event?.reason || "promessa rejeitada"));
  });
}

function canPlay(codec) {
  try {
    const video = document.createElement?.("video");
    return !!(video?.canPlayType && video.canPlayType(codec));
  } catch {
    return false;
  }
}

/**
 * Metadados técnicos SEM dados sensíveis: sem tokens, sem chaves, sem
 * owner_key, sem títulos ou conteúdo das conversas.
 */
export function diagnostics() {
  const nav = globalThis.navigator || {};
  const scr = globalThis.screen || {};
  let storage = false;
  try {
    localStorage.setItem("__gem_probe__", "1");
    localStorage.removeItem("__gem_probe__");
    storage = true;
  } catch { /* modo privado */ }
  return {
    app: "Gem.AI",
    versao: APP_VERSION,
    pagina: `${globalThis.location?.origin || ""}${globalThis.location?.pathname || ""}`,
    userAgent: String(nav.userAgent || "").slice(0, 240),
    plataforma: String(nav.platform || "").slice(0, 60),
    idioma: nav.language || "",
    online: nav.onLine !== false,
    pwa: !!(nav.standalone || globalThis.matchMedia?.("(display-mode: standalone)").matches),
    tela: `${scr.width || 0}x${scr.height || 0}`,
    viewport: `${globalThis.innerWidth || 0}x${globalThis.innerHeight || 0}`,
    toque: nav.maxTouchPoints || 0,
    fuso: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; } })(),
    decompressionStream: typeof globalThis.DecompressionStream !== "undefined",
    videoMp4H264: canPlay('video/mp4; codecs="avc1.42E01E"'),
    videoWebm: canPlay('video/webm; codecs="vp8"'),
    webShare: typeof nav.share === "function",
    serviceWorker: "serviceWorker" in nav,
    localStorage: storage,
    errosRecentes: getRecentErrors(),
  };
}

export function formatDiagnostics(diag) {
  const lines = [
    `Gem.AI ${diag.versao} · ${diag.pagina}`,
    `Navegador: ${diag.userAgent}`,
    `Plataforma: ${diag.plataforma} · idioma ${diag.idioma} · fuso ${diag.fuso}`,
    `Tela ${diag.tela} · viewport ${diag.viewport} · toque ${diag.toque}`,
    `Online: ${diag.online} · PWA: ${diag.pwa} · localStorage: ${diag.localStorage}`,
    `DecompressionStream: ${diag.decompressionStream} · MP4/H264: ${diag.videoMp4H264} · WebM: ${diag.videoWebm}`,
    `Web Share: ${diag.webShare} · Service Worker: ${diag.serviceWorker}`,
  ];
  if (diag.errosRecentes?.length) {
    lines.push("Erros recentes:");
    for (const e of diag.errosRecentes) lines.push(`  - ${e.at}: ${e.message}`);
  }
  return lines.join("\n");
}

/* --------------------- Canal alternativo: GitHub ---------------------- */

/**
 * Link de issue pré-preenchida. Usar o Git como canal de suporte NÃO exige
 * token de escrita no navegador — o usuário confirma a abertura no GitHub.
 */
export function gitIssueUrl({ subject, message, protocol, diag, includeDiagnostics = true }) {
  const body = [
    `**Protocolo:** ${protocol || "(aberto pelo app)"}`,
    "",
    "### Relato",
    message || "(descreva o problema no app)",
    "",
    "### Diagnóstico técnico",
    includeDiagnostics && diag
      ? `\`\`\`\n${formatDiagnostics(diag)}\n\`\`\``
      : "_Não incluído pelo usuário._",
    "",
    "Enviado pela central de ajuda do Gem.AI. Não cole chaves, tokens ou dados pessoais.",
  ].join("\n");
  const params = new URLSearchParams();
  params.set("title", `[Suporte] ${(subject || "Relato do app").slice(0, 120)}`);
  params.set("body", body);
  params.set("labels", "suporte");
  return `${SUPPORT_REPO}/issues/new?${params.toString()}`;
}

export function protocolOf(id) {
  return String(id || "").replace(/-/g, "").slice(0, 8).toUpperCase();
}
