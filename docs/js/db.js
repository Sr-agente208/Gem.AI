// Gem.AI · cliente mínimo do Supabase via PostgREST (sem SDK, sem build step)
import { getConfig, getRestUrl } from "./config.js";

const OWNER_KEY = "gem.owner";

// Identificador anônimo deste navegador. O RLS usa exatamente este valor
// (header x-gem-owner) para que cada pessoa só veja as próprias conversas.
export function getOwnerKey() {
  let key = localStorage.getItem(OWNER_KEY);
  if (!key) {
    key = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `owner-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(OWNER_KEY, key);
  }
  return key;
}

export function resetOwnerKey() {
  localStorage.removeItem(OWNER_KEY);
  return getOwnerKey();
}

function baseHeaders(extra = {}) {
  const cfg = getConfig();
  // Chaves sb_publishable_ vão SOMENTE no header `apikey`.
  // Em `Authorization: Bearer` a plataforma tenta decodificar um JWT e rejeita.
  return {
    apikey: cfg.supabasePublishableKey,
    "Content-Type": "application/json",
    "x-gem-owner": getOwnerKey(),
    ...extra,
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${getRestUrl()}/${path}`, {
    ...options,
    headers: baseHeaders(options.headers || {}),
  });

  if (!response.ok) {
    let message = await response.text().catch(() => "");
    try {
      const parsed = JSON.parse(message);
      message = parsed.message || parsed.hint || parsed.details || message;
    } catch {
      /* texto puro */
    }
    const error = new Error(`Supabase ${response.status}: ${message || "erro desconhecido"}`);
    error.status = response.status;
    throw error;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export function listConversations() {
  return request("gem_conversations?select=*&order=updated_at.desc&limit=100");
}

export function createConversation({ title, model, systemPrompt }) {
  return request("gem_conversations?select=*", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      owner_key: getOwnerKey(),
      title: (title || "Novo chat").slice(0, 200),
      model,
      system_prompt: systemPrompt,
    }),
  }).then((rows) => rows[0]);
}

export function updateConversation(id, patch) {
  return request(`gem_conversations?id=eq.${encodeURIComponent(id)}&select=*`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  }).then((rows) => rows?.[0] ?? null);
}

export function deleteConversation(id) {
  return request(`gem_conversations?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function listMessages(conversationId) {
  return request(
    `gem_messages?conversation_id=eq.${encodeURIComponent(conversationId)}` +
      "&select=id,role,content,created_at&order=created_at.asc&limit=500",
  );
}

export function insertMessages(conversationId, messages) {
  const rows = messages.map((message) => ({
    conversation_id: conversationId,
    role: message.role,
    content: message.content,
  }));
  return request("gem_messages", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
}
