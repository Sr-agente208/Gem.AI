// Gem.AI · Edge Function `gem-chat`
// Proxy com streaming para a Groq. A GROQ_API_KEY fica SOMENTE como secret do Supabase,
// nunca no navegador — essencial porque o front-end roda em GitHub Pages (estático).
//
//   supabase secrets set GROQ_API_KEY=gsk_...
//   supabase functions deploy gem-chat --no-verify-jwt
//
// GET             -> lista compacta de modelos de chat (texto) disponíveis na conta
// GET ?test=1     -> health check: gera uma resposta minúscula e confirma a chave
// POST            -> chat completion com streaming (SSE)
//
// Opcional: defina GEM_CHAT_TOKEN para exigir o header x-gem-token nas chamadas.

const GROQ_URL = "https://api.groq.com/openai/v1";

// Modelos de chat confirmados nesta conta Groq (verificados em 2026-11-24).
// Mantido em sincronia com docs/js/config.js.
const ALLOWED_MODELS = [
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
];
const DEFAULT_MODEL = "qwen/qwen3.8-27b";
const DEFAULT_SYSTEM =
  "Você é o Gem.AI, um assistente útil, direto e cordial. Responda em português do Brasil, salvo pedido contrário.";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-gem-owner, x-gem-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const requiredToken = Deno.env.get("GEM_CHAT_TOKEN");
  if (requiredToken && req.headers.get("x-gem-token") !== requiredToken) {
    return json({ error: "Token de acesso inválido.", code: "invalid_token" }, 401);
  }

  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!groqKey) {
    return json(
      {
        error:
          "GROQ_API_KEY não configurada no Supabase. Rode: supabase secrets set GROQ_API_KEY=gsk_...",
        code: "missing_groq_key",
      },
      503,
    );
  }

  const url = new URL(req.url);

  if (req.method === "GET") {
    // Health check barato — usado pelo botão "Testar conexão".
    if (url.searchParams.get("test") === "1") {
      const model = url.searchParams.get("model") || DEFAULT_MODEL;
      try {
        const upstream = await fetch(`${GROQ_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${groqKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Responda exatamente: OK" }],
            max_completion_tokens: 512,
            temperature: 0,
            stream: false,
          }),
        });
        const payload = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          return json({
            ok: false,
            model,
            error: payload?.error?.message || `A Groq retornou HTTP ${upstream.status}.`,
          });
        }
        return json({
          ok: true,
          model,
          reply: payload?.choices?.[0]?.message?.content || "",
        });
      } catch (error) {
        return json({ ok: false, model, error: String(error) });
      }
    }

    // Lista compacta: só modelos ativos que produzem texto (sem TTS, STT e guard rails).
    try {
      const upstream = await fetch(`${GROQ_URL}/models`, {
        headers: { Authorization: `Bearer ${groqKey}` },
      });
      const payload = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        return json({
          error: payload?.error?.message || `A Groq retornou HTTP ${upstream.status}.`,
        });
      }
      const all = Array.isArray(payload?.data) ? payload.data : [];
      const chat = all.filter(
        (item: Record<string, unknown>) =>
          item?.active !== false &&
          Array.isArray(item.output_modalities) &&
          (item.output_modalities as string[]).includes("text"),
      );
      return json({
        object: "list",
        total: all.length,
        data: chat.map((item: Record<string, unknown>) => ({
          id: item.id,
          object: "model",
          active: true,
        })),
      });
    } catch (error) {
      return json({ error: "Falha ao consultar os modelos da Groq.", detail: String(error) }, 502);
    }
  }

  if (req.method !== "POST") {
    return json({ error: "Método não suportado. Use GET, POST ou OPTIONS." }, 405);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Corpo da requisição não é um JSON válido." }, 400);
  }

  const raw = Array.isArray(payload.messages) ? payload.messages : [];
  if (raw.length === 0 || raw.length > 40) {
    return json({ error: "Envie entre 1 e 40 mensagens." }, 400);
  }

  const messages = raw
    .map((item: Record<string, unknown>) => ({
      role: item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user",
      content: String(item.content ?? "").slice(0, 12000),
    }))
    .filter((item: { content: string }) => item.content.trim().length > 0);

  if (!messages.some((item: { role: string }) => item.role === "user")) {
    return json({ error: "É necessária ao menos uma mensagem do usuário." }, 400);
  }

  const model = ALLOWED_MODELS.includes(String(payload.model))
    ? String(payload.model)
    : DEFAULT_MODEL;
  const systemPrompt =
    typeof payload.system_prompt === "string" && payload.system_prompt.trim()
      ? payload.system_prompt.slice(0, 4000)
      : DEFAULT_SYSTEM;

  const body = {
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    temperature: clamp(Number(payload.temperature ?? 0.7), 0, 2, 0.7),
    max_completion_tokens: clamp(
      Math.round(Number(payload.max_completion_tokens ?? 2048)),
      128,
      8192,
      2048,
    ),
    stream: true,
  };

  try {
    const upstream = await fetch(`${GROQ_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      let message = `A Groq retornou HTTP ${upstream.status}.`;
      try {
        const parsed = JSON.parse(text);
        message = parsed?.error?.message || message;
      } catch {
        /* resposta não-JSON: mantém a mensagem genérica */
      }
      return json(
        { error: message, code: "groq_error", upstream_status: upstream.status },
        upstream.status >= 500 ? 502 : 400,
      );
    }

    // Repassa o SSE da Groq sem buffering, com CORS para o GitHub Pages.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return json({ error: "Falha ao contatar a Groq.", detail: String(error) }, 502);
  }
});
