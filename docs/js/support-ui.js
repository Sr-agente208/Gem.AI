// Gem.AI · UI da central de ajuda e chamados
// Toda a lógica de dados está em support.js; aqui só renderizamos e ligamos
// eventos. Nenhum HTML é montado com texto do usuário sem escapeHtml().

import { escapeHtml } from "./markdown.js";
import * as api from "./support.js";

const $ = (id) => document.getElementById(id);

const IDS = [
  "supportBtn", "supportModal", "supportClose", "supportTabs",
  "supportPanelHelp", "supportPanelNew", "supportPanelTickets", "supportPanelDiagnostics",
  "supportFaqList", "supportFaqFallback", "supportGitLink",
  "supportForm", "supportCategory", "supportSubject", "supportMessage",
  "supportContact", "supportIncludeDiag", "supportDiagPreview",
  "supportResult", "supportOutboxNote", "supportSubmit",
  "supportTicketStatus", "supportRefresh", "supportTicketList",
  "supportDiagText", "supportCopyDiag", "supportGitFromDiag", "supportCopyDiagLink",
];

let el = {};
let toast = () => {};
let closeSidebar = () => {};
let diag = null;
let tickets = [];
let threads = new Map();
let currentTab = "help";

const dateLabel = (value) => {
  try {
    return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return String(value || "");
  }
};

export function initSupport(options = {}) {
  toast = typeof options.showToast === "function" ? options.showToast : () => {};
  closeSidebar = typeof options.closeSidebar === "function" ? options.closeSidebar : () => {};
  el = Object.fromEntries(IDS.map((id) => [id, $(id)]));
  if (!el.supportModal || !el.supportBtn) return;

  api.captureRuntimeErrors();
  diag = api.diagnostics();
  renderDiagnostics();
  bindEvents();
}

/* ------------------------------- abas -------------------------------- */

function setTab(name) {
  currentTab = name;
  const panels = {
    help: el.supportPanelHelp,
    new: el.supportPanelNew,
    tickets: el.supportPanelTickets,
    diagnostics: el.supportPanelDiagnostics,
  };
  for (const [key, panel] of Object.entries(panels)) {
    if (panel) panel.hidden = key !== name;
  }
  for (const button of el.supportTabs?.querySelectorAll("[data-tab]") || []) {
    button.setAttribute("aria-selected", button.dataset.tab === name ? "true" : "false");
  }
}

function open() {
  el.supportModal.hidden = false;
  closeSidebar();
  setTab(currentTab);
  refresh();
}

function close() {
  el.supportModal.hidden = true;
}

async function refresh() {
  // Sequencial: se havia rascunhos pendentes, o chamado recém-enviado precisa
  // existir no banco antes de listarmos a thread.
  await retryOutbox();
  await Promise.all([loadFaq(), loadTickets()]);
}

/* -------------------------------- FAQ --------------------------------- */

function renderFaq(rows) {
  el.supportFaqList.innerHTML = rows
    .map(
      (item) =>
        `<details class="faq-item">` +
        `<summary><span class="faq-tag">${escapeHtml(item.category || "geral")}</span>` +
        `${escapeHtml(item.question)}</summary>` +
        `<p>${escapeHtml(item.answer)}</p></details>`,
    )
    .join("");
}

async function loadFaq() {
  if (!el.supportFaqList) return;
  try {
    const rows = await api.listFaq();
    if (!Array.isArray(rows) || !rows.length) throw new Error("FAQ vazia");
    renderFaq(rows);
    if (el.supportFaqFallback) el.supportFaqFallback.hidden = true;
  } catch (error) {
    el.supportFaqList.innerHTML =
      `<p class="help-text">Não foi possível carregar a FAQ do Supabase ` +
      `(${escapeHtml(error.message)}). As respostas essenciais estão abaixo.</p>`;
    if (el.supportFaqFallback) el.supportFaqFallback.hidden = false;
  }
}

/* ------------------------------ chamados ------------------------------ */

function statusBadge(status) {
  const label = api.STATUS_LABELS[status] || status || "—";
  return `<span class="ticket-badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function draftCards() {
  return api.readOutbox().map((draft) => ({
    id: draft.id,
    draft: true,
    category: draft.category,
    subject: draft.subject,
    status: "rascunho",
    context: draft.context,
    created_at: draft.createdAt,
    messages: [{ author: "user", body: draft.message, created_at: draft.createdAt }],
  }));
}

function renderTickets() {
  if (!el.supportTicketList) return;
  const cards = [...draftCards(), ...tickets.map((ticket) => ({
    ...ticket,
    messages: threads.get(ticket.id) || [],
  }))];

  if (!cards.length) {
    el.supportTicketList.innerHTML =
      `<p class="help-text">Nenhum chamado ainda. Use <b>Abrir chamado</b> para relatar ` +
      `um problema — a resposta da equipe aparece aqui.</p>`;
    return;
  }

  el.supportTicketList.innerHTML = cards
    .map((ticket) => {
      const protocol = ticket.draft ? "RASCUNHO" : api.protocolOf(ticket.id);
      const firstMessage = ticket.messages.find((m) => m.author === "user")?.body || "";
      // Respeita a escolha do checkbox na abertura: se o contexto veio vazio,
      // a issue também não deve receber o diagnóstico.
      const hasDiag = ticket.context && Object.keys(ticket.context).length > 0;
      const issueUrl = api.gitIssueUrl({
        subject: ticket.subject,
        message: firstMessage,
        protocol: ticket.draft ? "" : protocol,
        diag: hasDiag ? diag : null,
        includeDiagnostics: Boolean(hasDiag),
      });
      const thread = ticket.messages
        .map(
          (msg) =>
            `<div class="ticket-msg ${msg.author === "staff" ? "staff" : "user"}">` +
            `<div class="ticket-msg-head"><b>${msg.author === "staff" ? "Equipe" : "Você"}</b>` +
            `<time>${escapeHtml(dateLabel(msg.created_at))}</time></div>` +
            `<p>${escapeHtml(msg.body)}</p></div>`,
        )
        .join("") || `<p class="help-text">Sem mensagens.</p>`;

      const actions = ticket.draft
        ? `<button class="ghost-btn" type="button" data-action="discard" data-id="${escapeHtml(ticket.id)}">Descartar rascunho</button>`
        : [
            `<button class="ghost-btn" type="button" data-action="copy" data-protocol="${escapeHtml(protocol)}">Copiar protocolo</button>`,
            ticket.status !== "fechado"
              ? `<button class="ghost-btn" type="button" data-action="close" data-id="${escapeHtml(ticket.id)}">Encerrar</button>`
              : "",
            `<a class="ghost-btn" href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer">Issue no GitHub</a>`,
          ].join("");

      const reply =
        !ticket.draft && ticket.status !== "fechado"
          ? `<div class="ticket-reply">` +
            `<input type="text" data-reply-input="${escapeHtml(ticket.id)}" maxlength="5000" ` +
            `placeholder="Acrescentar informação…" aria-label="Responder chamado" />` +
            `<button class="primary-btn" type="button" data-action="reply" data-id="${escapeHtml(ticket.id)}">Enviar</button>` +
            `</div>`
          : "";

      return (
        `<article class="ticket-card">` +
        `<div class="ticket-head"><div><span class="ticket-protocol">${escapeHtml(protocol)}</span>` +
        `<h3>${escapeHtml(ticket.subject)}</h3>` +
        `<small>${escapeHtml(api.categoryLabel(ticket.category))} · ${escapeHtml(dateLabel(ticket.created_at))}</small>` +
        `</div>${statusBadge(ticket.status)}</div>` +
        `<div class="ticket-thread">${thread}</div>${reply}` +
        `<div class="ticket-actions">${actions}</div></article>`
      );
    })
    .join("");
}

async function loadTickets() {
  if (!el.supportTicketList) return;
  el.supportTicketStatus.textContent = "Carregando…";
  try {
    const rows = await api.listTickets();
    tickets = Array.isArray(rows) ? rows : [];
    const messages = tickets.length
      ? await api.listThreads(tickets.map((ticket) => ticket.id))
      : [];
    threads = new Map();
    for (const msg of Array.isArray(messages) ? messages : []) {
      if (!threads.has(msg.ticket_id)) threads.set(msg.ticket_id, []);
      threads.get(msg.ticket_id).push(msg);
    }
    renderTickets();
    el.supportTicketStatus.textContent = tickets.length
      ? `${tickets.length} chamado(s) · respostas aparecem na thread`
      : "Nenhum chamado ainda";
  } catch (error) {
    tickets = [];
    threads = new Map();
    renderTickets(); // ainda mostra os rascunhos locais
    el.supportTicketStatus.textContent = `Chamados online indisponíveis: ${error.message}`;
  }
}

async function retryOutbox() {
  const result = await api.flushOutbox();
  if (result.sent) toast(`${result.sent} chamado(s) pendente(s) enviado(s) ao Supabase.`, "ok");
  for (const message of result.errors.slice(0, 1)) toast(message, "error");
  if (el.supportOutboxNote) {
    el.supportOutboxNote.hidden = result.pending === 0;
    el.supportOutboxNote.textContent = result.pending
      ? `${result.pending} chamado(s) salvo(s) neste navegador, aguardando conexão. ` +
        "O reenvio é automático ao abrir a central ou voltar a ficar online."
      : "";
  }
  return result;
}

/* ---------------------------- abrir chamado --------------------------- */

function showResult(ticket) {
  const protocol = api.protocolOf(ticket.id);
  el.supportResult.hidden = false;
  el.supportResult.innerHTML =
    `✅ Chamado <b>${escapeHtml(protocol)}</b> aberto. ` +
    `Acompanhe em <button type="button" class="link-btn" data-action="goto-tickets">Meus chamados</button>.`;
}

async function submitTicket(event) {
  event.preventDefault();
  const payload = {
    category: el.supportCategory.value,
    subject: el.supportSubject.value.trim(),
    message: el.supportMessage.value.trim(),
    contact: el.supportContact.value.trim(),
    context: el.supportIncludeDiag.checked ? diag : {},
  };
  if (payload.subject.length < 4 || payload.message.length < 10) {
    toast("Assunto (≥4) e descrição (≥10 caracteres) são obrigatórios.", "error");
    return;
  }
  const button = el.supportSubmit;
  button.disabled = true;
  button.textContent = "Enviando…";
  try {
    const ticket = await api.createTicket(payload);
    showResult(ticket);
    toast(`Chamado ${api.protocolOf(ticket.id)} aberto no Supabase.`, "ok");
    el.supportForm.reset();
    el.supportIncludeDiag.checked = true;
    await loadTickets();
    setTab("tickets");
  } catch (error) {
    if (!error.status || error.status >= 500) {
      api.enqueueTicket(payload);
      el.supportOutboxNote.hidden = false;
      el.supportOutboxNote.textContent =
        "Sem conexão: o chamado foi salvo neste navegador e será enviado automaticamente.";
      toast("Sem conexão: chamado salvo localmente para reenvio automático.", "error");
      el.supportForm.reset();
      el.supportIncludeDiag.checked = true;
      renderTickets();
      setTab("tickets");
    } else {
      toast(error.message, "error");
    }
  } finally {
    button.disabled = false;
    button.textContent = "Abrir chamado";
  }
}

/* ---------------------------- diagnóstico ----------------------------- */

function renderDiagnostics() {
  const text = api.formatDiagnostics(diag);
  if (el.supportDiagText) el.supportDiagText.textContent = text;
  if (el.supportDiagPreview) el.supportDiagPreview.textContent = text;
  const url = api.gitIssueUrl({
    subject: "Diagnóstico do navegador",
    message: "(descreva aqui o que aconteceu)",
    diag,
    includeDiagnostics: true,
  });
  if (el.supportGitFromDiag) el.supportGitFromDiag.href = url;
  if (el.supportGitLink) el.supportGitLink.href = url;
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, "ok");
  } catch {
    toast("Não foi possível copiar automaticamente; selecione o texto manualmente.", "error");
  }
}

/* ------------------------------- eventos ------------------------------ */

function bindEvents() {
  el.supportBtn.addEventListener("click", open);
  el.supportClose.addEventListener("click", close);
  el.supportModal.addEventListener("click", (event) => {
    if (event.target === el.supportModal) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.supportModal.hidden) close();
  });
  el.supportTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (button) setTab(button.dataset.tab);
  });
  el.supportForm.addEventListener("submit", submitTicket);
  el.supportRefresh.addEventListener("click", async () => {
    await retryOutbox();
    await loadTickets();
  });
  el.supportCopyDiag?.addEventListener("click", () =>
    copyText(api.formatDiagnostics(diag), "Diagnóstico copiado."),
  );
  el.supportCopyDiagLink?.addEventListener("click", () =>
    copyText(api.formatDiagnostics(diag), "Diagnóstico copiado."),
  );

  el.supportResult.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="goto-tickets"]')) setTab("tickets");
  });

  el.supportTicketList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id, protocol } = button.dataset;
    if (action === "goto-tickets") { setTab("tickets"); return; }
    if (action === "copy") {
      await copyText(protocol, `Protocolo ${protocol} copiado.`);
      return;
    }
    if (action === "discard") {
      api.discardDraft(id);
      renderTickets();
      await retryOutbox();
      toast("Rascunho descartado.", "ok");
      return;
    }
    if (action === "close") {
      try {
        await api.closeTicket(id);
        toast("Chamado encerrado.", "ok");
        await loadTickets();
      } catch (error) { toast(error.message, "error"); }
      return;
    }
    if (action === "reply") {
      const input = el.supportTicketList.querySelector(`[data-reply-input="${id}"]`);
      const body = input?.value?.trim() || "";
      if (body.length < 2) { toast("Escreva uma mensagem antes de enviar.", "error"); return; }
      try {
        await api.replyTicket(id, body);
        if (input) input.value = "";
        toast("Mensagem acrescentada ao chamado.", "ok");
        await loadTickets();
      } catch (error) { toast(error.message, "error"); }
    }
  });

  window.addEventListener("online", async () => {
    const result = await retryOutbox();
    if (result.sent) await loadTickets();
  });
}
