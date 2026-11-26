// Gem.AI · anexos: leitura no navegador + upload para o Supabase Storage
// Nenhum arquivo passa por um servidor próprio: o front-end extrai texto/imagem,
// envia o original para o Storage (bucket privado, RLS por x-gem-owner) e manda
// ao modelo apenas o que ele consegue entender.
import { CONFIG, getConfig, getStorageUrl } from "./config.js";
import { getOwnerKey } from "./db.js";

const PDFJS_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/";

function uid() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `f-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function safeName(name) {
  return (
    String(name || "arquivo")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 120) || "arquivo"
  );
}

function extension(name) {
  return (String(name).split(".").pop() || "").toLowerCase();
}

function guessKind(file) {
  const ext = extension(file.name);
  const mime = (file.type || "").toLowerCase();
  if (
    mime.startsWith("image/") ||
    ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"].includes(ext)
  ) {
    return "image";
  }
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    CONFIG.textExtensions.includes(ext) ||
    ["application/json", "application/xml", "application/javascript"].includes(mime)
  ) {
    return "text";
  }
  return "binary";
}

export function kindLabel(kind) {
  return { image: "imagem", text: "texto", pdf: "PDF", binary: "arquivo" }[kind] || "arquivo";
}

/** Reduz a imagem antes de virar base64 (limite da Groq: 4 MB / 3 imagens). */
function downscaleImage(file, maxEdge) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
        const drawWidth = Math.max(1, Math.round(image.naturalWidth * scale));
        const drawHeight = Math.max(1, Math.round(image.naturalHeight * scale));
        // A Groq exige pelo menos 32x32 px: imagens minúsculas são centralizadas
        // sobre um fundo branco, sem distorcer a proporção original.
        const width = Math.max(32, drawWidth);
        const height = Math.max(32, drawHeight);
        const offsetX = Math.floor((width - drawWidth) / 2);
        const offsetY = Math.floor((height - drawHeight) / 2);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("não foi possível abrir a imagem"));
    };
    image.src = objectUrl;
  });
}

/** pdf.js é carregado sob demanda, só quando há PDF; falha não impede o anexo. */
async function extractPdfText(file, maxChars) {
  const pdfjs = await import(`${PDFJS_BASE}pdf.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.mjs`;
  const data = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data }).promise;
  const pageCount = Math.min(document.numPages, 20);
  const chunks = [];
  let total = 0;
  for (let index = 1; index <= pageCount; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str || "").join(" ");
    chunks.push(`[página ${index}] ${text}`);
    total += text.length;
    if (total >= maxChars) break;
  }
  document.destroy?.();
  return chunks.join("\n").slice(0, maxChars);
}

/**
 * Valida e prepara os arquivos escolhidos. Nunca lança: devolve avisos amigáveis.
 * Cada item: { id, name, size, type, kind, file, dataUrl?, text?, note? }
 */
export async function processFiles(fileList, existing = []) {
  const config = getConfig();
  const warnings = [];
  const attachments = [];
  const incoming = Array.from(fileList || []);
  let imageCount = existing.filter((item) => item.kind === "image").length;

  for (const file of incoming) {
    if (existing.length + attachments.length >= config.maxFilesPerMessage) {
      warnings.push(`Limite de ${config.maxFilesPerMessage} arquivos por mensagem.`);
      break;
    }
    if (!file.size) {
      warnings.push(`${file.name}: arquivo vazio ignorado.`);
      continue;
    }
    if (file.size > config.maxFileBytes) {
      warnings.push(`${file.name}: maior que ${formatBytes(config.maxFileBytes)}.`);
      continue;
    }
    const kind = guessKind(file);
    if (kind === "image" && imageCount >= config.maxImagesPerMessage) {
      warnings.push(`${file.name}: máximo de ${config.maxImagesPerMessage} imagens por mensagem.`);
      continue;
    }

    const item = {
      id: uid(),
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
      kind,
      file,
    };

    try {
      if (kind === "image") {
        item.dataUrl = await downscaleImage(file, config.imageMaxEdge);
        item.preview = item.dataUrl;
        imageCount += 1;
      } else if (kind === "text") {
        item.text = (await file.text()).slice(0, config.maxExtractChars);
      } else if (kind === "pdf") {
        item.text = await extractPdfText(file, config.maxExtractChars);
        if (!item.text.trim()) {
          item.note = "PDF salvo, mas não deu para extrair o texto (pode ser digitalizado).";
        }
      } else {
        item.note = "Arquivo salvo, mas o modelo não lê este formato diretamente.";
      }
    } catch (error) {
      item.note = `Não foi possível processar: ${error?.message || error}`;
    }

    attachments.push(item);
  }

  return { attachments, warnings };
}

/** Monta o content da mensagem: string (texto) ou array OpenAI (texto + imagens). */
export function buildContent(text, attachments = []) {
  const config = getConfig();
  const images = attachments.filter((item) => item.kind === "image" && item.dataUrl);
  let composed = String(text || "").trim();
  if (!composed && attachments.length) composed = "Analise o(s) arquivo(s) enviado(s).";

  for (const item of attachments) {
    if (item.text && item.text.trim()) {
      composed +=
        `\n\n--- Arquivo: ${item.name} ---\n${item.text.trim()}\n--- Fim do arquivo ---`;
    } else if (item.note) {
      composed += `\n\n[${item.name}: ${item.note}]`;
    }
  }
  composed = composed.slice(0, 60000);

  if (!images.length) return composed;
  return [
    { type: "text", text: composed },
    ...images
      .slice(0, config.maxImagesPerMessage)
      .map((item) => ({ type: "image_url", image_url: { url: item.dataUrl } })),
  ];
}

export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text")
      .map((part) => part.text || "")
      .join("\n\n");
  }
  return String(content ?? "");
}

/** Reconstrói o payload multimodal ao reler uma mensagem do histórico. */
export function messageToPayload(row) {
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  const images = attachments.filter((item) => item?.kind === "image" && item.dataUrl);
  if (!images.length) return row.content || "";
  return [
    { type: "text", text: row.content || "" },
    ...images.map((item) => ({ type: "image_url", image_url: { url: item.dataUrl } })),
  ];
}

function attachmentMetadata(item, path) {
  const meta = {
    name: item.name,
    size: item.size,
    type: item.type,
    kind: item.kind,
    path: path || null,
  };
  if (item.note) meta.note = item.note;
  // Cópia reduzida da imagem no jsonb mantém o contexto em perguntas de follow-up.
  if (item.kind === "image" && item.dataUrl && item.dataUrl.length <= 600000) {
    meta.dataUrl = item.dataUrl;
  }
  return meta;
}

function storageHeaders(extra = {}) {
  const config = getConfig();
  return {
    apikey: config.supabasePublishableKey,
    "x-gem-owner": getOwnerKey(),
    ...extra,
  };
}

/** Base64 UTF-8 para os pares do header Upload-Metadata do TUS. */
function tusEncode(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function storageError(response) {
  const raw = await response.text().catch(() => "");
  let detail = raw.slice(0, 200);
  try {
    const parsed = JSON.parse(raw);
    detail = parsed.message || parsed.error || detail;
  } catch {
    /* resposta em texto puro */
  }
  if (response.status === 413) {
    return (
      `Arquivo acima do limite do Storage (HTTP 413). ${detail} ` +
      `O plano atual aceita até ${formatBytes(getConfig().maxFileBytes)} por arquivo.`
    );
  }
  return `HTTP ${response.status} ${detail}`.trim();
}

/** Upload direto, usado para arquivos pequenos (até ~6 MB). */
async function simpleUpload(path, item) {
  const config = getConfig();
  const response = await fetch(
    `${getStorageUrl()}/object/${config.storageBucket}/${path}`,
    {
      method: "POST",
      headers: storageHeaders({
        "Content-Type": item.type || "application/octet-stream",
        "x-upsert": "false",
      }),
      body: item.file,
    },
  );
  if (!response.ok) throw new Error(await storageError(response));
}

/**
 * Upload resumável TUS em chunks, recomendado para arquivos grandes:
 * mostra progresso, sobrevive melhor a quedas de conexão e NÃO exige JWT —
 * usa apenas apikey + x-gem-owner, como o resto do app.
 * Validado: POST create 201 -> PATCH 204 (offset avança) -> objeto gravado.
 */
async function resumableUpload(path, item, onProgress) {
  const config = getConfig();
  const metadata = [
    `bucketName ${tusEncode(config.storageBucket)}`,
    `objectName ${tusEncode(path)}`,
    `contentType ${tusEncode(item.type || "application/octet-stream")}`,
  ].join(",");

  const create = await fetch(`${getStorageUrl()}/upload/resumable`, {
    method: "POST",
    headers: storageHeaders({
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(item.file.size),
      "Upload-Metadata": metadata,
      "x-upsert": "false",
    }),
  });
  if (!create.ok) throw new Error(await storageError(create));
  const location = create.headers.get("Location") || create.headers.get("location");
  if (!location) throw new Error("O Storage não devolveu a URL de upload resumável.");

  const chunkSize = Math.max(1024 * 1024, config.uploadChunkBytes || 6 * 1024 * 1024);
  let offset = 0;
  while (offset < item.file.size) {
    const end = Math.min(offset + chunkSize, item.file.size);
    const patch = await fetch(location, {
      method: "PATCH",
      headers: storageHeaders({
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
      }),
      body: item.file.slice(offset, end),
    });
    if (!patch.ok) throw new Error(await storageError(patch));
    const next = Number(
      patch.headers.get("Upload-Offset") || patch.headers.get("upload-offset"),
    );
    if (!Number.isFinite(next) || next <= offset) {
      throw new Error("O upload resumável não avançou (offset inválido).");
    }
    offset = next;
    onProgress?.(offset, item.file.size);
  }
}

/** Envia os originais para o bucket privado. Falhas são avisos, não bloqueiam o chat. */
export async function uploadAttachments(conversationId, attachments, onProgress) {
  const config = getConfig();
  const owner = getOwnerKey();
  const metas = [];
  const warnings = [];
  let done = 0;

  for (const item of attachments) {
    const path = `${owner}/${conversationId}/${uid()}-${safeName(item.name)}`;
    const total = item.file?.size || item.size || 0;
    const report = (loaded) =>
      onProgress?.({
        id: item.id,
        name: item.name,
        loaded,
        total,
        index: done,
        count: attachments.length,
      });
    try {
      if (item.file && item.file.size > config.resumableThreshold) {
        await resumableUpload(path, item, report);
      } else {
        await simpleUpload(path, item);
        report(total);
      }
      metas.push(attachmentMetadata(item, path));
    } catch (error) {
      warnings.push(`Não foi possível salvar ${item.name} no Storage: ${error.message}`);
      metas.push(attachmentMetadata(item, null));
    }
    done += 1;
  }

  return { metas, warnings };
}

/** URL temporária para baixar/abrir um arquivo do bucket privado. */
export async function getSignedUrl(path) {
  const config = getConfig();
  const encoded = String(path).split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${getStorageUrl()}/object/sign/${config.storageBucket}/${encoded}`,
    {
      method: "POST",
      headers: storageHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn: 3600 }),
    },
  );
  if (!response.ok) throw new Error(`Não foi possível gerar o link (HTTP ${response.status}).`);
  const payload = await response.json();
  const signed = payload.signedURL || payload.signedUrl;
  if (!signed) throw new Error("O Storage não retornou uma URL assinada.");
  if (signed.startsWith("http")) return signed;
  return `${getStorageUrl()}${signed.startsWith("/") ? "" : "/"}${signed}`;
}

/** Melhor esforço ao apagar uma conversa: remove também os arquivos dela. */
export async function deleteConversationFiles(conversationId) {
  const config = getConfig();
  const owner = getOwnerKey();
  const prefix = `${owner}/${conversationId}`;
  try {
    const response = await fetch(`${getStorageUrl()}/object/list/${config.storageBucket}`, {
      method: "POST",
      headers: storageHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefix, limit: 100, offset: 0 }),
    });
    if (!response.ok) return;
    const items = await response.json();
    for (const item of Array.isArray(items) ? items : []) {
      if (!item?.name) continue;
      // Algumas versões do Storage devolvem só o nome relativo ao prefixo;
      // outras devolvem o caminho completo. Aceita os dois formatos.
      const full = String(item.name).startsWith(`${prefix}/`)
        ? String(item.name)
        : `${prefix}/${item.name}`;
      const encoded = full.split("/").map(encodeURIComponent).join("/");
      await fetch(
        `${getStorageUrl()}/object/${config.storageBucket}/${encoded}`,
        { method: "DELETE", headers: storageHeaders() },
      ).catch(() => {});
    }
  } catch {
    /* limpeza é best-effort */
  }
}
