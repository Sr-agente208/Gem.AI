// Gem.AI · cliente da Edge Function `gem-chat` (proxy da Groq com SSE)
import { getConfig, getFunctionUrl, getSettings } from "./config.js";

function authHeaders() {
  const cfg = getConfig();
  // A Edge Function tem verify_jwt=false: basta a apikey pública.
  const headers = {
    "Content-Type": "application/json",
    apikey: cfg.supabasePublishableKey,
    "x-gem-owner": localStorage.getItem("gem.owner") || "",
  };
  const token = (getSettings().chatToken || "").trim();
  if (token) headers["x-gem-token"] = token;
  return headers;
}

async function readError(response) {
  let message = `HTTP ${response.status}`;
  let code = "";
  try {
    const parsed = await response.json();
    message = parsed.error || parsed.message || message;
    code = parsed.code || "";
  } catch {
    try {
      message = (await response.text()).slice(0, 300) || message;
    } catch {
      /* sem corpo */
    }
  }
  if (code === "missing_groq_key") {
    message +=
      "\n\nNo painel do Supabase: Project Settings → Edge Functions → Secrets, " +
      "ou rode `supabase secrets set GROQ_API_KEY=gsk_...`.";
  }
  const error = new Error(message);
  error.code = code;
  error.status = response.status;
  return error;
}

export async function fetchModels() {
  const response = await fetch(getFunctionUrl(), { method: "GET", headers: authHeaders() });
  if (!response.ok) throw await readError(response);
  const payload = await response.json();
  const ids = (payload?.data || [])
    .map((item) => item.id)
    .filter((id) => typeof id === "string")
    .sort();
  return [...new Set(ids)];
}

/** Health check real: gera alguns tokens na Groq e confirma que a chave funciona. */
export async function testGeneration(model) {
  const url = new URL(getFunctionUrl());
  url.searchParams.set("test", "1");
  url.searchParams.set("model", model);
  url.searchParams.set("v", String(Date.now())); // evita cache do GET
  const response = await fetch(url.toString(), { method: "GET", headers: authHeaders() });
  if (!response.ok) throw await readError(response);
  const payload = await response.json();
  if (payload?.ok === false) {
    throw new Error(payload.error || "A Groq não conseguiu gerar uma resposta de teste.");
  }
  return payload;
}

/**
 * Faz uma chamada com streaming. `onDelta` recebe cada pedaço de texto.
 * Retorna o texto completo gerado (inclusive quando o usuário cancela no meio).
 */
export async function streamChat({
  messages,
  model,
  systemPrompt,
  temperature,
  maxTokens,
  signal,
  onDelta,
}) {
  const response = await fetch(getFunctionUrl(), {
    method: "POST",
    signal,
    headers: authHeaders(),
    body: JSON.stringify({
      messages,
      model,
      system_prompt: systemPrompt,
      temperature,
      max_completion_tokens: maxTokens,
    }),
  });

  if (!response.ok) throw await readError(response);

  const contentType = response.headers.get("content-type") || "";
  if (!response.body) throw new Error("A Edge Function não retornou corpo de resposta.");

  if (!contentType.includes("event-stream")) {
    const payload = await response.json().catch(() => ({}));
    const text = payload?.choices?.[0]?.message?.content || "";
    if (text) onDelta(text);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let finished = false;

  const consume = (chunk) => {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        finished = true;
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // linha parcial / comentário SSE
      }
      if (parsed?.error) {
        throw new Error(parsed.error.message || "Erro durante o streaming na Groq.");
      }
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    }
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) consume(chunk);
    }
    if (!finished && buffer.trim()) consume(buffer);
  } finally {
    reader.releaseLock();
  }

  return full;
}
