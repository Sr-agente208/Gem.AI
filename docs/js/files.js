// Gem.AI · anexos: leitura no navegador + upload para o Supabase Storage
// Nenhum arquivo passa por um servidor próprio: o front-end extrai texto/imagem,
// envia o original para o Storage (bucket privado, RLS por x-gem-owner) e manda
// ao modelo apenas o que ele consegue entender.
import { CONFIG, getConfig, getStorageUrl } from "./config.js";
import { getOwnerKey } from "./db.js";
import { extractPdfText, extractOfficeText, isOffice } from "./extract.js";

function uid() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `f-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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
    ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "heic", "heif"].includes(ext)
  ) {
    return "image";
  }
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (isOffice(file.name, mime)) return "office";
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
  return {
    image: "imagem", text: "texto", pdf: "PDF", office: "documento", binary: "arquivo",
  }[kind] || "arquivo";
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
      if (file.size > config.maxProcessBytes) {
        // Evita carregar 1 GiB na memoria do navegador so para extrair texto.
        item.note = `Arquivo grande (${formatBytes(file.size)}): salvo por partes, sem leitura no navegador.`;
      } else if (kind === "image") {
        item.dataUrl = await downscaleImage(file, config.imageMaxEdge);
        item.preview = item.dataUrl;
        imageCount += 1;
      } else if (kind === "text") {
        item.text = (await file.text()).slice(0, config.maxExtractChars);
        item.extracted = item.text.length;
      } else if (kind === "pdf" || kind === "office") {
        // Extratores nativos (DecompressionStream + parser de streams/ZIP),
        // sem CDN e sem worker cross-origin.
        const text =
          kind === "pdf"
            ? await extractPdfText(file, config.maxExtractChars)
            : await extractOfficeText(file, config.maxExtractChars);
        item.text = (text || "").slice(0, config.maxExtractChars);
        if (!item.text.trim()) {
          item.note =
            kind === "pdf"
              ? "Não deu para ler o texto deste PDF (provavelmente digitalizado). Envie uma foto/PNG da página para análise visual."
              : "Não deu para ler o texto deste documento. Tente salvar como .txt/.csv ou PDF com texto.";
        } else {
          item.extracted = item.text.length;
        }
      } else {
        item.note =
          `Formato .${extension(file.name)} sem leitura de texto. Converta para TXT/CSV, ` +
          "PDF com texto, DOCX/XLSX ou envie uma imagem para análise visual.";
      }
    } catch (error) {
      // Fotos do iPhone saem como HEIC. O Safari costuma decodificar, mas
      // Chrome/Android e WebViews não: <img>/canvas falha. Em vez de mandar
      // base64 inválido à Groq (ou ocupar uma das 3 vagas de visão), mantemos
      // o original no Storage/download e avisamos que a análise visual
      // requer JPEG/PNG.
      const isHeic =
        ["heic", "heif"].includes(extension(file.name)) || /heic|heif/i.test(file.type || "");
      if (kind === "image" && isHeic) {
        item.kind = "binary";
        item.note =
          "Foto HEIC anexada: este navegador não consegue convertê-la para o modelo. " +
          "Envie como JPEG/PNG para análise visual (o arquivo original continua disponível).";
      } else {
        item.note = `Não foi possível processar: ${error?.message || error}`;
      }
    }

    attachments.push(item);
  }

  return { attachments, warnings };
}

/** Monta o content da mensagem: string (texto) ou array OpenAI (texto + imagens). */
export function buildContent(text, attachments = []) {
  const config = getConfig();
  const images = attachments.filter((item) => item.kind === "image" && item.dataUrl);
  const readable = attachments.filter((item) => item.text && item.text.trim());
  const unreadable = attachments.filter((item) => !item.text?.trim() && item.note);
  let composed = String(text || "").trim();

  // Instrução explícita: sem ela o modelo tende a responder "não tenho acesso
  // ao arquivo" mesmo com o conteúdo colado logo abaixo.
  if (readable.length) {
    composed =
      (composed ? `${composed}\n\n` : "") +
      `O usuário anexou ${readable.length} arquivo(s) cujo conteúdo está transcrito abaixo. ` +
      "ANALISE esse conteúdo, responda com base nele e cite trechos quando útil. " +
      "Não diga que não tem acesso aos arquivos.";
  } else if (!composed && attachments.length) {
    composed = "Analise o(s) arquivo(s) enviado(s).";
  }

  // Reparte o teto de 60 mil caracteres entre os arquivos: sem isso, o 5º
  // anexo era simplesmente cortado pelo slice() final.
  const budget = Math.max(4000, 58000 - composed.length - unreadable.length * 300);
  const perFile = Math.max(1500, Math.floor(budget / Math.max(1, readable.length)));
  for (const item of readable) {
    const body = item.text.trim();
    const clipped = body.length > perFile;
    composed +=
      `\n\n--- Arquivo: ${item.name} (${body.length} caracteres lidos` +
      `${clipped ? `, trecho de ${perFile}` : ""}) ---\n` +
      `${body.slice(0, perFile)}${clipped ? "\n[… trecho restante omitido]" : ""}` +
      "\n--- Fim do arquivo ---";
  }
  for (const item of unreadable) {
    // Deixa claro ao modelo que NÃO deve inventar o conteúdo.
    composed +=
      `\n\n[${item.name}: conteúdo NÃO disponível — ${item.note} ` +
      "Não invente o que havia neste arquivo; avise o usuário e sugira outro formato.]";
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

function attachmentMetadata(item, path, parts) {
  const meta = {
    name: item.name,
    size: item.size,
    type: item.type,
    kind: item.kind,
    path: path || null,
  };
  // Arquivos maiores que o teto por objeto viram varias partes no Storage.
  if (parts && parts.length) meta.parts = parts;
  if (item.note) meta.note = item.note;
  if (item.extracted) meta.extracted = item.extracted;
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

/** Upload direto, usado para blobs pequenos (até ~6 MB). */
async function simpleUpload(path, blob, type) {
  const config = getConfig();
  const response = await fetch(
    `${getStorageUrl()}/object/${config.storageBucket}/${path}`,
    {
      method: "POST",
      headers: storageHeaders({
        "Content-Type": type || "application/octet-stream",
        "x-upsert": "false",
      }),
      body: blob,
    },
  );
  if (!response.ok) throw new Error(await storageError(response));
}

/**
 * Upload resumável TUS em chunks, recomendado para blobs grandes:
 * mostra progresso e NÃO exige JWT — usa apenas apikey + x-gem-owner.
 * Validado: POST create 201 -> PATCH 204 (offset avança) -> objeto gravado.
 */
async function resumableUpload(path, blob, size, type, onProgress) {
  const config = getConfig();
  const metadata = [
    `bucketName ${tusEncode(config.storageBucket)}`,
    `objectName ${tusEncode(path)}`,
    `contentType ${tusEncode(type || "application/octet-stream")}`,
  ].join(",");

  const create = await fetch(`${getStorageUrl()}/upload/resumable`, {
    method: "POST",
    headers: storageHeaders({
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(size),
      "Upload-Metadata": metadata,
      "x-upsert": "false",
    }),
  });
  if (!create.ok) throw new Error(await storageError(create));
  const location = create.headers.get("Location") || create.headers.get("location");
  if (!location) throw new Error("O Storage não devolveu a URL de upload resumável.");

  const chunkSize = Math.max(1024 * 1024, config.uploadChunkBytes || 6 * 1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const end = Math.min(offset + chunkSize, size);
    const patch = await fetch(location, {
      method: "PATCH",
      headers: storageHeaders({
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
      }),
      body: blob.slice(offset, end),
    });
    if (!patch.ok) throw new Error(await storageError(patch));
    const next = Number(
      patch.headers.get("Upload-Offset") || patch.headers.get("upload-offset"),
    );
    if (!Number.isFinite(next) || next <= offset) {
      throw new Error("O upload resumável não avançou (offset inválido).");
    }
    offset = next;
    onProgress?.(offset, size);
  }
}

async function uploadOne(path, blob, size, type, onProgress) {
  const config = getConfig();
  if (size > config.resumableThreshold) {
    await resumableUpload(path, blob, size, type, onProgress);
  } else {
    await simpleUpload(path, blob, type);
    onProgress?.(size, size);
  }
}

/**
 * Envia os originais para o bucket privado. Arquivos acima do teto por OBJETO
 * do plano (50 MiB no Free) sao divididos em varias partes e recompostos no
 * download. Falhas sao avisos, nao bloqueiam o chat.
 */
export async function uploadAttachments(conversationId, attachments, onProgress) {
  const config = getConfig();
  const owner = getOwnerKey();
  const metas = [];
  const warnings = [];
  let done = 0;

  for (const item of attachments) {
    const basePath = `${owner}/${conversationId}/${uid()}-${safeName(item.name)}`;
    const total = item.file?.size || item.size || 0;
    const partSize = Math.min(config.storagePartBytes, config.maxFileBytes);
    const partCount = Math.max(1, Math.ceil(total / partSize));
    const parts = [];
    const report = (loadedInPart, partIndex) =>
      onProgress?.({
        id: item.id,
        name: item.name,
        loaded: Math.min(total, partIndex * partSize + loadedInPart),
        total,
        index: done,
        count: attachments.length,
        part: partIndex + 1,
        parts: partCount,
      });

    try {
      if (partCount === 1) {
        await uploadOne(basePath, item.file, total, item.type, (loaded) => report(loaded, 0));
        metas.push(attachmentMetadata(item, basePath));
      } else {
        for (let index = 0; index < partCount; index += 1) {
          const start = index * partSize;
          const end = Math.min(start + partSize, total);
          const blob = item.file.slice(start, end);
          const partPath = `${basePath}.part${String(index + 1).padStart(4, "0")}`;
          await uploadOne(partPath, blob, end - start, item.type, (loaded) =>
            report(loaded, index),
          );
          parts.push({ path: partPath, size: end - start });
        }
        metas.push(attachmentMetadata(item, null, parts));
      }
    } catch (error) {
      warnings.push(`Não foi possível salvar ${item.name} no Storage: ${error.message}`);
      metas.push(attachmentMetadata(item, null, parts));
    }
    done += 1;
  }

  return { metas, warnings };
}

/** Baixa todas as partes, recombina e dispara o download com o nome original. */
export async function downloadAttachment(meta) {
  const paths =
    Array.isArray(meta.parts) && meta.parts.length
      ? meta.parts.map((part) => part.path)
      : meta.path
        ? [meta.path]
        : [];
  if (!paths.length) throw new Error("Este anexo não foi salvo no Storage.");

  const blobs = [];
  for (const path of paths) {
    const url = await getSignedUrl(path);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Falha ao baixar uma parte do arquivo (HTTP ${response.status}).`);
    }
    blobs.push(await response.blob());
  }

  const blob = new Blob(blobs, { type: meta.type || "application/octet-stream" });
  const objectUrl = URL.createObjectURL(blob);
  const revoke = () => setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  const name = meta.name || "arquivo";

  // Web Share API: no iOS é a forma confiável de "Salvar em Arquivos" e no
  // Android abre a folha nativa de compartilhamento. Só tentamos quando a
  // ativação do toque ainda é válida (os fetches acima podem demorar) e para
  // arquivos pequenos — compartilhar 1 GiB não é suportado pelos sistemas.
  let canShare = false;
  let shareFile = null;
  try {
    if (
      blob.size <= 50 * 1024 * 1024 &&
      typeof navigator.share === "function" &&
      typeof navigator.canShare === "function" &&
      navigator.userActivation?.isActive !== false
    ) {
      shareFile = new File([blob], name, { type: meta.type || "application/octet-stream" });
      canShare = navigator.canShare({ files: [shareFile] });
    }
  } catch {
    canShare = false; // navegador sem suporte a compartilhar arquivos
  }
  if (canShare) {
    try {
      await navigator.share({ files: [shareFile], title: name });
      revoke();
      return { bytes: blob.size, parts: paths.length, via: "share" };
    } catch (error) {
      if (error?.name === "AbortError") {
        revoke();
        return { bytes: blob.size, parts: paths.length, via: "cancelled" };
      }
      // Sem ativação, sem app de destino etc.: cai no download clássico.
    }
  }

  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  try {
    link.click();
  } catch {
    // WebViews in-app (Instagram/WhatsApp) não disparam download por click().
    window.open(objectUrl, "_blank", "noopener,noreferrer");
  }
  link.remove();
  revoke();
  return { bytes: blob.size, parts: paths.length };
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
