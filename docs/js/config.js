// Gem.AI · configuração pública
// A publishable key do Supabase é feita para ser pública: a proteção vem do RLS.
// A GROQ_API_KEY NÃO aparece aqui — ela é um secret da Edge Function.
export const CONFIG = {
  supabaseUrl: "https://jikizafsbrclkfgoccha.supabase.co",
  supabasePublishableKey: "sb_publishable_Cq2BWkiQP5fLu6z9J-403g_REk8WCPd",
  functionName: "gem-chat",
  defaultModel: "llama-3.3-70b-versatile",
  defaultSystemPrompt:
    "Você é o Gem.AI, um assistente útil, direto e cordial. Responda em português do Brasil, salvo pedido contrário.",
  models: [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B · versátil" },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B · rápido" },
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
    { id: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B" },
    { id: "qwen/qwen3-32b", label: "Qwen3 32B" },
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
  return safeParse(localStorage.getItem(SETTINGS_KEY), DEFAULT_SETTINGS);
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
