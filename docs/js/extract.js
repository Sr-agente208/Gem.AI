// Gem.AI · extração de texto 100% local (sem CDN, sem worker, sem dependências)
//
// Motivo: a versão anterior importava pdfjs-dist de cdn.jsdelivr.net. Além de
// depender de rede externa, o pdf.worker.mjs é cross-origin e falha em vários
// navegadores móveis; DOCX/XLSX nem tinham extração. Aqui usamos apenas APIs
// nativas do navegador: DecompressionStream (deflate / deflate-raw) e TextDecoder.
//
// Cobertura: PDF com texto (FlateDecode), DOCX, XLSX, PPTX, ODT/ODS/ODP.
// PDFs digitalizados (só imagem) e fontes com codificação proprietária podem
// não renderizar texto — nesse caso devolvemos "" e a UI avisa o usuário.

const decoderLatin1 = () => new TextDecoder("latin1");
const decoderUtf8 = () => new TextDecoder("utf-8", { fatal: false });

function asLatin1(bytes) {
  return decoderLatin1().decode(bytes);
}

function asUtf8(bytes) {
  return decoderUtf8().decode(bytes).replace(/^\uFEFF/, "");
}

/** Infla um stream DEFLATE. Tenta zlib (deflate) e depois raw (deflate-raw). */
async function inflate(bytes) {
  if (typeof DecompressionStream === "undefined") return null;
  // PDFs sem /Length deixam o EOL final dentro dos dados; o DecompressionStream
  // rejeita "trailing junk". Tentamos o bloco inteiro e depois sem 1-2 bytes.
  for (const cut of [0, 1, 2]) {
    const slice = cut ? bytes.subarray(0, bytes.length - cut) : bytes;
    if (!slice.length) break;
    for (const format of ["deflate", "deflate-raw"]) {
      try {
        const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {
        // formato errado, lixo no fim ou stream corrompido: tenta o próximo
      }
    }
  }
  return null;
}

/* ------------------------------- PDF ------------------------------- */

/** Decodifica os escapes de uma string literal PDF: \( \) \\ \n \ddd. */
function decodePdfString(source) {
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = source[++i];
    if (next === undefined) break;
    const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    if (escapes[next] !== undefined) {
      out += escapes[next];
    } else if (next === "\n" || next === "\r") {
      // quebra de linha escapada: continua na mesma string
    } else if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(source[i + 1] || "")) octal += source[++i];
      out += String.fromCharCode(parseInt(octal, 8));
    } else {
      out += next;
    }
  }
  return out;
}

/** Extrai strings literais ( ... ) e hex <...> de um fluxo de conteúdo PDF. */
function stringsFromContent(raw) {
  const pieces = [];
  // Só blocos de texto BT ... ET, para não capturar binário de imagens.
  const blocks = raw.match(/\bBT\b[\s\S]*?\bET\b/g) || (/\bTj\b|\bTJ\b/.test(raw) ? [raw] : []);
  for (const block of blocks) {
    let current = "";
    // Td / TD / T* movem o cursor: interpretamos como quebra de linha.
    const tokens = block.split(/(T\*|\bTd\b|\bTD\b)/);
    for (const token of tokens) {
      if (/^(?:T\*|Td|TD)$/.test(token)) {
        if (current.trim()) pieces.push(current.trim());
        current = "";
        continue;
      }
      let match;
      const literal = /\(((?:\\.|\\[0-7]{1,3}|[^\\()])*)\)/g;
      while ((match = literal.exec(token)) !== null) {
        const value = decodePdfString(match[1]);
        if (value.trim()) current += `${current ? " " : ""}${value}`;
      }
      const hex = /<([0-9A-Fa-f\s]+)>/g;
      while ((match = hex.exec(token)) !== null) {
        const digits = match[1].replace(/\s+/g, "");
        if (digits.length % 2) continue;
        const bytes = new Uint8Array(digits.length / 2);
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
        const value =
          bytes[0] === 0xfe && bytes[1] === 0xff
            ? new TextDecoder("utf-16be").decode(bytes.subarray(2))
            : asLatin1(bytes);
        if (value.trim()) current += `${current ? " " : ""}${value.trim()}`;
      }
    }
    if (current.trim()) pieces.push(current.trim());
  }
  return pieces.join("\n");
}

/**
 * Lê um PDF e devolve o texto encontrado nos streams de conteúdo.
 * Não interpreta fontes/CMaps: cobre PDFs gerados por navegadores, Word,
 * LibreOffice, reportlab etc. (os casos mais comuns).
 */
export async function extractPdfText(file, maxChars = 20000) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) return "";
  const raw = asLatin1(bytes); // 1 char == 1 byte, offsets permanecem válidos
  if (!raw.startsWith("%PDF") && !raw.includes("%PDF-")) return "";

  const chunks = [];
  let total = 0;
  let streams = 0;
  // \b impede casar o "stream" dentro de "endstream".
  const re = /\bstream\r?\n/g;
  let match;
  while ((match = re.exec(raw)) !== null && streams < 200 && total < maxChars) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    // Avança SEMPRE além do endstream, senão o regex casa nele de novo.
    re.lastIndex = end < 0 ? raw.length : end + 9;
    if (end < 0) break;
    // Dicionário APENAS do objeto atual: a partir do endstream anterior.
    // Usar uma janela fixa de 400 bytes faria o /Length do stream anterior
    // vazar para este (bug em PDFs multipágina).
    const previousEnd = raw.lastIndexOf("endstream", match.index);
    const dictStart = previousEnd >= 0 ? previousEnd + 9 : Math.max(0, match.index - 400);
    const dict = raw.slice(dictStart, match.index);
    if (/\/Subtype\s*\/(?:Image|Type1C|TrueType|CIDFontType0C)|DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode/.test(dict)) {
      continue;
    }
    // /Length dá o tamanho exato. Sem ele, remove só o EOL antes de endstream:
    // o DecompressionStream rejeita "trailing junk", diferente do zlib.
    const declared = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/)?.[1];
    let data;
    if (declared && Number(declared) > 0 && Number(declared) <= end - start) {
      data = bytes.subarray(start, start + Number(declared));
    } else {
      let stop = end;
      if (bytes[stop - 1] === 0x0a) stop -= 1;
      if (bytes[stop - 1] === 0x0d) stop -= 1;
      data = bytes.subarray(start, stop);
    }
    if (/\/FlateDecode/.test(dict)) {
      const inflated = await inflate(data);
      if (!inflated) continue;
      data = inflated;
    }
    streams += 1;
    const text = stringsFromContent(asLatin1(data));
    if (text && text.trim()) {
      chunks.push(text);
      total += text.length;
    }
  }

  return chunks.join("\n").replace(/[ \t]{2,}/g, " ").slice(0, maxChars).trim();
}

/* ------------------------------- ZIP ------------------------------- */

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

/** Lê o diretório central de um ZIP (DOCX/XLSX/PPTX/ODT são ZIPs). */
async function zipEntries(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i -= 1) {
    if (u32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP inválido (sem diretório central)");

  const count = u16(view, eocd + 10);
  let cursor = u32(view, eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count && cursor + 46 <= bytes.length; i += 1) {
    if (u32(view, cursor) !== 0x02014b50) break;
    const method = u16(view, cursor + 10);
    const compSize = u32(view, cursor + 20);
    const nameLen = u16(view, cursor + 28);
    const extraLen = u16(view, cursor + 30);
    const commentLen = u16(view, cursor + 32);
    const local = u32(view, cursor + 42);
    const name = asUtf8(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    entries.set(name, { method, compSize, local });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return { bytes, view, entries };
}

async function zipRead(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return null;
  const { bytes, view } = zip;
  const base = entry.local;
  if (base + 30 > bytes.length || u32(view, base) !== 0x04034b50) return null;
  const start = base + 30 + u16(view, base + 26) + u16(view, base + 28);
  const data = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    const inflated = await inflate(data.subarray(0));
    return inflated;
  }
  return null; // método de compressão não suportado
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 0))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d) || 0))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function xmlText(xml) {
  return decodeEntities(xml.replace(/<[^>]*>/g, " ")).replace(/[ \t]{2,}/g, " ").trim();
}

/** Junta os nós <w:t> respeitando parágrafos (<w:p>) e tabulações (<w:tab/>). */
function docxText(xml) {
  return decodeEntities(
    xml
      .replace(/<w:tab\s*\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:br\s*\/>/g, "\n")
      .replace(/<\/w:t>/g, " ")
      .replace(/<[^>]*>/g, ""),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function xlsxText(zip, sharedXml, sheetXmls) {
  const shared = [];
  if (sharedXml) {
    for (const si of sharedXml.match(/<si\b[\s\S]*?<\/si>/g) || []) {
      shared.push(xmlText(si));
    }
  }
  const lines = [];
  for (const xml of sheetXmls) {
    for (const row of xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const cell of row.match(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || []) {
        const isShared = /\bt="s"/.test(cell);
        const value = (cell.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const inline = cell.match(/<is>[\s\S]*?<\/is>/)?.[0];
        let out = "";
        if (isShared && value !== undefined) out = shared[Number(value)] ?? "";
        else if (inline) out = xmlText(inline);
        else if (value !== undefined) out = value;
        cells.push(out);
      }
      const line = cells.join("\t").trim();
      if (line) lines.push(line);
    }
  }
  return lines.join("\n");
}

/**
 * Extrai texto de documentos Office / OpenDocument.
 * Devolve "" quando não encontra nada (a UI transforma isso em aviso claro).
 */
export async function extractOfficeText(file, maxChars = 20000) {
  const zip = await zipEntries(file);
  const name = String(file.name || "").toLowerCase();
  const read = (n) => zipRead(zip, n).then((b) => (b ? asUtf8(b) : null));

  if (name.endsWith(".docx")) {
    const xml = await read("word/document.xml");
    return (xml ? docxText(xml) : "").slice(0, maxChars);
  }
  if (name.endsWith(".xlsx")) {
    const shared = await read("xl/sharedStrings.xml");
    const sheets = [];
    for (const entry of zip.entries.keys()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(entry)) {
        const xml = await read(entry);
        if (xml) sheets.push(xml);
      }
    }
    return xlsxText(zip, shared, sheets).slice(0, maxChars);
  }
  if (name.endsWith(".pptx")) {
    const parts = [];
    for (const entry of [...zip.entries.keys()].sort()) {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(entry)) {
        const xml = await read(entry);
        if (xml) {
          const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeEntities(m[1]));
          if (texts.length) parts.push(`[slide ${parts.length + 1}] ${texts.join(" ")}`);
        }
      }
    }
    return parts.join("\n").slice(0, maxChars);
  }
  // ODT / ODS / ODP
  const xml = await read("content.xml");
  if (!xml) return "";
  return xmlText(
    xml
      .replace(/<\/(?:text:p|text:h|table:table-row)>/g, "\n")
      .replace(/<table:table-cell\b[^>]*>/g, "\t"),
  ).slice(0, maxChars);
}

/** Extensões que agora têm extração real de texto. */
export const OFFICE_EXTENSIONS = [
  "docx", "xlsx", "pptx", "odt", "ods", "odp",
];

export const OFFICE_MIMES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
];

export function isOffice(name, mime = "") {
  const ext = String(name).split(".").pop().toLowerCase();
  return OFFICE_EXTENSIONS.includes(ext) || OFFICE_MIMES.includes(String(mime).toLowerCase());
}
