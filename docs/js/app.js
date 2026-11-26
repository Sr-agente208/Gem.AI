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
import { formatDuration } from "./media.js";
import { initSupport } from "./support-ui.js";
import { initAuthUI } from "./auth-ui.js";
import {
  processFiles,
  buildContent,
  textFromContent,
  messageToPayload,
  uploadAttachments,
  downloadAttachment,
  deleteConversationFiles,
  formatBytes,
  kindLabel,
} from "./files.js";

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
  composerWrap: $("composerWrap"),
  promptInput: $("promptInput"),
  sendBtn: $("sendBtn"),
  stopBtn: $("stopBtn"),
  fileInput: $("fileInput"),
  attachBtn: $("attachBtn"),
  attachmentTray: $("attachmentTray"),
  dropHint: $("dropHint"),
  uploadStatus: $("uploadStatus"),
  composerHint: $("composerHint"),
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
  pending: [], // anexos ainda não enviados
  preparing: false, // processando arquivos (PDF/imagem)
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

function setUploadStatus(text) {
  ui.uploadStatus.hidden = !text;
  ui.uploadStatus.textContent = text || "";
}

/* ------------------------------ anexos ------------------------------ */

function attachmentChip(meta, removable = false) {
  const name = escapeHtml(meta.name || "arquivo");
  const note = meta.note ? escapeHtml(meta.note) : "";
  const status = note
    ? " · ⚠ ver aviso"
    : meta.frameCount
      ? ` · ✓ ${meta.frameCount} fotogramas` +
        (meta.videoMeta?.duration ? ` · ${formatDuration(meta.videoMeta.duration)}` : "")
      : meta.summary
        ? ` · ✓ ${meta.extracted ?? 0} caracteres + estatísticas`
        : meta.extracted
          ? ` · ✓ ${meta.extracted} caracteres lidos`
          : ["image", "video"].includes(meta.kind)
            ? " · ✓ pronto para visão"
            : "";
  const sub = `${formatBytes(meta.size)} · ${kindLabel(meta.kind)}${status}`;
  const icon =
    meta.kind === "video" ? "🎬" :
    meta.kind === "pdf" ? "📕" :
    meta.kind === "office" ? "📊" :
    meta.kind === "text" ? "📄" : "📎";
  const preview =
    ["image", "video"].includes(meta.kind) && meta.dataUrl
      ? `<img src="${escapeHtml(meta.dataUrl)}" alt="" />`
      : `<span class="file-icon" aria-hidden="true">${icon}</span>`;

  if (removable) {
    return (
      `<div class="file-chip${note ? " warn" : ""}" title="${note || name}">` +
      `${preview}<span class="file-meta"><span class="file-name">${name}</span>` +
      `<span class="file-sub">${escapeHtml(sub)}</span></span>` +
      `<button class="file-remove" type="button" data-remove="${escapeHtml(meta.id)}" aria-label="Remover anexo">✕</button></div>`
    );
  }

  const paths =
    Array.isArray(meta.parts) && meta.parts.length
      ? meta.parts.map((part) => part.path)
      : meta.path
        ? [meta.path]
        : [];
  const attrs = paths.length
    ? ` type="button" data-paths="${escapeHtml(JSON.stringify(paths))}" ` +
      `data-name="${name}" data-type="${escapeHtml(meta.type || "")}"`
    : "";
  const tag = paths.length ? "button" : "div";
  const action = paths.length ? '<span class="file-dl" aria-hidden="true">⬇</span>' : "";
  return (
    `<${tag} class="file-chip${note ? " warn" : ""}"${attrs} title="${note || name}">` +
    `${preview}<span class="file-meta"><span class="file-name">${name}</span>` +
    `<span class="file-sub">${escapeHtml(sub)}</span></span>${action}</${tag}>`
  );
}

function renderBubbleAttachments(attachments) {
  if (!attachments || !attachments.length) return "";
  const images = attachments.filter(
    (item) => ["image", "video"].includes(item.kind) && item.dataUrl,
  );
  const thumbs = images.length
    ? `<div class="bubble-images">${images
        .map(
          (item) =>
            `<img src="${escapeHtml(item.dataUrl)}" alt="${escapeHtml(item.name)}" />`,
        )
        .join("")}</div>`
    : "";
  return `${thumbs}<div class="bubble-attachments">${attachments
    .map((item) => attachmentChip(item, false))
    .join("")}</div>`;
}

function renderPending() {
  ui.attachmentTray.hidden = state.pending.length === 0;
  ui.attachmentTray.innerHTML = state.pending
    .map((item) => attachmentChip(item, true))
    .join("");
  // <label> não aceita `disabled`: desabilitamos o input e bloqueamos o toque.
  const busy = state.preparing;
  ui.fileInput.disabled = busy;
  ui.attachBtn.classList.toggle("disabled", busy);
  ui.attachBtn.setAttribute("aria-disabled", busy ? "true" : "false");
}

function clearPending() {
  state.pending = [];
  ui.fileInput.value = "";
  renderPending();
}

async function addFiles(fileList) {
  if (state.preparing || !fileList || !fileList.length) return;
  state.preparing = true;
  renderPending();
  try {
    const { attachments, warnings } = await processFiles(fileList, state.pending);
    state.pending.push(...attachments);
    for (const warning of warnings) showToast(warning, "error");
    const read = attachments.filter((item) => item.extracted);
    const visual = attachments.filter((item) => item.visual);
    const frames = visual.reduce((n, item) => n + (item.frameCount || 0), 0);
    const unread = attachments.filter((item) => item.note);
    const stats = attachments.filter((item) => item.summary).length;
    if (read.length || visual.length) {
      const bits = [];
      if (read.length) {
        bits.push(
          `${read.reduce((n, a) => n + a.extracted, 0)} caracteres de ${read.length} arquivo(s)`,
        );
      }
      if (visual.length) {
        bits.push(
          frames
            ? `${frames} fotogramas de vídeo para visão`
            : `${visual.length} foto(s) para visão`,
        );
      }
      if (stats) bits.push(`estatísticas de ${stats} planilha(s)`);
      showToast(`Pronto para analisar: ${bits.join(" · ")}.`, "ok");
    } else if (attachments.length) {
      showToast(`${attachments.length} arquivo(s) pronto(s) para enviar.`, "ok");
    }
    if (unread.length) {
      showToast(
        unread.length === 1
          ? unread[0].note
          : `${unread.length} arquivo(s) não puderam ser lidos (${unread
              .map((item) => item.name)
              .join(", ")}). Veja o aviso em cada chip.`,
        "error",
      );
    }
  } catch (error) {
    showToast(error?.message || "Falha ao preparar os arquivos.", "error");
  } finally {
    state.preparing = false;
    ui.fileInput.value = "";
    renderPending();
  }
}

async function openAttachment(meta) {
  try {
    setUploadStatus(`Baixando ${meta.name}…`);
    const result = await downloadAttachment(meta);
    const message =
      result?.via === "cancelled"
        ? "Compartilhamento cancelado."
        : result?.via === "share"
          ? `${meta.name} enviado para o compartilhamento do sistema.`
          : `Download de ${meta.name} iniciado.`;
    showToast(message, "ok");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setUploadStatus("");
  }
}

/** Só a última mensagem do usuário mantém as imagens (limite de 3 por requisição). */
function buildHistory() {
  const recent = state.messages.slice(-20);
  let lastWithImages = -1;
  recent.forEach((message, index) => {
    if (
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image_url")
    ) {
      lastWithImages = index;
    }
  });
  return recent.map((message, index) => {
    let content = message.content;
    if (Array.isArray(content) && index !== lastWithImages) {
      content = textFromContent(content) || "(imagem anexada anteriormente)";
    }
    return { role: message.role, content };
  });
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

function addUserBubble(text, attachments = []) {
  const message = document.createElement("div");
  message.className = "message user";
  message.innerHTML =
    `<div class="bubble">${escapeHtml(text)}${renderBubbleAttachments(attachments)}</div>` +
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
    const display = message.display ?? textFromContent(message.content);
    if (message.role === "user") {
      addUserBubble(display, message.attachments || []);
    } else {
      const target = addAssistantBubble();
      setAssistantContent(target, display, false);
    }
  }
  ui.emptyState.hidden = state.messages.length > 0;
  scrollToBottom(true);
}

function showEmptyView() {
  state.activeId = null;
  state.messages = [];
  clearPending();
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
  if (id !== state.activeId) clearPending(); // anexos pertencem à mensagem em composição
  state.activeId = id;
  renderSidebar();
  updateHeader(conversation);
  ui.emptyState.hidden = true;
  ui.messages.innerHTML = '<div class="message assistant"><div class="avatar">✦</div><div class="bubble"><span class="thinking"><i></i><i></i><i></i> carregando…</span></div></div>';
  try {
    const rows = await db.listMessages(id);
    state.messages = (rows || []).map((row) => {
      const content = messageToPayload(row);
      return {
        role: row.role,
        content,
        display: row.display_content ?? textFromContent(content),
        attachments: Array.isArray(row.attachments) ? row.attachments : [],
      };
    });
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
    deleteConversationFiles(id); // melhor esforço: remove também os arquivos do Storage
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

async function sendMessage(text, options = {}) {
  const {
    attachments = [],
    content = text,
    model = state.settings.model,
    titleText = text,
  } = options;
  toggleSending(true);
  let conversation = state.conversations.find((item) => item.id === state.activeId) || null;
  let target = null;
  let accumulated = "";
  let persistedUser = false;

  try {
    if (!conversation) {
      conversation = await db.createConversation({
        title: makeTitle(titleText || "Arquivos anexados"),
        model: state.settings.model,
        systemPrompt: state.settings.systemPrompt,
      });
      state.activeId = conversation.id;
      state.conversations.unshift(conversation);
      renderSidebar();
      updateHeader(conversation);
    }

    // Originais vão para o Storage privado; falhas viram aviso, não bloqueiam o chat.
    let metas = [];
    if (attachments.length) {
      setUploadStatus(`Enviando ${attachments.length} arquivo(s)…`);
      try {
        const upload = await uploadAttachments(conversation.id, attachments, (progress) => {
          const percent = progress.total
            ? Math.round((progress.loaded / progress.total) * 100)
            : 0;
          setUploadStatus(
            `Enviando ${progress.index + 1}/${progress.count}: ${progress.name} · ` +
              `${percent}% (${formatBytes(progress.loaded)} de ${formatBytes(progress.total)})` +
              (progress.parts > 1 ? ` · parte ${progress.part}/${progress.parts}` : ""),
          );
        });
        metas = upload.metas;
        for (const warning of upload.warnings) showToast(warning, "error");
      } finally {
        setUploadStatus("");
      }
    }

    ui.emptyState.hidden = true;
    addUserBubble(text, metas);
    target = addAssistantBubble();
    const userMessage = { role: "user", content, display: text, attachments: metas };
    state.messages.push(userMessage);

    await db.insertMessages(conversation.id, [userMessage]);
    persistedUser = true;

    const history = buildHistory();

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
      model,
      systemPrompt: state.settings.systemPrompt,
      temperature: Number(state.settings.temperature),
      maxTokens: Number(state.settings.maxTokens),
      signal: state.controller.signal,
      onDelta,
    });

    if (target) setAssistantContent(target, accumulated, false);
    if (accumulated.trim()) {
      state.messages.push({
        role: "assistant",
        content: accumulated,
        display: accumulated,
        attachments: [],
      });
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
        state.messages.push({
          role: "assistant",
          content: accumulated,
          display: accumulated,
          attachments: [],
        });
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
    setUploadStatus("");
    state.controller = null;
    ui.promptInput.focus();
  }
}

function handleSubmit(event) {
  event.preventDefault();
  if (state.sending || state.preparing) return;
  const text = ui.promptInput.value.trim();
  const attachments = [...state.pending];
  if (!text && !attachments.length) return;

  const content = buildContent(text, attachments);
  // Fotos E fotogramas de vídeo exigem o modelo com visão.
  const hasImages = attachments.some(
    (item) => item.dataUrl && ["image", "video"].includes(item.kind),
  );
  const model = hasImages ? getConfig().visionModel : state.settings.model;
  if (hasImages && model !== state.settings.model) {
    showToast(`Imagens/vídeo analisados com ${model} (modelo com visão).`, "ok");
  }

  ui.promptInput.value = "";
  autosize();
  clearPending();
  sendMessage(text || "📎 Arquivo(s) anexado(s)", {
    attachments,
    content,
    model,
    titleText: text || attachments.map((item) => item.name).join(", "),
  });
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

  // O <label for="fileInput"> abre o seletor nativo sem depender de .click()
  // num input display:none — e é isso que falha no iOS Safari. Mantemos o
  // suporte a teclado e o change, que é universal.
  ui.attachBtn.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!state.preparing) ui.fileInput.click();
    }
  });
  ui.fileInput.addEventListener("change", (event) => addFiles(event.target.files));
  ui.attachmentTray.addEventListener("click", (event) => {
    const button = event.target.closest(".file-remove");
    if (!button) return;
    state.pending = state.pending.filter((item) => item.id !== button.dataset.remove);
    renderPending();
    ui.promptInput.focus();
  });

  let dragDepth = 0;
  const showDrop = (show) => {
    ui.dropHint.hidden = !show;
    ui.composerWrap.classList.toggle("dragging", show);
  };
  const hasFiles = (event) =>
    Array.from(event.dataTransfer?.types || []).includes("Files");
  ui.composerWrap.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    showDrop(true);
  });
  ui.composerWrap.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  ui.composerWrap.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDrop(false);
  });
  ui.composerWrap.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    dragDepth = 0;
    showDrop(false);
    addFiles(event.dataTransfer.files);
  });
  window.addEventListener("dragover", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener("drop", (event) => event.preventDefault());

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
    const chip = event.target.closest(".file-chip[data-paths]");
    if (chip) {
      let paths = [];
      try {
        paths = JSON.parse(chip.dataset.paths);
      } catch {
        paths = [];
      }
      openAttachment({
        name: chip.dataset.name || "arquivo",
        type: chip.dataset.type || "application/octet-stream",
        parts: paths.map((path) => ({ path })),
      });
      return;
    }
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

  // CORREÇÃO (mobile): o backdrop do menu agora tem pointer-events:none, então
  // ele não engole mais os toques. Fechamos o menu por delegação, em capture,
  // SEM preventDefault/stopPropagation: um único toque fecha o drawers E aciona
  // o botão do chat (enviar, anexar, lixeira, modelo, prompts). Antes, com o
  // menu aberto, esses cliques simplesmente não chegavam ao destino.
  const closeOnOutside = (event) => {
    if (!ui.sidebar.classList.contains("open")) return;
    const target = event.target;
    if (ui.sidebar.contains(target) || ui.sidebarToggle?.contains(target)) return;
    closeSidebar();
  };
  document.addEventListener("pointerdown", closeOnOutside, true);
  document.addEventListener("click", closeOnOutside, true);

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

/* ------------------------- iOS / Android ------------------------- */

/**
 * Compatibilidade por plataforma:
 * - Android Chrome: `interactive-widget=resizes-content` já faz o 100dvh
 *   encolher quando o teclado abre; não há nada a corrigir aqui.
 * - iOS Safari: o teclado apenas SOBREPÕE a tela e o 100dvh não muda.
 *   Medimos visualViewport e publicamos --app-height (classe .keyboard-open).
 * - Android: o service worker network-only habilita "Instalar aplicativo"
 *   a partir do manifest; no iOS o modo standalone vem das meta Apple.
 */
function setupMobilePlatform() {
  const isTouch = window.matchMedia?.("(hover: none), (pointer: coarse)").matches;
  const root = document.documentElement;
  const viewport = window.visualViewport;

  if (isTouch && viewport) {
    const syncHeight = () => {
      // innerHeight = layout viewport; visualViewport = área acima do teclado.
      const visible = viewport.height + viewport.offsetTop;
      const covered = window.innerHeight - visible;
      if (covered > 80) {
        root.style.setProperty("--app-height", `${Math.max(240, Math.round(visible))}px`);
        root.classList.add("keyboard-open");
      } else {
        root.classList.remove("keyboard-open");
        root.style.removeProperty("--app-height");
      }
    };
    syncHeight();
    viewport.addEventListener("resize", syncHeight);
    viewport.addEventListener("scroll", syncHeight);
    window.addEventListener("orientationchange", () => setTimeout(syncHeight, 250));

    // O Safari nem sempre reposiciona o composer ao terminar a animação.
    ui.promptInput.addEventListener("focus", () => {
      setTimeout(() => {
        if (root.classList.contains("keyboard-open")) {
          ui.composerWrap.scrollIntoView({ block: "end" });
        }
      }, 320);
    });
  }

  // Registro silencioso: sem fetch handler o Chrome não oferece instalação.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  }
}

/* ------------------------------ boot ------------------------------ */

/** Após entrar/sair/vincular: recarrega o histórico com a nova identidade RLS. */
async function reloadAfterAuth() {
  try {
    await loadConversations();
    if (state.conversations.length) await openConversation(state.conversations[0].id);
    else showEmptyView();
  } catch (error) {
    showToast(`Não foi possível recarregar o histórico: ${error?.message || error}`, "error");
  }
}

(async function boot() {
  // 1) Listeners PRIMEIRO: mesmo que um módulo opcional falhe, os botões do
  //    chat (enviar, anexar, menu, configurações) continuam respondendo.
  bindEvents();
  // 2) Módulos opcionais são isolados: um erro de diagnóstico/PWA/login não
  //    pode abortar o boot e deixar a tela "morta".
  const safe = (label, fn) => {
    try {
      const result = fn();
      if (result && typeof result.catch === "function") {
        result.catch((error) => console.warn(`Gem.AI: ${label}`, error));
      }
    } catch (error) {
      console.warn(`Gem.AI: ${label}`, error);
    }
  };
  // Central de ajuda/chamados: módulo separado para não misturar com o chat.
  safe("suporte", () => initSupport({ showToast, closeSidebar }));
  safe("plataforma mobile", () => setupMobilePlatform());
  safe("login", () => initAuthUI({ showToast, closeSidebar, onSessionChange: reloadAfterAuth }));
  const isTouch = window.matchMedia?.("(hover: none), (pointer: coarse)").matches;
  const sizeHint = formatBytes(getConfig().maxFileBytes);
  ui.composerHint.textContent = isTouch
    ? `Toque no clipe para anexar · toque em enviar para responder · até ${sizeHint} por arquivo`
    : `Enter envia · Shift + Enter quebra linha · arraste arquivos aqui · ` +
      `imagens, PDF, texto (até ${sizeHint})`;
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
