// Gem.AI · lógica da interface
import {
  CONFIG,
  getConfig,
  getSettings,
  saveSettings,
  saveConfigOverrides,
} from "./config.js";
import * as db from "./db.js";
import { fetchModels, streamChat, testGeneration } from "./groq.js";
import { renderMarkdown, escapeHtml } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const ui = {
  sidebar: $("sidebar"),
  sidebarOverlay: $("sidebarOverlay"),
  sidebarToggle: $("sidebarToggle"),
  sidebarClose: $("sidebarClose"),
  newChatBtn: $("newChatBtn"),
  conversationList: $("conversationList"),
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  settingsBtn: $("settingsBtn"),
  chatTitle: $("chatTitle"),
  chatSubtitle: $("chatSubtitle"),
  modelPill: $("modelPill"),
  clearChatBtn: $("clearChatBtn"),
  messagesWrap: $("messagesWrap"),
  messages: $("messages"),
  emptyState: $("emptyState"),
  composerForm: $("composerForm"),
  promptInput: $("promptInput"),
  sendBtn: $("sendBtn"),
  stopBtn: $("stopBtn"),
  toast: $("toast"),
  modal: $("settingsModal"),
  settingsClose: $("settingsClose"),
  modelSelect: $("modelSelect"),
  refreshModelsBtn: $("refreshModelsBtn"),
  systemPromptInput: $("systemPromptInput"),
  temperatureInput: $("temperatureInput"),
  temperatureValue: $("temperatureValue"),
  maxTokensInput: $("maxTokensInput"),
  supabaseUrlInput: $("supabaseUrlInput"),
  publishableKeyInput: $("publishableKeyInput"),
  functionNameInput: $("functionNameInput"),
  chatTokenInput: $("chatTokenInput"),
  resetOwnerBtn: $("resetOwnerBtn"),
  connectionResult: $("connectionResult"),
  testConnectionBtn: $("testConnectionBtn"),
  saveSettingsBtn: $("saveSettingsBtn"),
};

const state = {
  conversations: [],
  activeId: null,
  messages: [],
  sending: false,
  controller: null,
  settings: getSettings(),
};

/* ------------------------------ utilidades ------------------------------ */

function showToast(message, type = "") {
  const item = document.createElement("div");
  item.className = `toast-item ${type}`;
  item.textContent = message;
  ui.toast.appendChild(item);
  setTimeout(() => item.remove(), 6000);
}

function setStatus(kind, text) {
  ui.statusDot.className = `status-dot ${kind}`;
  ui.statusText.textContent = text;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function makeTitle(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "Novo chat";
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

function scrollToBottom(force = false) {
  const wrap = ui.messagesWrap;
  const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 160;
  if (force || nearBottom) {
    requestAnimationFrame(() => {
      wrap.scrollTop = wrap.scrollHeight;
    });
  }
}

function autosize() {
  ui.promptInput.style.height = "auto";
  ui.promptInput.style.height = `${Math.min(ui.promptInput.scrollHeight, 170)}px`;
}

function toggleSending(sending) {
  state.sending = sending;
  ui.sendBtn.hidden = sending;
  ui.stopBtn.hidden = !sending;
  ui.sendBtn.disabled = sending;
}

/* ------------------------------ renderização ------------------------------ */

function renderSidebar() {
  ui.conversationList.innerHTML = "";
  if (!state.conversations.length) {
    const note = document.createElement("p");
    note.className = "empty-list";
    note.textContent = "Nenhuma conversa ainda. Envie uma mensagem para começar.";
    ui.conversationList.appendChild(note);
    return;
  }

  for (const conversation of state.conversations) {
    const item = document.createElement("div");
    item.className = `conv-item${conversation.id === state.activeId ? " active" : ""}`;
    item.dataset.id = conversation.id;
    item.setAttribute("role", "listitem");
    item.innerHTML =
      '<span class="conv-icon" aria-hidden="true">💬</span>' +
      '<span class="conv-text">' +
      `<span class="conv-title">${escapeHtml(conversation.title || "Novo chat")}</span>` +
      `<span class="conv-date">${formatDate(conversation.updated_at)}</span>` +
      "</span>" +
      '<button class="conv-delete" type="button" title="Apagar conversa" aria-label="Apagar conversa">🗑</button>';
    ui.conversationList.appendChild(item);
  }
}

function addUserBubble(text) {
  const message = document.createElement("div");
  message.className = "message user";
  message.innerHTML =
    `<div class="bubble">${escapeHtml(text)}</div>` +
    '<div class="avatar" aria-hidden="true">☺</div>';
  ui.messages.appendChild(message);
  scrollToBottom(true);
}

function addAssistantBubble() {
  const message = document.createElement("div");
  message.className = "message assistant";
  message.innerHTML =
    '<div class="avatar" aria-hidden="true">✦</div>' +
    '<div class="bubble"><div class="body"></div></div>';
  ui.messages.appendChild(message);
  const body = message.querySelector(".body");
  const bubble = message.querySelector(".bubble");
  body.innerHTML = '<span class="thinking"><i></i><i></i><i></i> pensando…</span>';
  scrollToBottom(true);
  return { message, bubble, body };
}

function setAssistantContent(target, raw, streaming) {
  const html = raw.trim() ? renderMarkdown(raw) : "";
  target.body.innerHTML = streaming
    ? `${html || '<span class="thinking"><i></i><i></i><i></i> pensando…</span>'}<span class="caret"></span>`
    : html || "<em>(sem resposta)</em>";
  scrollToBottom();
}

function setBubbleError(target, message) {
  if (!target) {
    const extra = addAssistantBubble();
    extra.bubble.classList.add("error");
    extra.body.textContent = message;
    return;
  }
  target.bubble.classList.add("error");
  target.body.textContent = message;
  scrollToBottom();
}

function renderStoredMessages() {
  ui.messages.innerHTML = "";
  for (const message of state.messages) {
    if (message.role === "user") {
      addUserBubble(message.content);
    } else {
      const target = addAssistantBubble();
      setAssistantContent(target, message.content, false);
    }
  }
  ui.emptyState.hidden = state.messages.length > 0;
  scrollToBottom(true);
}

function showEmptyView() {
  state.activeId = null;
  state.messages = [];
  ui.messages.innerHTML = "";
  ui.emptyState.hidden = false;
  ui.chatTitle.textContent = "Novo chat";
  ui.chatSubtitle.textContent = "Comece uma conversa";
  ui.modelPill.textContent = state.settings.model;
  renderSidebar();
}

function updateHeader(conversation) {
  if (!conversation) return;
  ui.chatTitle.textContent = conversation.title || "Novo chat";
  ui.chatSubtitle.textContent = `Salvo no Supabase · ${formatDate(conversation.created_at)}`;
  ui.modelPill.textContent = conversation.model || state.settings.model;
}

/* ------------------------------ dados ------------------------------ */

async function loadConversations() {
  const rows = await db.listConversations();
  state.conversations = Array.isArray(rows) ? rows : [];
  renderSidebar();
  setStatus("ok", "Supabase conectado");
}

async function refreshConversations() {
  try {
    await loadConversations();
  } catch {
    /* falha silenciosa: a conversa já está renderizada */
  }
}

async function openConversation(id) {
  if (state.sending) {
    showToast("Aguarde a resposta atual terminar (ou clique em parar).");
    return;
  }
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;
  state.activeId = id;
  renderSidebar();
  updateHeader(conversation);
  ui.emptyState.hidden = true;
  ui.messages.innerHTML = '<div class="message assistant"><div class="avatar">✦</div><div class="bubble"><span class="thinking"><i></i><i></i><i></i> carregando…</span></div></div>';
  try {
    const rows = await db.listMessages(id);
    state.messages = (rows || []).map((row) => ({
      role: row.role,
      content: row.content,
    }));
    renderStoredMessages();
  } catch (error) {
    state.messages = [];
    showToast(error.message, "error");
    renderStoredMessages();
  }
  closeSidebar();
}

async function removeConversation(id) {
  if (!window.confirm("Apagar esta conversa e todas as mensagens dela?")) return;
  try {
    await db.deleteConversation(id);
    if (state.activeId === id) {
      state.controller?.abort();
      showEmptyView();
    }
    state.conversations = state.conversations.filter((item) => item.id !== id);
    renderSidebar();
    showToast("Conversa apagada.", "ok");
  } catch (error) {
    showToast(error.message, "error");
  }
}

/* ------------------------------ envio ------------------------------ */

async function sendMessage(text) {
  toggleSending(true);
  let conversation = state.conversations.find((item) => item.id === state.activeId) || null;
  let target = null;
  let accumulated = "";
  let persistedUser = false;

  try {
    if (!conversation) {
      conversation = await db.createConversation({
        title: makeTitle(text),
        model: state.settings.model,
        systemPrompt: state.settings.systemPrompt,
      });
      state.activeId = conversation.id;
      state.conversations.unshift(conversation);
      renderSidebar();
      updateHeader(conversation);
    }

    ui.emptyState.hidden = true;
    addUserBubble(text);
    target = addAssistantBubble();
    state.messages.push({ role: "user", content: text });

    await db.insertMessages(conversation.id, [{ role: "user", content: text }]);
    persistedUser = true;

    const history = state.messages.slice(-20).map((item) => ({
      role: item.role,
      content: item.content,
    }));

    state.controller = new AbortController();
    let pending = false;
    const onDelta = (delta) => {
      accumulated += delta;
      if (!pending) {
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          if (target) setAssistantContent(target, accumulated, true);
        });
      }
    };

    await streamChat({
      messages: history,
      model: state.settings.model,
      systemPrompt: state.settings.systemPrompt,
      temperature: Number(state.settings.temperature),
      maxTokens: Number(state.settings.maxTokens),
      signal: state.controller.signal,
      onDelta,
    });

    if (target) setAssistantContent(target, accumulated, false);
    if (accumulated.trim()) {
      state.messages.push({ role: "assistant", content: accumulated });
      await db.insertMessages(conversation.id, [
        { role: "assistant", content: accumulated },
      ]);
    }
    await refreshConversations();
  } catch (error) {
    const aborted = error?.name === "AbortError";
    if (aborted) {
      if (target) {
        setAssistantContent(
          target,
          accumulated.trim()
            ? `${accumulated}\n\n_Resposta interrompida._`
            : "_Resposta interrompida._",
          false,
        );
      }
      if (accumulated.trim() && conversation) {
        state.messages.push({ role: "assistant", content: accumulated });
        db.insertMessages(conversation.id, [
          { role: "assistant", content: accumulated },
        ]).catch(() => {});
      }
    } else {
      const message = error?.message || "Erro desconhecido ao gerar a resposta.";
      setBubbleError(target, `⚠️ ${message}`);
      showToast(message, "error");
      setStatus("bad", "Falha na conexão");
    }
    if (!persistedUser && target) {
      // Se nem a mensagem do usuário chegou ao banco, mantém apenas na tela.
      console.warn("Gem.AI: mensagem não persistida.", error);
    }
  } finally {
    toggleSending(false);
    state.controller = null;
    ui.promptInput.focus();
  }
}

function handleSubmit(event) {
  event.preventDefault();
  const text = ui.promptInput.value.trim();
  if (!text || state.sending) return;
  ui.promptInput.value = "";
  autosize();
  sendMessage(text);
}

/* ------------------------------ modal ------------------------------ */

function fillModelSelect(ids) {
  const current = state.settings.model;
  const options = (ids && ids.length ? ids : CONFIG.models.map((item) => item.id)).map(
    (id) => {
      const known = CONFIG.models.find((item) => item.id === id);
      return { id, label: known ? known.label : id };
    },
  );
  if (!options.some((item) => item.id === current)) {
    options.unshift({ id: current, label: `${current} (personalizado)` });
  }
  ui.modelSelect.innerHTML = options
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`)
    .join("");
  ui.modelSelect.value = current;
}

function openSettings() {
  const config = getConfig();
  const settings = getSettings();
  state.settings = settings;
  fillModelSelect();
  ui.systemPromptInput.value = settings.systemPrompt ?? "";
  ui.temperatureInput.value = settings.temperature ?? 0.7;
  ui.temperatureValue.textContent = Number(ui.temperatureInput.value).toFixed(1).replace(".", ",");
  ui.maxTokensInput.value = settings.maxTokens ?? 2048;
  ui.chatTokenInput.value = settings.chatToken || getConfig().chatToken || "";
  ui.supabaseUrlInput.value = config.supabaseUrl;
  ui.publishableKeyInput.value = config.supabasePublishableKey;
  ui.functionNameInput.value = config.functionName;
  ui.connectionResult.hidden = true;
  ui.modal.hidden = false;
  closeSidebar();
}

function closeSettings() {
  ui.modal.hidden = true;
}

function saveFromModal() {
  const settings = {
    model: ui.modelSelect.value || CONFIG.defaultModel,
    systemPrompt: ui.systemPromptInput.value.trim() || CONFIG.defaultSystemPrompt,
    temperature: Number(ui.temperatureInput.value),
    maxTokens: Math.min(8192, Math.max(128, Number(ui.maxTokensInput.value) || 2048)),
    chatToken: ui.chatTokenInput.value.trim(),
  };
  saveSettings(settings);
  saveConfigOverrides({
    supabaseUrl: ui.supabaseUrlInput.value,
    supabasePublishableKey: ui.publishableKeyInput.value,
    functionName: ui.functionNameInput.value,
  });
  state.settings = getSettings();
  ui.modelPill.textContent = state.settings.model;
  closeSettings();
  showToast("Configurações salvas.", "ok");
  refreshConversations();
}

async function testConnection() {
  ui.testConnectionBtn.disabled = true;
  ui.connectionResult.hidden = false;
  ui.connectionResult.className = "connection-result";
  ui.connectionResult.textContent = "Testando a Edge Function e a chave da Groq…";
  try {
    // Salva primeiro para que o teste use os valores que estão no formulário.
    saveSettings({
      model: ui.modelSelect.value || CONFIG.defaultModel,
      systemPrompt: ui.systemPromptInput.value.trim() || CONFIG.defaultSystemPrompt,
      temperature: Number(ui.temperatureInput.value),
      maxTokens: Number(ui.maxTokensInput.value) || 2048,
      chatToken: ui.chatTokenInput.value.trim(),
    });
    saveConfigOverrides({
      supabaseUrl: ui.supabaseUrlInput.value,
      supabasePublishableKey: ui.publishableKeyInput.value,
      functionName: ui.functionNameInput.value,
    });
    state.settings = getSettings();
    const ids = await fetchModels();
    const allowed = CONFIG.models.map((item) => item.id);
    const usable = allowed.filter((id) => ids.includes(id));
    const health = await testGeneration(ui.modelSelect.value || CONFIG.defaultModel);
    const sample = (health.reply || "").trim().slice(0, 80);
    ui.connectionResult.className = "connection-result ok";
    ui.connectionResult.textContent =
      `✅ Tudo certo! ${usable.length} modelo(s) de chat habilitado(s): ${usable.join(", ") || "—"}\n` +
      `Teste de geração com ${health.model}: ${sample ? `“${sample}”` : "OK (sem texto de amostra)"}\n` +
      `Histórico no Supabase: conectado.`;
    fillModelSelect(usable.length ? usable : null);
    setStatus("ok", "Supabase + Groq conectados");
  } catch (error) {
    ui.connectionResult.className = "connection-result bad";
    ui.connectionResult.textContent = `❌ ${error.message}`;
    setStatus("bad", "Falha na conexão");
  } finally {
    ui.testConnectionBtn.disabled = false;
  }
}

async function refreshModels() {
  ui.refreshModelsBtn.disabled = true;
  try {
    const ids = await fetchModels();
    const allowed = CONFIG.models.map((item) => item.id);
    const usable = allowed.filter((id) => ids.includes(id));
    fillModelSelect(usable.length ? usable : null);
    showToast(`${ids.length} modelos encontrados na Groq.`, "ok");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    ui.refreshModelsBtn.disabled = false;
  }
}

/* ------------------------------ sidebar mobile ------------------------------ */

function openSidebar() {
  ui.sidebar.classList.add("open");
  ui.sidebarOverlay.classList.add("show");
}
function closeSidebar() {
  ui.sidebar.classList.remove("open");
  ui.sidebarOverlay.classList.remove("show");
}

/* ------------------------------ eventos ------------------------------ */

function bindEvents() {
  ui.composerForm.addEventListener("submit", handleSubmit);
  ui.promptInput.addEventListener("input", autosize);
  ui.promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      handleSubmit(event);
    }
  });
  ui.stopBtn.addEventListener("click", () => state.controller?.abort());

  ui.newChatBtn.addEventListener("click", () => {
    if (state.sending) state.controller?.abort();
    showEmptyView();
    ui.promptInput.focus();
    closeSidebar();
  });

  ui.clearChatBtn.addEventListener("click", () => {
    if (state.sending) state.controller?.abort();
    ui.messages.innerHTML = "";
    showToast("Mensagens limpas da tela. O histórico no Supabase foi mantido.");
  });

  ui.conversationList.addEventListener("click", (event) => {
    const item = event.target.closest(".conv-item");
    if (!item) return;
    if (event.target.closest(".conv-delete")) {
      removeConversation(item.dataset.id);
      return;
    }
    openConversation(item.dataset.id);
  });

  ui.messages.addEventListener("click", (event) => {
    const button = event.target.closest(".copy-code");
    if (!button) return;
    const code = button.closest(".code-block")?.querySelector("code")?.textContent || "";
    navigator.clipboard?.writeText(code).then(
      () => showToast("Código copiado.", "ok"),
      () => showToast("Não foi possível copiar.", "error"),
    );
  });

  ui.emptyState.addEventListener("click", (event) => {
    const button = event.target.closest("[data-prompt]");
    if (!button) return;
    ui.promptInput.value = button.dataset.prompt;
    autosize();
    ui.promptInput.focus();
  });

  ui.sidebarToggle.addEventListener("click", openSidebar);
  ui.sidebarClose.addEventListener("click", closeSidebar);
  ui.sidebarOverlay.addEventListener("click", closeSidebar);

  ui.settingsBtn.addEventListener("click", openSettings);
  ui.settingsClose.addEventListener("click", closeSettings);
  ui.modal.addEventListener("click", (event) => {
    if (event.target === ui.modal) closeSettings();
  });
  ui.saveSettingsBtn.addEventListener("click", saveFromModal);
  ui.testConnectionBtn.addEventListener("click", testConnection);
  ui.refreshModelsBtn.addEventListener("click", refreshModels);
  ui.temperatureInput.addEventListener("input", () => {
    ui.temperatureValue.textContent = Number(ui.temperatureInput.value)
      .toFixed(1)
      .replace(".", ",");
  });
  ui.resetOwnerBtn.addEventListener("click", () => {
    if (!window.confirm("Criar nova identidade local? As conversas antigas ficarão invisíveis neste navegador.")) return;
    db.resetOwnerKey();
    showEmptyView();
    refreshConversations();
    showToast("Nova identidade criada.", "ok");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSettings();
      closeSidebar();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (state.sending) state.controller?.abort();
      showEmptyView();
      ui.promptInput.focus();
    }
  });
}

/* ------------------------------ boot ------------------------------ */

(async function boot() {
  bindEvents();
  ui.modelPill.textContent = state.settings.model;
  try {
    await loadConversations();
    if (state.conversations.length) {
      await openConversation(state.conversations[0].id);
    } else {
      showEmptyView();
    }
  } catch (error) {
    setStatus("bad", "Supabase indisponível");
    showEmptyView();
    showToast(`Não foi possível carregar o histórico: ${error.message}`, "error");
  }
  ui.promptInput.focus();
})();
