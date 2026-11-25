// Gem.AI · Edge Function `gem-chat`
// Proxy com streaming para a Groq. A GROQ_API_KEY fica SOMENTE como secret do Supabase,
// nunca no navegador — essencial porque o front-end roda em GitHub Pages (estático).
//
//   supabase secrets set GROQ_API_KEY=gsk_...
//   supabase functions deploy gem-chat --no-verify-jwt
//
// GET                    -> lista compacta de modelos de chat (texto) da conta
// GET ?test=1            -> health check de texto
// GET ?test=1&vision=1   -> health check multimodal (imagem 32x32 em base64)
// GET ?test=1&storage=1  -> health check do bucket/RLS: upload, sign, list e delete
// GET ?test=1&sse=1      -> health check do POST SSE (com e sem x-gem-token)
// GET ?test=1&cors=1     -> health check do preflight CORS (REST + Storage)
// POST                   -> chat completion com streaming (SSE), texto e/ou imagens
//
// Opcional: GEM_CHAT_TOKEN exige o header x-gem-token no POST.

const GROQ_URL = "https://api.groq.com/openai/v1";

// Modelos de chat confirmados nesta conta Groq (verificados em 2026-11-24).
// Mantido em sincronia com docs/js/config.js.
const ALLOWED_MODELS = [
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
];
const DEFAULT_MODEL = "qwen/qwen3.8-27b";
const VISION_MODEL = "qwen/qwen3.8-27b"; // único modelo com input_modalities incluindo imagem
const DEFAULT_SYSTEM =
  "Você é o Gem.AI, um assistente útil, direto e cordial. Responda em português do Brasil, salvo pedido contrário.";

// Limites da Groq para visão: 3 imagens por requisição, base64 até 4 MB, mínimo 32x32 px.
const MAX_IMAGES = 3;
const MAX_IMAGE_CHARS = 4_000_000;
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAM0lEQVR42mPQqPhAEvpPImAYtWDUglELRi0YtWBIWECqBlIdNGrBqAWjFoxaMGrBkLAAAFfhGohyUJu0AAAAAElFTkSuQmCC";

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
type Content = string | Array<TextPart | ImagePart>;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-gem-owner, x-gem-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-gem-model",
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

/** Aceita content como string ou array de partes OpenAI (texto + image_url em base64). */
function normalizeContent(value: unknown, budget: { images: number }): Content {
  if (typeof value === "string") return value.slice(0, 60000);
  if (!Array.isArray(value)) return String(value ?? "").slice(0, 60000);

  const parts: Array<TextPart | ImagePart> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const part = item as Record<string, unknown>;

    if (part.type === "text") {
      const text = String(part.text ?? "").slice(0, 60000);
      if (text.trim()) parts.push({ type: "text", text });
    } else if (part.type === "image_url") {
      if (budget.images >= MAX_IMAGES) continue;
      const holder = part.image_url as Record<string, unknown> | null;
      const url = String(holder?.url ?? "");
      // Só data URIs locais: evita SSRF e impede que o cliente aponte para URLs arbitrárias.
      if (!url.startsWith("data:image/") || !url.includes(";base64,")) continue;
      if (url.length > MAX_IMAGE_CHARS) continue;
      budget.images += 1;
      parts.push({ type: "image_url", image_url: { url } });
    }
  }

  if (!parts.length) return "";
  if (parts.every((part) => part.type === "text")) {
    return (parts as TextPart[]).map((part) => part.text).join("\n\n").slice(0, 60000);
  }
  if (!parts.some((part) => part.type === "text")) {
    parts.unshift({ type: "text", text: "Analise o(s) arquivo(s) enviado(s)." });
  }
  return parts;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
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
  const base = Deno.env.get("SUPABASE_URL") || "";
  const publicKey =
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    Deno.env.get("SUPABASE_ANON_KEY") ||
    "";

  if (req.method === "GET") {
    // Diagnóstico do Storage: reproduz o upload que o navegador faz
    // (apikey + x-gem-owner, sem service_role) e testa sign/list/delete.
    if (url.searchParams.get("storage") === "1") {
      const owner =
        url.searchParams.get("owner") || req.headers.get("x-gem-owner") || "diagnostico";
      const objectPath = `${owner}/_diagnostico/${crypto.randomUUID()}.txt`;
      const headers = { apikey: publicKey, "x-gem-owner": owner };
      const result: Record<string, unknown> = { bucket: "gem-uploads", owner };
      try {
        const upload = await fetch(
          `${base}/storage/v1/object/gem-uploads/${objectPath}`,
          {
            method: "POST",
            headers: { ...headers, "Content-Type": "text/plain" },
            body: "gem-ai storage check",
          },
        );
        result.upload = upload.status;
        result.upload_detail = (await upload.text()).slice(0, 200);
        result.ok = upload.ok;

        if (upload.ok) {
          const sign = await fetch(
            `${base}/storage/v1/object/sign/gem-uploads/${objectPath}`,
            {
              method: "POST",
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({ expiresIn: 3600 }),
            },
          );
          const signBody = await sign.json().catch(() => ({}));
          result.sign = sign.status;
          result.sign_has_url = Boolean(signBody?.signedURL || signBody?.signedUrl);
          result.sign_sample = String(signBody?.signedURL || signBody?.signedUrl || "").slice(0, 90);

          const list = await fetch(
            `${base}/storage/v1/object/list/gem-uploads`,
            {
              method: "POST",
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({ prefix: `${owner}/_diagnostico`, limit: 10, offset: 0 }),
            },
          );
          const listBody = await list.json().catch(() => ([]));
          result.list = list.status;
          result.list_count = Array.isArray(listBody) ? listBody.length : -1;

          const remove = await fetch(
            `${base}/storage/v1/object/gem-uploads/${objectPath}`,
            { method: "DELETE", headers },
          );
          result.delete = remove.status;
        }
      } catch (error) {
        result.error = String(error);
        result.ok = false;
      }
      return json(result);
    }

    // Diagnóstico do POST SSE: chama a própria função com e sem o token.
    if (url.searchParams.get("sse") === "1") {
      const token = Deno.env.get("GEM_CHAT_TOKEN") || "";
      const self = `${base}/functions/v1/gem-chat`;
      const withVision = url.searchParams.get("vision") === "1";
      const content: Content = withVision
        ? [
            { type: "text", text: "Responda exatamente: OK" },
            { type: "image_url", image_url: { url: TINY_PNG } },
          ]
        : "Responda exatamente: OK";
      const body = JSON.stringify({
        // Pede um modelo sem visão: o proxy deve trocar automaticamente para VISION_MODEL.
        model: withVision ? "openai/gpt-oss-20b" : DEFAULT_MODEL,
        messages: [{ role: "user", content }],
        max_completion_tokens: 16,
        temperature: 0,
      });
      try {
        const denied = await fetch(self, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const deniedBody = await denied.json().catch(() => ({}));
        const allowed = await fetch(self, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-gem-token": token },
          body,
        });
        const raw = await allowed.text();
        return json({
          no_token_status: denied.status,
          no_token_code: deniedBody?.code || null,
          with_token_status: allowed.status,
          content_type: allowed.headers.get("content-type"),
          model_header: allowed.headers.get("x-gem-model"),
          has_data: raw.includes("data:"),
          has_done: raw.includes("[DONE]"),
          vision: withVision,
          sample: raw.slice(0, 220),
        });
      } catch (error) {
        return json({ ok: false, error: String(error) });
      }
    }

    // Diagnóstico de CORS: reprodutor do preflight que o navegador faz.
    if (url.searchParams.get("cors") === "1") {
      const origin = "https://sr-agente208.github.io";
      const preflight: Record<string, unknown> = {};
      for (const [label, path] of [
        ["rest", "/rest/v1/gem_messages"],
        ["storage", "/storage/v1/object/gem-uploads/teste/teste.txt"],
      ] as Array<[string, string]>) {
        try {
          const res = await fetch(`${base}${path}`, {
            method: "OPTIONS",
            headers: {
              Origin: origin,
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers":
                "apikey,content-type,x-gem-owner,x-upsert",
            },
          });
          preflight[label] = {
            status: res.status,
            allow_origin: res.headers.get("access-control-allow-origin"),
            allow_headers: res.headers.get("access-control-allow-headers"),
          };
        } catch (error) {
          preflight[label] = { error: String(error) };
        }
      }
      return json(preflight);
    }

    if (url.searchParams.get("test") === "1") {
      const withVision = url.searchParams.get("vision") === "1";
      const model = withVision
        ? VISION_MODEL
        : url.searchParams.get("model") || DEFAULT_MODEL;
      const content: Content = withVision
        ? [
            { type: "text", text: "Responda exatamente: OK" },
            { type: "image_url", image_url: { url: TINY_PNG } },
          ]
        : "Responda exatamente: OK";
      try {
        const upstream = await fetch(`${GROQ_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${groqKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content }],
            max_completion_tokens: 64,
            temperature: 0,
            stream: false,
          }),
        });
        const payload = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          return json({
            ok: false,
            model,
            vision: withVision,
            error: payload?.error?.message || `A Groq retornou HTTP ${upstream.status}.`,
          });
        }
        return json({
          ok: true,
          model,
          vision: withVision,
          reply: payload?.choices?.[0]?.message?.content || "",
        });
      } catch (error) {
        return json({ ok: false, model, vision: withVision, error: String(error) });
      }
    }

    // Lista compacta: só modelos ativos que produzem texto.
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
        vision_models: chat
          .filter(
            (item: Record<string, unknown>) =>
              Array.isArray(item.input_modalities) &&
              (item.input_modalities as string[]).includes("image"),
          )
          .map((item: Record<string, unknown>) => item.id),
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

  // Só o POST consome cota de verdade; GETs de diagnóstico ficam públicos.
  const requiredToken = Deno.env.get("GEM_CHAT_TOKEN");
  if (requiredToken && req.headers.get("x-gem-token") !== requiredToken) {
    return json({ error: "Token de acesso inválido.", code: "invalid_token" }, 401);
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

  const budget = { images: 0 };
  const messages = raw
    .map((item: Record<string, unknown>) => ({
      role:
        item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user",
      content: normalizeContent(item.content, budget),
    }))
    .filter(
      (item: { content: Content }) =>
        typeof item.content === "string"
          ? item.content.trim().length > 0
          : item.content.length > 0,
    );

  if (!messages.some((item: { role: string }) => item.role === "user")) {
    return json({ error: "É necessária ao menos uma mensagem do usuário." }, 400);
  }

  const requested = ALLOWED_MODELS.includes(String(payload.model))
    ? String(payload.model)
    : DEFAULT_MODEL;
  // Se chegou imagem e o modelo escolhido não enxerga, troca automaticamente.
  const model = budget.images > 0 && requested !== VISION_MODEL ? VISION_MODEL : requested;
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
        "X-Gem-Model": model,
      },
    });
  } catch (error) {
    return json({ error: "Falha ao contatar a Groq.", detail: String(error) }, 502);
  }
});
