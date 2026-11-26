// Gem.AI · cliente de autenticação do Supabase (GoTrue via REST)
//
// Sem supabase-js, sem CDN, sem build: só fetch + localStorage. Mantém o modo
// anônimo intacto — quando NÃO há sessão, os módulos db/files/support enviam
// apenas `apikey` + `x-gem-owner`, exatamente como antes.
//
// O access_token fica no localStorage (padrão da própria supabase-js). Ele é
// público para scripts desta origem; a proteção real vem do RLS. Nunca logamos
// tokens nem senhas. A GROQ_API_KEY continua sendo secret da Edge Function.

import { getConfig, getAuthUrl, getRestUrl } from "./config.js";

const SESSION_KEY = "gem.auth.session";
const OWNER_KEY = "gem.owner";
const EVENT = "gem:auth-change";

let session = null;
let refreshPromise = null;
let started = false;

/* ----------------------------- sessão ------------------------------ */

function readStored() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function store(next) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* modo privado: sessão só em memória */ }
  emit();
}

function emit() {
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: getSession() }));
  } catch { /* sem window (testes) */ }
}

function normalize(payload, fallbackUser) {
  if (!payload?.access_token) return null;
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || "",
    token_type: payload.token_type || "bearer",
    expires_at:
      Number(payload.expires_at) ||
      Math.floor(Date.now() / 1000) + (Number(payload.expires_in) || 3600),
    user: payload.user || fallbackUser || null,
  };
}

export function getSession() {
  return session;
}
export function getUser() {
  return session?.user || null;
}
export function isAuthenticated() {
  return Boolean(session?.access_token);
}
/** Sincrônico: usado pelos headers de db.js / files.js / support.js. */
export function getAccessToken() {
  return session?.access_token || null;
}
export function onAuthChange(callback) {
  window.addEventListener(EVENT, callback);
  return () => window.removeEventListener(EVENT, callback);
}

export function displayName(user = getUser()) {
  if (!user) return "";
  const meta = user.user_metadata || {};
  return (
    meta.full_name ||
    meta.name ||
    meta.preferred_username ||
    String(user.email || "").split("@")[0] ||
    "Minha conta"
  );
}

export function initialOf(user = getUser()) {
  return (displayName(user).trim()[0] || "✦").toUpperCase();
}

/* ------------------------------ HTTP -------------------------------- */

function apiHeaders(extra = {}) {
  return {
    apikey: getConfig().supabasePublishableKey,
    "Content-Type": "application/json",
    ...extra,
  };
}

function translate(raw) {
  const msg = String(raw || "");
  const rules = [
    [/invalid login credentials/i, "E-mail ou senha incorretos."],
    [/user already registered|already been registered/i, "Este e-mail já tem uma conta. Entre ou recupere a senha."],
    [/password should be at least|password is too short/i, "A senha precisa de pelo menos 6 caracteres."],
    [/email not confirmed|email address not confirmed/i, "Confirme seu e-mail antes de entrar. Veja sua caixa de entrada."],
    [/invalid refresh token|refresh token not found/i, "Sua sessão expirou. Entre de novo."],
    [/unsupported provider|provider is not enabled/i, "Este provedor social ainda não está habilitado no Supabase. Veja LOGIN.md."],
    [/too many requests|rate limit|over_limit/i, "Muitas tentativas. Aguarde alguns minutos e tente de novo."],
    [/weak password/i, "Escolha uma senha mais forte (mínimo 6 caracteres)."],
    [/invalid email|email address is invalid/i, "Digite um e-mail válido."],
  ];
  for (const [pattern, friendly] of rules) if (pattern.test(msg)) return friendly;
  return msg || "Não foi possível completar a operação.";
}

async function readError(response) {
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    try { payload = { msg: await response.text() }; } catch { /* sem corpo */ }
  }
  const raw = [payload.msg, payload.message, payload.error_description, payload.error, payload.hint]
    .filter(Boolean)
    .join(" · ");
  const error = new Error(translate(raw || `HTTP ${response.status}`));
  error.status = response.status;
  return error;
}

async function request(path, { method = "POST", body, token } = {}) {
  const headers = apiHeaders();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${getAuthUrl()}/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response);
  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

/* --------------------------- owner local ---------------------------- */

function ownerKey() {
  let key = null;
  try { key = localStorage.getItem(OWNER_KEY); } catch { /* privado */ }
  if (!key) {
    key = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `owner-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { localStorage.setItem(OWNER_KEY, key); } catch { /* privado */ }
  }
  return key;
}

/**
 * Vincula o owner_key deste navegador à conta autenticada. Assim o histórico
 * aparece em qualquer dispositivo em que a pessoa entrar — sem renomear pastas
 * do Storage (o que quebraria os anexos). RPC `security definer` com RLS.
 */
export async function linkCurrentOwner() {
  const token = getAccessToken();
  if (!token) throw new Error("Entre na sua conta para vincular este navegador.");
  const response = await fetch(`${getRestUrl()}/rpc/gem_link_current_owner`, {
    method: "POST",
    headers: {
      apikey: getConfig().supabasePublishableKey,
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-gem-owner": ownerKey(),
    },
    body: "{}",
  });
  if (!response.ok) throw await readError(response);
  return response.json().catch(() => ({ linked: true }));
}

/* --------------------------- operações ------------------------------ */

export async function signIn({ email, password }) {
  const payload = await request("token?grant_type=password", {
    body: { email: String(email).trim(), password },
  });
  const next = normalize(payload);
  if (!next) throw new Error("O Supabase não devolveu uma sessão. Tente de novo.");
  store(next);
  await linkCurrentOwner().catch(() => {}); // vínculo é best-effort
  return next.user;
}

export async function signUp({ fullName, email, password }) {
  const payload = await request("signup", {
    body: {
      email: String(email).trim(),
      password,
      data: {
        full_name: String(fullName).trim(),
        app: "Gem.AI",
        origin: globalThis.location?.origin || "",
        signed_up_at: new Date().toISOString(),
      },
    },
  });
  const next = normalize(payload, payload?.user);
  if (next) {
    store(next);
    await linkCurrentOwner().catch(() => {});
    return { authenticated: true, user: next.user };
  }
  // Sem sessão no retorno = o projeto está com confirmação de e-mail ligada
  // (mailer_autoconfirm desligado). Hoje está ligado, então este ramo só ocorre
  // se alguém desativar o auto-confirm no painel.
  return { authenticated: false, needsConfirmation: true, user: payload?.user || null };
}

export async function sendRecovery(email) {
  await request("recover", {
    body: {
      email: String(email).trim(),
      // Para onde o link volta; precisa estar no uri_allow_list do projeto.
      redirect_to: `${globalThis.location?.origin || ""}${globalThis.location?.pathname || "/"}`,
    },
  });
  return true;
}

export async function updatePassword(password) {
  const token = getAccessToken();
  if (!token) throw new Error("Sessão de recuperação ausente. Abra o link do e-mail novamente.");
  const user = await request("user", { method: "PUT", body: { password }, token });
  if (session) store({ ...session, user: user || session.user });
  return user;
}

export async function signOut() {
  const token = getAccessToken();
  try {
    if (token) await request("logout", { token });
  } catch { /* logout local mesmo se a rede falhar */ }
  store(null);
}

/** URL de autorização OAuth. O retorno é tratado por consumeRedirect(). */
export function startOAuth(provider) {
  if (!["google", "github"].includes(provider)) throw new Error("Provedor inválido.");
  const redirectTo = `${globalThis.location.origin}${globalThis.location.pathname}`;
  const url = new URL(`${getAuthUrl()}/authorize`);
  url.searchParams.set("provider", provider);
  url.searchParams.set("redirect_to", redirectTo);
  if (provider === "google") url.searchParams.set("scopes", "email profile");
  globalThis.location.href = url.toString();
}

export async function ensureSession() {
  if (!session) {
    session = readStored();
    if (session) emit();
  }
  if (!session) return null;
  const expiresAt = Number(session.expires_at || 0) * 1000;
  if (!session.refresh_token || Date.now() < expiresAt - 60000) return session;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const payload = await request("token?grant_type=refresh_token", {
        body: { refresh_token: session.refresh_token },
      });
      const next = normalize(payload, session.user);
      if (next) {
        store(next);
        return next;
      }
    } catch {
      store(null);
    }
    return session;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

/** Lê `#access_token=...` (fluxo implícito) ou `?error=` do retorno OAuth. */
export function consumeRedirect() {
  const hash = String(globalThis.location?.hash || "").replace(/^#/, "");
  const search = String(globalThis.location?.search || "").replace(/^\?/, "");
  const params = new URLSearchParams(hash || search);
  const result = { error: "", type: params.get("type") || "", authenticated: false };

  if (params.get("error")) {
    result.error = translate(params.get("error_description") || params.get("error"));
  } else if (params.get("access_token")) {
    const next = normalize({
      access_token: params.get("access_token"),
      refresh_token: params.get("refresh_token") || "",
      token_type: params.get("token_type") || "bearer",
      expires_in: Number(params.get("expires_in")) || 3600,
      expires_at: Number(params.get("expires_at")) || undefined,
    });
    if (next) {
      store(next);
      result.authenticated = true;
      linkCurrentOwner().catch(() => {});
    }
  } else if (params.get("code")) {
    result.error =
      "O login social voltou em modo PKCE, que exige a SDK. Use e-mail/senha " +
      "ou configure o fluxo implícito (veja LOGIN.md).";
  }

  if (hash || params.get("error") || params.get("code") || params.get("access_token")) {
    try {
      globalThis.history.replaceState(null, "", globalThis.location.pathname);
    } catch { /* sem history */ }
  }
  return result;
}

/** Boot: restaura sessão, consome redirect OAuth e renova tokens em background. */
export async function initAuth() {
  if (started) return { error: "", type: "", authenticated: isAuthenticated() };
  started = true;
  session = readStored();
  const redirect = consumeRedirect();
  await ensureSession();
  if (!globalThis.__gemAuthTimer) {
    globalThis.__gemAuthTimer = globalThis.setInterval(
      () => ensureSession().catch(() => {}),
      45000,
    );
  }
  emit();
  return { ...redirect, authenticated: isAuthenticated() };
}

/** Usado apenas por testes: limpa o estado sem tocar no localStorage real. */
export function _resetForTest() {
  started = false;
  session = null;
  refreshPromise = null;
  if (globalThis.__gemAuthTimer) {
    globalThis.clearInterval(globalThis.__gemAuthTimer);
    globalThis.__gemAuthTimer = null;
  }
}
