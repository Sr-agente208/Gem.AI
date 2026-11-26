// Gem.AI · painel de tarefas do Office (Word / Excel / PowerPoint)
//
// Usa a API JavaScript do Office para ler o DOCUMENTO ABERTO e envia o texto
// ao mesmo proxy da Groq usado pelo chat. Progressivo por design:
//   • sem Office.js (CDN bloqueada) -> ainda conversa, sem contexto do documento
//   • sem API específica do host     -> tenta apenas a seleção (Common API)
//   • PowerPointApi < 1.4           -> seleção, com aviso honesto
// Nunca inventa conteúdo: se não conseguiu ler, diz exatamente isso.
//
// Este arquivo NÃO é carregado pelo chat principal. A única CDN do projeto
// está no <head> de taskpane.html, exigida pela Microsoft.

import { getConfig, getSettings } from "../js/config.js";
import { streamChat } from "../js/groq.js";
import { renderMarkdown } from "../js/markdown.js";
import { buildContent } from "../js/files.js";
import { summarizeSpreadsheet } from "../js/spreadsheet.js";

const $ = (id) => document.getElementById(id);
const ui = {
  hostBadge: $("hostBadge"), status: $("status"), includeDoc: $("includeDoc"),
  readBtn: $("readBtn"), docInfo: $("docInfo"), question: $("question"),
  analyzeBtn: $("analyzeBtn"), stopBtn: $("stopBtn"), answer: $("answer"),
  copyBtn: $("copyBtn"), insertBtn: $("insertBtn"),
};

const state = {
  host: null,        // "Word" | "Excel" | "PowerPoint" | null
  officeReady: false,
  docText: "",
  docVia: "",
  answer: "",
  controller: null,
};

function setStatus(message, kind = "") {
  ui.status.className = `status ${kind}`.trim();
  ui.status.textContent = message;
}

function hostLabel(value) {
  const v = String(value || "").toLowerCase();
  if (v.includes("word")) return "Word";
  if (v.includes("excel")) return "Excel";
  if (v.includes("powerpoint")) return "PowerPoint";
  return value ? String(value) : "Office";
}

/** `isSetSupported` pode não existir em hosts antigos: falha fechada. */
function supported(set, version) {
  try {
    return Boolean(globalThis.Office?.context?.requirements?.isSetSupported?.(set, version));
  } catch {
    return false;
  }
}

/** Office.js vem da CDN; se ela for bloqueada, onReady nunca resolve. */
function waitForOffice(timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (globalThis.Office?.onReady) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(
          "Office.js não carregou. A CDN da Microsoft pode estar bloqueada por firewall, " +
          "proxy ou extensão do navegador. O chat continua funcionando sem o documento.",
        ));
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

/* ------------------------- Leitura: Common API ------------------------- */

function readSelection() {
  return new Promise((resolve) => {
    const office = globalThis.Office;
    if (!office?.context?.document?.getSelectedDataAsync) return resolve("");
    try {
      office.context.document.getSelectedDataAsync(office.CoercionType.Text, (result) => {
        if (result?.status === office.AsyncResultStatus.Succeeded) {
          resolve(String(result.value || ""));
        } else {
          resolve("");
        }
      });
    } catch {
      resolve("");
    }
  });
}

/* --------------------------- Leitura: Word ---------------------------- */

async function readWord() {
  if (!supported("WordApi", "1.1") || typeof globalThis.Word === "undefined") return "";
  try {
    return await globalThis.Word.run(async (context) => {
      const body = context.document.body;
      body.load("text");                 // WordApi 1.1, Word.Interfaces.BodyData.text
      await context.sync();
      return String(body.text || "");
    });
  } catch {
    // Alguns builds não expõem Body.text: parágrafos são o fallback 1.1.
    try {
      return await globalThis.Word.run(async (context) => {
        const paragraphs = context.document.body.paragraphs;
        paragraphs.load("text");
        await context.sync();
        return paragraphs.items.map((p) => String(p.text || "")).join("\n");
      });
    } catch {
      return "";
    }
  }
}

/* --------------------------- Leitura: Excel --------------------------- */

async function readExcel() {
  if (!supported("ExcelApi", "1.1") || typeof globalThis.Excel === "undefined") return "";
  try {
    return await globalThis.Excel.run(async (context) => {
      const sheets = context.workbook.worksheets;
      sheets.load("items/name");
      await context.sync();
      const parts = [];
      for (const sheet of sheets.items.slice(0, 12)) {
        let range;
        try { range = sheet.getUsedRange(); } catch { continue; }
        if (!range) continue;
        range.load("values");
        await context.sync();
        const values = Array.isArray(range.values) ? range.values : [];
        const lines = values
          .slice(0, 200)
          .map((row) => (Array.isArray(row) ? row : [row])
            .map((cell) => (cell === null || cell === undefined ? "" : String(cell)))
            .join("\t").trimEnd())
          .filter((line) => line.trim());
        if (lines.length) parts.push(`[planilha: ${sheet.name}]\n${lines.join("\n")}`);
        if (parts.join("\n").length > 20000) break;
      }
      return parts.join("\n");
    });
  } catch {
    return "";
  }
}

/* ------------------------ Leitura: PowerPoint ------------------------- */

async function readPowerPoint() {
  // TextFrame/TextRange exigem PowerPointApi 1.4. Em versões antigas o painel
  // cai para a seleção (Common API) e avisa, em vez de fingir que leu os slides.
  if (!supported("PowerPointApi", "1.4") || typeof globalThis.PowerPoint === "undefined") return "";
  try {
    return await globalThis.PowerPoint.run(async (context) => {
      const slides = context.presentation.slides;
      slides.load("items");
      await context.sync();
      const parts = [];
      for (let i = 0; i < Math.min(slides.items.length, 60); i += 1) {
        const shapes = slides.items[i].shapes;
        shapes.load("items");
        await context.sync();
        const ranges = [];
        for (const shape of shapes.items) {
          try {
            const frame = shape.textFrame;
            const range = frame?.textRange;
            if (!range) continue;
            range.load("text");
            ranges.push(range);
          } catch { /* forma sem texto */ }
        }
        if (!ranges.length) continue;
        await context.sync();
        const texts = ranges
          .map((r) => { try { return String(r.text || "").trim(); } catch { return ""; } })
          .filter(Boolean);
        if (texts.length) parts.push(`[slide ${i + 1}] ${texts.join(" ")}`);
        if (parts.join("\n").length > 20000) break;
      }
      return parts.join("\n");
    });
  } catch {
    return "";
  }
}

/* ----------------------------- Orquestração --------------------------- */

async function collectDocument() {
  const readers = {
    Word: { fn: readWord, via: "corpo do documento", name: "documento-atual.docx" },
    Excel: { fn: readExcel, via: "planilhas usadas", name: "pasta-de-trabalho-atual.xlsx" },
    PowerPoint: { fn: readPowerPoint, via: "texto dos slides", name: "apresentacao-atual.pptx" },
  };
  const reader = readers[state.host];
  let text = reader ? await reader.fn() : "";
  let via = reader ? reader.via : "";

  if (!text.trim()) {
    text = await readSelection();
    via = text.trim() ? "seleção atual" : "";
  }
  const maxChars = getConfig().maxExtractChars || 20000;
  return {
    text: text.replace(/\r\n/g, "\n").slice(0, maxChars).trim(),
    via,
    name: reader?.name || "documento-atual.txt",
  };
}

function showDocInfo(doc) {
  if (!doc.text) {
    ui.docInfo.textContent = "sem leitura";
    return;
  }
  ui.docInfo.textContent = `✓ ${doc.text.length} caracteres · ${doc.via}`;
}

async function readDocument() {
  if (!state.officeReady) {
    setStatus("Office.js indisponível: só é possível ler o documento dentro do Office.", "bad");
    return null;
  }
  setStatus("Lendo o documento aberto…", "busy");
  try {
    const doc = await collectDocument();
    state.docText = doc.text;
    state.docVia = doc.via;
    showDocInfo(doc);
    if (!doc.text) {
      const extra = state.host === "PowerPoint" && !supported("PowerPointApi", "1.4")
        ? " Este PowerPoint não oferece PowerPointApi 1.4."
        : "";
      setStatus(
        `Não foi possível ler o documento. Selecione um trecho no ${state.host || "Office"} ` +
        `e tente de novo, ou desmarque a opção de incluir o documento.${extra}`,
        "bad",
      );
      return null;
    }
    const sets = [
      supported("WordApi", "1.1") && "WordApi 1.1",
      supported("ExcelApi", "1.1") && "ExcelApi 1.1",
      supported("PowerPointApi", "1.4") && "PowerPointApi 1.4",
    ].filter(Boolean);
    setStatus(`Documento lido (${doc.text.length} caracteres · ${doc.via}). Pronto para analisar.`, "ok");
    return doc;
  } catch (error) {
    setStatus(`Falha ao ler o documento: ${error?.message || error}`, "bad");
    return null;
  }
}

async function analyze() {
  if (state.controller) return;
  const question = ui.question.value.trim() || "Resuma o conteúdo e destaque os pontos principais.";
  let doc = null;
  if (ui.includeDoc.checked) {
    doc = await readDocument();
    if (!doc && state.officeReady) return; // aviso já exibido; não inventa conteúdo
  } else {
    state.docText = "";
    ui.docInfo.textContent = "não incluído";
  }

  const attachments = doc?.text
    ? [{
        name: doc.name,
        kind: "text",
        text: doc.text,
        extracted: doc.text.length,
        summary: state.host === "Excel" ? summarizeSpreadsheet(doc.text) : "",
      }]
    : [];
  const composed = buildContent(question, attachments);
  const cfg = getConfig();
  const settings = getSettings();

  ui.answer.innerHTML = '<span class="muted">Pensando…</span>';
  state.answer = "";
  state.controller = new AbortController();
  ui.analyzeBtn.disabled = true;
  ui.stopBtn.hidden = false;
  setStatus("Consultando a Groq pelo proxy do Supabase…", "busy");

  try {
    const full = await streamChat({
      messages: [{ role: "user", content: composed }],
      model: settings.model || cfg.defaultModel,
      systemPrompt: settings.systemPrompt || cfg.defaultSystemPrompt,
      temperature: settings.temperature ?? 0.7,
      maxTokens: settings.maxTokens || 2048,
      signal: state.controller.signal,
      onDelta: (delta) => {
        state.answer += delta;
        ui.answer.innerHTML = renderMarkdown(state.answer) || '<span class="muted">…</span>';
      },
    });
    state.answer = full || state.answer;
    ui.answer.innerHTML = renderMarkdown(state.answer);
    setStatus("Resposta concluída.", "ok");
  } catch (error) {
    const aborted = error?.name === "AbortError";
    ui.answer.innerHTML = aborted && state.answer
      ? renderMarkdown(state.answer)
      : `<span class="muted">${escapeText(error?.message || error)}</span>`;
    setStatus(aborted ? "Geração interrompida." : `Erro: ${error?.message || error}`, aborted ? "" : "bad");
  } finally {
    state.controller = null;
    ui.analyzeBtn.disabled = false;
    ui.stopBtn.hidden = true;
  }
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function copyAnswer() {
  if (!state.answer) return setStatus("Nada para copiar ainda.", "bad");
  try {
    await navigator.clipboard.writeText(state.answer);
    setStatus("Resposta copiada.", "ok");
  } catch {
    setStatus("Não foi possível copiar automaticamente; selecione o texto.", "bad");
  }
}

/** Insere a resposta no documento: Word (parágrafo no fim) / Excel (célula selecionada). */
async function insertAnswer() {
  if (!state.answer) return setStatus("Nada para inserir ainda.", "bad");
  if (!state.officeReady) return setStatus("Abra o painel dentro do Office para inserir.", "bad");
  try {
    if (state.host === "Word" && typeof globalThis.Word !== "undefined") {
      await globalThis.Word.run(async (context) => {
        context.document.body.insertParagraph(state.answer, globalThis.Word.InsertLocation.end);
        await context.sync();
      });
      setStatus("Resposta inserida no fim do documento.", "ok");
      return;
    }
    if (state.host === "Excel" && typeof globalThis.Excel !== "undefined") {
      await globalThis.Excel.run(async (context) => {
        context.workbook.getSelectedRange().values = [[state.answer]];
        await context.sync();
      });
      setStatus("Resposta inserida na célula selecionada.", "ok");
      return;
    }
    setStatus(
      "Inserção automática disponível apenas em Word e Excel. No PowerPoint, use Copiar.",
      "bad",
    );
  } catch (error) {
    setStatus(`Não foi possível inserir: ${error?.message || error}`, "bad");
  }
}

/* -------------------------------- Boot -------------------------------- */

function bindEvents() {
  ui.readBtn.addEventListener("click", () => readDocument());
  ui.analyzeBtn.addEventListener("click", () => analyze());
  ui.stopBtn.addEventListener("click", () => state.controller?.abort());
  ui.copyBtn.addEventListener("click", () => copyAnswer());
  ui.insertBtn.addEventListener("click", () => insertAnswer());
  ui.question.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      analyze();
    }
  });
}

(async function boot() {
  bindEvents();
  try {
    await waitForOffice();
    const info = await globalThis.Office.onReady();
    state.officeReady = true;
    state.host = hostLabel(info?.host || globalThis.Office.context?.host);
    ui.hostBadge.textContent = state.host;
    ui.hostBadge.className = "host-badge ok";
    const version = globalThis.Office.context?.diagnostics?.version || "";
    setStatus(
      `Conectado ao ${state.host}${version ? ` (${version})` : ""}. ` +
      "Clique em Ler documento ou em Analisar com IA.",
      "ok",
    );
  } catch (error) {
    // Página aberta fora do Office ou CDN bloqueada: continua útil, sem contexto.
    state.officeReady = false;
    state.host = null;
    ui.hostBadge.textContent = "fora do Office";
    ui.hostBadge.className = "host-badge bad";
    ui.includeDoc.checked = false;
    ui.includeDoc.disabled = true;
    ui.readBtn.disabled = true;
    ui.insertBtn.disabled = true;
    ui.docInfo.textContent = "indisponível";
    setStatus(
      `${error?.message || "Office.js indisponível"} ` +
      "Você ainda pode fazer perguntas sem o documento, ou abrir o chat completo.",
      "bad",
    );
  }
})();
