// Gem.AI · formatos Office legados e RTF, 100% locais
//
// .doc / .xls / .ppt / .msg são OLE2 Compound Files (CFB/MS-CFB): um "sistema
// de arquivos" dentro do arquivo, com FAT, mini-FAT e diretório de streams.
// Este módulo implementa o leitor mínimo e extrai texto de:
//   • Word 97-2003  (.doc)  -> piece table (CLX/PlcPcd) no stream 0Table/1Table
//   • Excel 97-2003 (.xls)  -> records BIFF8 (SST, LABELSST, NUMBER, RK, MULRK)
//   • PowerPoint 97 (.ppt)  -> atoms TextCharsAtom / TextBytesAtom
//   • Outlook      (.msg)  -> streams __substg1.0_*
//   • Rich Text    (.rtf)  -> controle RTF + \uN unicode
//
// É "melhor esforço": não interpreta formatação, macros, OLE embutido nem
// criptografia. Validado contra fixtures reais do Apache POI.

const dec1252 = () => new TextDecoder("windows-1252");
const decUtf16 = () => new TextDecoder("utf-16le", { fatal: false });
const decUtf8 = () => new TextDecoder("utf-8", { fatal: false });

function clean(text) {
  return String(text || "")
    // \x07 = fim de célula (tabela Word), \x0B = quebra de linha, \r = parágrafo
    .replace(/\u0007/g, "\t")
    .replace(/[\u000B\u000C\r]/g, "\n")
    .replace(/[\u0000-\u0006\u0008\u000E-\u001F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{3,}/g, "  ")
    .trim();
}

/* --------------------------- Leitor OLE2 / CFB --------------------------- */

function u16at(b, o) { return b[o] | (b[o + 1] << 8); }
function u32at(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

function readCfb(bytes) {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (!sig.every((v, i) => bytes[i] === v)) throw new Error("não é um arquivo OLE2/Office legado");
  const sectorSize = 1 << u16at(bytes, 0x1e);
  const miniSize = 1 << u16at(bytes, 0x20);
  const cutoff = u32at(bytes, 0x38);
  const nFat = u32at(bytes, 0x2c);
  const dirStart = u32at(bytes, 0x30);
  const miniFatStart = u32at(bytes, 0x3c);
  const nMiniFat = u32at(bytes, 0x40);
  const difatStart = u32at(bytes, 0x44);
  const nDifat = u32at(bytes, 0x48);

  const sector = (id) => bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);

  // DIFAT: 109 entradas no header + setores encadeados
  const fatIds = [];
  for (let i = 0; i < 109; i += 1) {
    const v = u32at(bytes, 0x4c + i * 4);
    if (v !== FREESECT && v !== ENDOFCHAIN) fatIds.push(v);
  }
  let d = difatStart;
  for (let n = 0; n < nDifat && d < ENDOFCHAIN; n += 1) {
    const s = sector(d);
    for (let i = 0; i < sectorSize / 4 - 1; i += 1) {
      const v = u32at(s, i * 4);
      if (v !== FREESECT && v !== ENDOFCHAIN) fatIds.push(v);
    }
    d = u32at(s, sectorSize - 4);
  }

  // FAT completa (fatIds já vem filtrado de FREESECT/ENDOFCHAIN)
  const fat = [];
  for (const id of fatIds) {
    const s = sector(id);
    for (let i = 0; i < sectorSize; i += 4) fat.push(u32at(s, i));
  }

  function chain(start, fatTable = fat, get = sector, size = sectorSize) {
    const out = [];
    let cur = start;
    let guard = 0;
    while (cur < ENDOFCHAIN && guard < 100000 && out.length * size < 64 * 1024 * 1024) {
      out.push(get(cur));
      cur = fatTable[cur] ?? ENDOFCHAIN;
      guard += 1;
    }
    const total = out.reduce((n, part) => n + part.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const part of out) { buf.set(part, off); off += part.length; }
    return buf;
  }

  const dir = chain(dirStart);
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = u16at(dir, o + 0x40);
    if (nameLen < 2 || nameLen > 64) { entries.push(null); continue; }
    const rawName = dir.subarray(o, o + nameLen - 2);
    let name = "";
    for (let i = 0; i < rawName.length; i += 2) name += String.fromCharCode(u16at(rawName, i));
    entries.push({
      name,
      type: dir[o + 0x42],
      start: u32at(dir, o + 0x74),
      size: u32at(dir, o + 0x78),
    });
  }

  const root = entries.find((e) => e && e.type === 5) || entries[0];
  const miniStream = root ? chain(root.start) : new Uint8Array(0);
  const miniFatBytes = chain(miniFatStart);
  const miniFat = [];
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(u32at(miniFatBytes, i));
  const miniGet = (id) => miniStream.subarray(id * miniSize, (id + 1) * miniSize);

  function stream(wanted) {
    const norm = (s) => s.replace(/^[\u0000-\u0006]/, "").toLowerCase();
    const entry = entries.find((e) => e && e.type === 2 && norm(e.name) === norm(wanted));
    if (!entry || !entry.size) return null;
    const big = entry.size >= cutoff;
    const data = chain(entry.start, big ? fat : miniFat, big ? sector : miniGet, big ? sectorSize : miniSize);
    return data.subarray(0, Math.min(entry.size, data.length));
  }
  function streams() {
    return entries.filter((e) => e && e.type === 2).map((e) => e.name);
  }
  return { stream, streams };
}

/* ------------------------------- Word .doc ------------------------------- */

function findClx(table) {
  // CLX = [Grpprl*] (0x01 + cb(u16) + dados) + 0x02 + lcb(u32) + PlcPcd
  let o = 0;
  while (o < table.length && table[o] === 0x01) {
    const cb = u16at(table, o + 1);
    o += 3 + cb;
  }
  if (table[o] !== 0x02) return null;
  const len = u32at(table, o + 1);
  return table.subarray(o + 5, o + 5 + len);
}

export async function extractDoc(file, maxChars = 20000) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const cfb = readCfb(bytes);
  const word = cfb.stream("WordDocument");
  if (!word) return "";
  const flags = u16at(word, 0x0a);
  const tableName = flags & 0x0200 ? "1Table" : "0Table";
  const table = cfb.stream(tableName) || cfb.stream("0Table") || cfb.stream("1Table");
  if (!table) return "";

  // Localiza fcClx/lcbClx no FibRgFcLcb97 (par de índice 33).
  let o = 0x20;
  const csw = u16at(word, o); o += 2 + csw * 2;
  const cslw = u16at(word, o); o += 2 + cslw * 4;
  const cbRgFcLcb = u16at(word, o); o += 2;
  const pair = 33;
  if (cbRgFcLcb <= pair) return "";
  const fcClx = u32at(word, o + pair * 8);
  const lcbClx = u32at(word, o + pair * 8 + 4);
  if (!lcbClx || fcClx + lcbClx > table.length) {
    // Alguns documentos (Word 6/95) guardam o texto direto em fcMin..fcMac.
    return clean(dec1252().decode(word.subarray(0x100, Math.min(word.length, 0x100 + maxChars))));
  }
  const plc = findClx(table.subarray(fcClx, fcClx + lcbClx));
  if (!plc || plc.length < 16) return "";

  const n = Math.floor((plc.length - 4) / 12);
  const cps = [];
  for (let i = 0; i <= n; i += 1) cps.push(u32at(plc, i * 4));
  const pcdBase = (n + 1) * 4;
  let text = "";
  for (let i = 0; i < n && text.length < maxChars; i += 1) {
    const len = Math.max(0, cps[i + 1] - cps[i]);
    if (!len) continue;
    const pcd = pcdBase + i * 8;
    const fc = u32at(plc, pcd + 2);
    const compressed = (fc & 0x40000000) !== 0;
    const offset = (fc & 0x3fffffff) / (compressed ? 2 : 1);
    const start = Math.round(offset);
    if (compressed) {
      text += dec1252().decode(word.subarray(start, start + len));
    } else {
      text += decUtf16().decode(word.subarray(start, start + len * 2));
    }
  }
  return clean(text).slice(0, maxChars);
}

/* ------------------------------- Excel .xls ------------------------------ */

function rkNumber(rk) {
  let value;
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  if (rk & 0x02) {
    value = (rk >> 2) | 0;
  } else {
    view.setUint32(0, 0, true);
    view.setUint32(4, rk & 0xfffffffc, true);
    value = view.getFloat64(0, true);
  }
  if (rk & 0x01) value /= 100;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function biffString(data, o) {
  const cch = u16at(data, o);
  const flags = data[o + 2];
  let p = o + 3;
  let cRun = 0;
  let cbExt = 0;
  if (flags & 0x08) { cRun = u16at(data, p); p += 2; }
  if (flags & 0x04) { cbExt = u32at(data, p); p += 4; }
  const wide = flags & 0x01;
  const len = cch * (wide ? 2 : 1);
  const value = wide
    ? decUtf16().decode(data.subarray(p, p + len))
    : dec1252().decode(data.subarray(p, p + len));
  return { value, next: p + len + cRun * 4 + cbExt };
}

export async function extractXls(file, maxChars = 20000) {
  const cfb = readCfb(new Uint8Array(await file.arrayBuffer()));
  const wb = cfb.stream("Workbook") || cfb.stream("Book");
  if (!wb) return "";

  // Records BIFF: id(u16) + size(u16) + dados. CONTINUE é anexado ao SST.
  const records = [];
  for (let o = 0; o + 4 <= wb.length;) {
    const id = u16at(wb, o);
    const size = u16at(wb, o + 2);
    if (o + 4 + size > wb.length) break;
    records.push({ id, data: wb.subarray(o + 4, o + 4 + size) });
    o += 4 + size;
  }

  const shared = [];
  const sheets = [];
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    if (r.id === 0x0085) { // BOUNDSHEET
      const cch = r.data[6];
      const flags = r.data[7];
      sheets.push({
        pos: u32at(r.data, 0),
        name: (flags & 0x01)
          ? decUtf16().decode(r.data.subarray(8, 8 + cch * 2))
          : dec1252().decode(r.data.subarray(8, 8 + cch)),
      });
    }
    if (r.id === 0x00fc) { // SST
      let blob = r.data;
      let j = i + 1;
      while (j < records.length && records[j].id === 0x003c) {
        const part = records[j].data;
        const merged = new Uint8Array(blob.length + part.length);
        merged.set(blob); merged.set(part, blob.length);
        blob = merged; j += 1;
      }
      const total = u32at(blob, 4);
      let p = 8;
      for (let k = 0; k < total && p + 3 <= blob.length; k += 1) {
        const s = biffString(blob, p);
        shared.push(s.value);
        p = s.next;
        if (p <= 8) break;
      }
    }
  }

  const rows = new Map();
  const add = (row, col, value) => {
    if (!value) return;
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row).set(col, String(value).trim());
  };
  for (let ri = 0; ri < records.length; ri += 1) {
    const r = records[ri];
    const d = r.data;
    switch (r.id) {
      case 0x00fd: // LABELSST
        if (d.length >= 10) add(u16at(d, 0), u16at(d, 2), shared[u32at(d, 6)]);
        break;
      case 0x0204: { // LABEL (BIFF5/8 string inline)
        if (d.length >= 8) {
          const s = biffString(d, 6);
          add(u16at(d, 0), u16at(d, 2), s.value);
        }
        break;
      }
      case 0x0203: // NUMBER
        if (d.length >= 14) {
          const v = new DataView(d.buffer, d.byteOffset, d.byteLength).getFloat64(6, true);
          add(u16at(d, 0), u16at(d, 2), Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6))));
        }
        break;
      case 0x027e: // RK
        if (d.length >= 10) add(u16at(d, 0), u16at(d, 2), rkNumber(u32at(d, 6)));
        break;
      case 0x00bd: { // MULRK
        if (d.length >= 6) {
          const row = u16at(d, 0), first = u16at(d, 2);
          const count = Math.floor((d.length - 6) / 6);
          for (let k = 0; k < count; k += 1) {
            add(row, first + k, rkNumber(u32at(d, 4 + k * 6 + 2)));
          }
        }
        break;
      }
      case 0x0207: { // STRING (resultado de fórmula): usa a linha/col da FORMULA anterior
        const prev = records[ri - 1]?.data;
        if (d.length >= 3 && prev && prev.length >= 6) {
          const s = biffString(d, 0);
          add(u16at(prev, 0), u16at(prev, 2), s.value);
        }
        break;
      }
      case 0x0205: // BOOLERR
        if (d.length >= 8) add(u16at(d, 0), u16at(d, 2), d[6] ? (d[7] ? "VERDADEIRO" : "FALSO") : "ERRO");
        break;
      default: break;
    }
  }

  const lines = [];
  if (sheets.length) lines.push(`[planilhas: ${sheets.map((s) => s.name).join(", ")}]`);
  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const cells = rows.get(row);
    const last = Math.max(...cells.keys());
    const line = [];
    for (let c = 0; c <= last; c += 1) line.push(cells.get(c) || "");
    if (line.some(Boolean)) lines.push(line.join("\t").trimEnd());
    if (lines.join("\n").length > maxChars) break;
  }
  return clean(lines.join("\n")).slice(0, maxChars);
}

/* ---------------------------- PowerPoint .ppt ---------------------------- */

export async function extractPpt(file, maxChars = 20000) {
  const cfb = readCfb(new Uint8Array(await file.arrayBuffer()));
  const doc = cfb.stream("PowerPoint Document");
  if (!doc) return "";
  const texts = [];
  function walk(start, end, depth) {
    if (depth > 24) return;
    let o = start;
    while (o + 8 <= end) {
      const verInst = u16at(doc, o);
      const type = u16at(doc, o + 2);
      const len = u32at(doc, o + 4);
      const body = o + 8;
      if (len > doc.length || body + len > end + 8) break;
      if ((verInst & 0x000f) === 0x000f) {
        walk(body, body + len, depth + 1); // container
      } else if (type === 0x0fa0) {
        texts.push(clean(decUtf16().decode(doc.subarray(body, body + len))));
      } else if (type === 0x0fa8) {
        texts.push(clean(dec1252().decode(doc.subarray(body, body + len))));
      }
      o = body + len;
    }
  }
  walk(0, doc.length, 0);
  const filtered = texts
    .filter(Boolean)
    // Slide master / layout trazem textos-modelo que não são conteúdo real.
    .filter((t) => !/^Click to edit Master/i.test(t) && !/^(?:Second|Third|Fourth|Fifth) level$/i.test(t))
    .map((t) => t.replace(/^\*+$/gm, "").trim())
    .filter(Boolean);
  return clean(filtered.join("\n")).slice(0, maxChars);
}

/* ------------------------------ Outlook .msg ----------------------------- */

export async function extractMsg(file, maxChars = 20000) {
  const cfb = readCfb(new Uint8Array(await file.arrayBuffer()));
  const parts = [];
  // O sufixo do stream indica o tipo (001F = Unicode, 0102 = binário/ANSI,
  // 001E = ASCII, 1013 = HTML). Varremos o que existir em vez de fixar dois.
  const available = cfb.streams();
  const read = (id) => {
    const candidates = available.filter((n) =>
      new RegExp(`^__substg1\\.0_${id}`, "i").test(n.replace(/^[\u0000-\u0006]/, "")),
    );
    for (const name of candidates.sort((a, b) => (a.includes("001F") ? -1 : b.includes("001F") ? 1 : 0))) {
      const b = cfb.stream(name);
      if (!b || !b.length) continue;
      const unicode = /001F$/i.test(name);
      let value = clean(unicode ? decUtf16().decode(b) : dec1252().decode(b));
      if (/1013|HTML/i.test(name)) value = value.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ");
      if (value) return value;
    }
    return "";
  };
  for (const [label, id] of [
    ["Assunto", "0037"], ["De", "0C1A"], ["Para", "0E04"],
    ["Corpo", "1000"], ["Corpo HTML", "1013"],
  ]) {
    const value = read(id);
    if (value && !parts.some((p) => p.endsWith(value))) parts.push(`${label}: ${value}`);
  }
  return parts.join("\n").slice(0, maxChars);
}

/* --------------------------------- RTF ---------------------------------- */

export async function extractRtf(file, maxChars = 20000) {
  const raw = new TextDecoder("windows-1252").decode(new Uint8Array(await file.arrayBuffer()));
  if (!/^\s*\{\s*\\rtf\d/.test(raw)) return "";
  let out = "";
  let i = 0;
  const IGNORE = new Set([
    "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "footer",
    "listtable", "listoverridetable", "generator", "themedata", "datastore", "xmlnstbl",
  ]);

  // Pula até fechar o grupo atual (começamos dentro dele).
  const skipGroup = () => {
    let depth = 1;
    while (depth > 0 && i < raw.length) {
      const c = raw[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      i += 1;
    }
  };

  while (i < raw.length && out.length < maxChars * 2) {
    const ch = raw[i];
    if (ch === "{" || ch === "}" || ch === "\r" || ch === "\n") { i += 1; continue; }
    if (ch !== "\\") { out += ch; i += 1; continue; }

    const rest = raw.slice(i);
    const m = /^\\([a-zA-Z]+)(-?\d+)? ?|^\\'([0-9a-fA-F]{2})|^\\(.)/.exec(rest);
    if (!m) { i += 1; continue; }
    const word = m[1] || "";
    const param = m[2];
    const hexByte = m[3];
    const literal = m[4];
    i += m[0].length;

    if (hexByte) {
      out += String.fromCharCode(parseInt(hexByte, 16));
    } else if (word === "u" && param) {
      const cp = ((Number(param) + 65536) % 65536) || 63;
      out += String.fromCodePoint(cp);
      if (raw[i] === "?") i += 1; // caractere de fallback
    } else if (word === "par" || word === "line" || word === "sect" || word === "page") {
      out += "\n";
    } else if (word === "tab") {
      out += "\t";
    } else if (word === "*" || IGNORE.has(word)) {
      skipGroup();
    } else if (literal === "\\" || literal === "{" || literal === "}") {
      out += literal;
    }
    // \b \i \fs24 \ansi etc. são só formatação: ignorados sem descartar texto.
  }
  return clean(out).slice(0, maxChars);
}

export function isCfb(bytes) {
  return bytes.length >= 8 &&
    bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1;
}
