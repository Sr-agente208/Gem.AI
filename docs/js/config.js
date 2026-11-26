// Gem.AI · configuração pública
// A publishable key do Supabase é feita para ser pública: a proteção vem do RLS.
// A GROQ_API_KEY NÃO aparece aqui — ela é um secret da Edge Function.
export const CONFIG = {
  supabaseUrl: "https://jikizafsbrclkfgoccha.supabase.co",
  supabasePublishableKey: "sb_publishable_Cq2BWkiQP5fLu6z9J-403g_REk8WCPd",
  functionName: "gem-chat",
  // Token compartilhado enviado no header x-gem-token (confere com o secret
  // GEM_CHAT_TOKEN no Supabase). Como este arquivo é público no GitHub Pages,
  // ele é só uma barreira contra uso casual da URL — NÃO é autenticação.
  // Para proteção de verdade: apague este valor, gere OUTRO token só no
  // Supabase e preencha-o em Configurações → Avançado em cada navegador.
  chatToken: "9859b84636b29d449c0d6ba79db668bd71f4587c0fcb0e6f",
  defaultModel: "qwen/qwen3.8-27b",
  defaultSystemPrompt:
    "Você é o Gem.AI, um assistente útil, direto e cordial. Responda em português do Brasil, salvo pedido contrário.",
  // Modelos de chat confirmados nesta conta Groq em 2026-11-24.
  // Precisa bater com ALLOWED_MODELS em supabase/functions/gem-chat/index.ts.
  models: [
    { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B · rápido (padrão)" },
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B · mais capaz" },
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B · leve" },
  ],
  // ---- Arquivos ----
  storageBucket: "gem-uploads",
  visionModel: "qwen/qwen3.8-27b", // único modelo da conta que aceita imagens
  maxFilesPerMessage: 5,
  // Limite por ARQUIVO LÓGICO no app. O plano Free só aceita 50 MiB por OBJETO
  // (medido: 52428800 B -> 200; 53477376 B -> 413), então arquivos maiores são
  // divididos em varias partes no Storage e recompostos no download.
  // ATENÇÃO: o Free tambem tem ~1 GiB de ARMAZENAMENTO TOTAL; um unico arquivo
  // de 1 GiB consome a cota inteira. No Pro (100 GiB) esse limite some.
  maxFileBytes: 1024 * 1024 * 1024,
  storagePartBytes: 48 * 1024 * 1024, // cada objeto no Storage (< 50 MiB do plano)
  maxProcessBytes: 50 * 1024 * 1024, // acima disso nao lemos PDF/imagem na memoria
  resumableThreshold: 6 * 1024 * 1024, // acima disso, upload TUS em chunks
  uploadChunkBytes: 6 * 1024 * 1024, // tamanho de cada chunk do TUS
  maxImagesPerMessage: 3, // limite da Groq para qwen/qwen3.8-27b (fotos + frames)
  maxExtractChars: 20000, // por arquivo de texto/PDF
  imageMaxEdge: 1024, // downscale da foto antes de virar base64
  videoFrameCount: 3, // fotogramas amostrados por vídeo (10% / 50% / 90%)
  videoFrameMaxEdge: 768, // downscale de cada fotograma
  videoTimeoutMs: 12000, // tempo máximo para abrir/seek no vídeo
  textExtensions: [
    "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "xml", "yaml", "yml",
    "html", "htm", "css", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "java",
    "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "sql", "ini", "cfg", "toml", "env",
    "rst", "tex", "svg", "vue", "svelte", "gradle", "properties",
  ],
};

const CONFIG_KEY = "gem.config";
const SETTINGS_KEY = "gem.settings";

export const DEFAULT_SETTINGS = {
  model: CONFIG.defaultModel,
  systemPrompt: CONFIG.defaultSystemPrompt,
  temperature: 0.7,
  maxTokens: 2048,
  chatToken: "",
};

function safeParse(raw, fallback) {
  try {
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

// Permite trocar projeto/URL pela tela de configurações sem editar arquivos.
export function getConfig() {
  const overrides = safeParse(localStorage.getItem(CONFIG_KEY), {});
  return { ...CONFIG, ...overrides };
}

export function saveConfigOverrides(overrides) {
  const clean = {};
  for (const key of ["supabaseUrl", "supabasePublishableKey", "functionName"]) {
    if (typeof overrides[key] === "string" && overrides[key].trim()) {
      clean[key] = overrides[key].trim();
    }
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(clean));
}

export function getSettings() {
  const settings = safeParse(localStorage.getItem(SETTINGS_KEY), DEFAULT_SETTINGS);
  // Se um modelo salvo foi descontinuado na Groq, volta para o padrão atual.
  if (!CONFIG.models.some((item) => item.id === settings.model)) {
    settings.model = CONFIG.defaultModel;
  }
  return settings;
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...getSettings(), ...settings }));
}

export function getRestUrl() {
  return `${getConfig().supabaseUrl.replace(/\/+$/, "")}/rest/v1`;
}

export function getFunctionUrl() {
  const cfg = getConfig();
  return `${cfg.supabaseUrl.replace(/\/+$/, "")}/functions/v1/${cfg.functionName}`;
}

export function getStorageUrl() {
  return `${getConfig().supabaseUrl.replace(/\/+$/, "")}/storage/v1`;
}
