// Gem.AI · tela de login / conta (modal + cartão na sidebar)
//
// Abas: Entrar, Criar conta, Esqueci a senha, Nova senha (retorno de e-mail) e
// Conta (quando autenticado). Botões sociais Google/GitHub via OAuth do GoTrue.
// Tudo escapado antes de ir para o DOM; nenhum token é exibido.

import {
  initAuth,
  getSession,
  getUser,
  displayName,
  initialOf,
  isAuthenticated,
  onAuthChange,
  signIn,
  signUp,
  signOut,
  sendRecovery,
  updatePassword,
  startOAuth,
  linkCurrentOwner,
} from "./auth.js";

const $ = (id) => document.getElementById(id);

let toast = () => {};
let closeSidebar = () => {};
let onSessionChange = () => {};
let el = {};
let currentTab = "login";

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

function message(text, kind = "") {
  if (!el.authMessage) return;
  el.authMessage.hidden = !text;
  el.authMessage.className = `auth-message ${kind}`.trim();
  el.authMessage.textContent = text || "";
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = "Aguarde…";
  } else if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
    delete button.dataset.originalLabel;
  } else if (label) {
    button.textContent = label;
  }
}

/* ----------------------------- abas -------------------------------- */

const FORMS = {
  login: "authLoginForm",
  signup: "authSignupForm",
  recover: "authRecoverForm",
  newpassword: "authNewPasswordForm",
  account: "authAccount",
};

function setTab(name) {
  currentTab = name;
  for (const [key, id] of Object.entries(FORMS)) {
    if (el[id]) el[id].hidden = key !== name;
  }
  for (const button of el.authTabs?.querySelectorAll("[data-auth-tab]") || []) {
    const selected = button.dataset.authTab === name;
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.hidden = name === "account" || name === "newpassword";
  }
  const titles = {
    login: ["Entrar no Gem.AI", "Seu histórico fica vinculado à sua conta em qualquer dispositivo."],
    signup: ["Criar conta", "Nome e e-mail são usados apenas para identificar você e personalizar os e-mails."],
    recover: ["Recuperar senha", "Enviaremos um link de redefinição para o seu e-mail."],
    newpassword: ["Definir nova senha", "Você voltou pelo link de recuperação."],
    account: ["Minha conta", "Sessão ativa neste navegador."],
  };
  const [title, subtitle] = titles[name] || titles.login;
  if (el.authTitle) el.authTitle.textContent = title;
  if (el.authSubtitle) el.authSubtitle.textContent = subtitle;
  if (el.authSocial) el.authSocial.hidden = name === "account" || name === "newpassword";
  message("");
}

function open(tab) {
  if (!el.loginModal) return;
  const target = tab || (isAuthenticated() ? "account" : "login");
  el.loginModal.hidden = false;
  closeSidebar();
  setTab(target);
  renderAccount();
}

function close() {
  if (el.loginModal) el.loginModal.hidden = true;
}

/* --------------------------- cartão/perfil -------------------------- */

function renderAccount() {
  const user = getUser();
  const authed = isAuthenticated();
  if (el.accountAvatar) el.accountAvatar.textContent = authed ? initialOf(user) : "✦";
  if (el.accountName) el.accountName.textContent = authed ? displayName(user) : "Entrar / Criar conta";
  if (el.accountDetail) {
    el.accountDetail.textContent = authed
      ? String(user?.email || "Conta conectada")
      : "Histórico só neste navegador";
  }
  el.accountBtn?.classList.toggle("signed-in", authed);
  if (el.accountBtn) {
    el.accountBtn.setAttribute("aria-label", authed ? `Conta de ${displayName(user)}` : "Entrar ou criar conta");
  }

  if (!el.authAccount) return;
  if (!authed) {
    el.authAccount.innerHTML = "";
    return;
  }
  const provider = user?.app_metadata?.provider || "email";
  const providerLabel = { google: "Google", github: "GitHub", email: "E-mail e senha" }[provider] || provider;
  el.authAccount.innerHTML =
    `<div class="account-profile">` +
      `<span class="account-avatar big">${escapeHtml(initialOf(user))}</span>` +
      `<div><b>${escapeHtml(displayName(user))}</b><small>${escapeHtml(user?.email || "")}</small>` +
      `<small>Método: ${escapeHtml(providerLabel)}</small></div>` +
    `</div>` +
    `<p class="auth-note">Seu histórico, anexos e chamados de suporte aparecem em qualquer ` +
      `navegador onde você entrar com esta conta.</p>` +
    `<div class="auth-actions">` +
      `<button id="authLinkOwner" class="ghost-btn" type="button">Vincular este navegador</button>` +
      `<button id="authSignOut" class="ghost-btn danger" type="button">Sair da conta</button>` +
    `</div>`;
}

/* ---------------------------- formulários --------------------------- */

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value).trim());
}

async function handleLogin(event) {
  event.preventDefault();
  const email = el.authLoginEmail?.value || "";
  const password = el.authLoginPassword?.value || "";
  if (!validEmail(email)) return message("Digite um e-mail válido.", "bad");
  if (!password) return message("Digite sua senha.", "bad");
  setBusy(el.authLoginSubmit, true);
  try {
    await signIn({ email, password });
    setTab("account");
    renderAccount();
    message("Você entrou. Histórico sincronizado.", "ok");
    toast(`Bem-vindo de volta, ${displayName()}!`, "ok");
    onSessionChange();
  } catch (error) {
    message(error?.message || "Não foi possível entrar.", "bad");
  } finally {
    setBusy(el.authLoginSubmit, false, "Entrar");
  }
}

async function handleSignup(event) {
  event.preventDefault();
  const fullName = (el.authSignupName?.value || "").trim();
  const email = (el.authSignupEmail?.value || "").trim();
  const password = el.authSignupPassword?.value || "";
  const password2 = el.authSignupPassword2?.value || "";
  if (fullName.length < 2) return message("Digite seu nome (pelo menos 2 caracteres).", "bad");
  if (!validEmail(email)) return message("Digite um e-mail válido.", "bad");
  if (password.length < 6) return message("A senha precisa de pelo menos 6 caracteres.", "bad");
  if (password !== password2) return message("As senhas não conferem.", "bad");
  setBusy(el.authSignupSubmit, true);
  try {
    const result = await signUp({ fullName, email, password });
    if (result.authenticated) {
      setTab("account");
      renderAccount();
      message("Conta criada! Você já está conectado.", "ok");
      toast(`Conta criada. Bem-vindo, ${displayName()}!`, "ok");
      onSessionChange();
    } else {
      message(
        "Conta criada. Enviamos um e-mail de confirmação — abra o link e depois entre aqui.",
        "ok",
      );
      setTab("login");
      if (el.authLoginEmail) el.authLoginEmail.value = email;
    }
  } catch (error) {
    message(error?.message || "Não foi possível criar a conta.", "bad");
  } finally {
    setBusy(el.authSignupSubmit, false, "Criar conta");
  }
}

async function handleRecover(event) {
  event.preventDefault();
  const email = (el.authRecoverEmail?.value || "").trim();
  if (!validEmail(email)) return message("Digite um e-mail válido.", "bad");
  setBusy(el.authRecoverSubmit, true);
  try {
    await sendRecovery(email);
    message("Link enviado. Verifique sua caixa de entrada (e o spam).", "ok");
  } catch (error) {
    message(error?.message || "Não foi possível enviar o link.", "bad");
  } finally {
    setBusy(el.authRecoverSubmit, false, "Enviar link");
  }
}

async function handleNewPassword(event) {
  event.preventDefault();
  const password = el.authNewPassword?.value || "";
  const password2 = el.authNewPassword2?.value || "";
  if (password.length < 6) return message("A senha precisa de pelo menos 6 caracteres.", "bad");
  if (password !== password2) return message("As senhas não conferem.", "bad");
  setBusy(el.authNewPasswordSubmit, true);
  try {
    await updatePassword(password);
    message("Senha atualizada. Você já pode usar a nova senha.", "ok");
    toast("Senha atualizada.", "ok");
  } catch (error) {
    message(error?.message || "Não foi possível atualizar a senha.", "bad");
  } finally {
    setBusy(el.authNewPasswordSubmit, false, "Salvar nova senha");
  }
}

/* ------------------------------ boot -------------------------------- */

export function initAuthUI(options = {}) {
  toast = typeof options.showToast === "function" ? options.showToast : () => {};
  closeSidebar = typeof options.closeSidebar === "function" ? options.closeSidebar : () => {};
  onSessionChange = typeof options.onSessionChange === "function" ? options.onSessionChange : () => {};

  const ids = [
    "loginModal", "loginClose", "authTitle", "authSubtitle", "authTabs", "authMessage",
    "authSocial", "authLoginForm", "authLoginEmail", "authLoginPassword", "authLoginSubmit",
    "authSignupForm", "authSignupName", "authSignupEmail", "authSignupPassword",
    "authSignupPassword2", "authSignupSubmit", "authRecoverForm", "authRecoverEmail",
    "authRecoverSubmit", "authNewPasswordForm", "authNewPassword", "authNewPassword2",
    "authNewPasswordSubmit", "authAccount", "accountBtn", "accountAvatar", "accountName",
    "accountDetail", "authGoogle", "authGithub",
  ];
  el = Object.fromEntries(ids.map((id) => [id, $(id)]));
  if (!el.loginModal || !el.accountBtn) return;

  renderAccount();
  setTab(isAuthenticated() ? "account" : "login");

  el.accountBtn.addEventListener("click", () => open());
  el.loginClose.addEventListener("click", close);
  el.loginModal.addEventListener("click", (event) => {
    if (event.target === el.loginModal) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.loginModal.hidden) close();
  });

  el.authTabs?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-auth-tab]");
    if (button) setTab(button.dataset.authTab);
  });
  el.authLoginForm.addEventListener("submit", handleLogin);
  el.authSignupForm.addEventListener("submit", handleSignup);
  el.authRecoverForm.addEventListener("submit", handleRecover);
  el.authNewPasswordForm.addEventListener("submit", handleNewPassword);

  for (const button of [el.authGoogle, el.authGithub]) {
    button?.addEventListener("click", () => {
      try {
        const label = button.dataset.provider === "google" ? "Google" : "GitHub";
        message(`Abrindo o login com ${label}… Se o provedor não estiver habilitado, você voltará com um aviso.`, "");
        startOAuth(button.dataset.provider);
      } catch (error) {
        message(error?.message || "Não foi possível iniciar o login social.", "bad");
      }
    });
  }

  // Botões do painel de conta são criados dinamicamente → delegação.
  el.authAccount.addEventListener("click", async (event) => {
    const action = event.target.closest("[id]")?.id;
    if (action === "authSignOut") {
      setBusy(event.target, true);
      try {
        await signOut();
        toast("Você saiu da conta. O modo anônimo continua funcionando.", "ok");
        setTab("login");
        renderAccount();
        onSessionChange();
      } catch (error) {
        message(error?.message || "Não foi possível sair.", "bad");
      } finally {
        setBusy(event.target, false);
      }
    }
    if (action === "authLinkOwner") {
      setBusy(event.target, true);
      try {
        await linkCurrentOwner();
        toast("Navegador vinculado à sua conta.", "ok");
        message("Este navegador agora faz parte da sua conta.", "ok");
        onSessionChange();
      } catch (error) {
        message(error?.message || "Não foi possível vincular.", "bad");
      } finally {
        setBusy(event.target, false);
      }
    }
  });

  onAuthChange(() => {
    renderAccount();
    if (!el.loginModal.hidden) setTab(isAuthenticated() ? "account" : currentTab === "account" ? "login" : currentTab);
  });

  // Restaura sessão / consome retorno OAuth. Erros aparecem no modal, não em toast mudo.
  initAuth()
    .then((result) => {
      renderAccount();
      if (result?.authenticated) {
        toast(`Conectado como ${displayName()}.`, "ok");
        onSessionChange();
      }
      if (result?.error) {
        open("login");
        message(result.error, "bad");
      } else if (result?.type === "recovery") {
        open("newpassword");
        message("Defina sua nova senha abaixo.", "ok");
      }
    })
    .catch(() => { /* app continua 100% utilizável sem login */ });

  return { open, close, renderAccount };
}
