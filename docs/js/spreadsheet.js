// Gem.AI · pré-análise estatística de planilhas, calculada no navegador
//
// O extrator já entrega a planilha em texto tabulado. Aqui calculamos, antes de
// mandar ao modelo, um resumo com tipos de coluna, soma, média, mínimo, máximo
// e valores mais frequentes. Isso evita que a IA "chute" totais e dá números
// conferíveis para perguntas tipo "qual o total?".
// Nenhuma biblioteca: só parse de texto e aritmética.

function splitRow(line) {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  return line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
}

/** Aceita 1234 · 1.234,56 (BR) · 1,234.56 (US) · R$ 1.234,56 · 12%. */
export function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s || s.includes("=")) return null; // "cb=1" é fórmula/rótulo, não número
  s = s.replace(/R\$|\s|%|º/g, "").replace(/[()]/g, "");
  if (!/^[-+]?[\d.,]+$/.test(s)) return null;
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  if (hasDot && hasComma) {
    // O separador mais à direita é o decimal.
    s = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (hasComma) {
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (hasDot) {
    // 1.234 = milhar, 1.2 = decimal
    if (/\.\d{3}(\D|$)/.test(s) || (s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(n);
}

const isMarker = (line) => /^\[(?:planilha|planilhas|slide|página|Resumo)/i.test(line.trim());

/**
 * Recebe o texto extraído de uma planilha e devolve um resumo em português.
 * Retorna "" quando o conteúdo não parece tabular (para não poluir o prompt).
 */
export function summarizeSpreadsheet(text) {
  const lines = String(text || "").split("\n");
  const sections = lines.filter((l) => /^\[planilha/i.test(l)).length;
  const dataLines = lines.filter((l) => l.trim() && !isMarker(l));
  if (dataLines.length < 2) return "";
  const allRows = dataLines.map(splitRow);
  // Só a PRIMEIRA linha pode ser cabeçalho. Planilhas que começam com títulos
  // soltos ("Test spreadsheet") não têm cabeçalho na linha 1 — chamar a 1ª
  // linha tabular de cabeçalho rotularia dados como nomes de coluna.
  const firstIsWide = (allRows[0]?.length || 0) >= 2;
  const rows = allRows.filter((r) => r.length >= 2);
  if (rows.length < 2) return "";

  const numericRatio = (row) => {
    const vals = row.filter(Boolean);
    if (!vals.length) return 0;
    return vals.filter((v) => toNumber(v) !== null).length / vals.length;
  };
  // Só chamamos de "cabeçalho" se a 1ª linha é majoritariamente textual E
  // alguma linha seguinte é majoritariamente numérica. Caso contrário, todas
  // as linhas são dados e as colunas são numeradas — evita rotular errado.
  const hasHeader =
    firstIsWide &&
    numericRatio(rows[0]) < 0.5 &&
    rows.slice(1).some((r) => numericRatio(r) >= 0.5);
  const header = hasHeader ? rows[0] : null;
  const body = hasHeader ? rows.slice(1) : rows;
  if (!body.length) return "";

  const colCount = Math.min(8, Math.max(...rows.map((r) => r.length)));
  const labels = Array.from({ length: colCount }, (_, i) =>
    (header?.[i] || `Coluna ${i + 1}`).trim(),
  );
  const notes = [
    `[Resumo automático da planilha: ${sections ? `${sections} planilha(s), ` : ""}` +
      `${body.length} linha(s) de dados, ${colCount} coluna(s)]`,
    hasHeader ? `Cabeçalho: ${labels.join(" | ")}` : `Colunas: ${labels.join(" | ")}`,
  ];

  let empties = 0;
  let numericCols = 0;
  for (let c = 0; c < colCount; c += 1) {
    const values = body.map((r) => r[c] ?? "").filter((v) => v !== "");
    empties += body.length - values.length;
    if (!values.length) continue;
    const numbers = values.map(toNumber).filter((n) => n !== null);
    if (numbers.length >= Math.max(2, Math.ceil(values.length * 0.6))) {
      numericCols += 1;
      const sum = numbers.reduce((a, b) => a + b, 0);
      notes.push(
        `• "${labels[c]}" (numérica, ${numbers.length} valores): soma ${fmt(sum)}, ` +
        `média ${fmt(sum / numbers.length)}, mín ${fmt(Math.min(...numbers))}, ` +
        `máx ${fmt(Math.max(...numbers))}`,
      );
    } else {
      const counts = new Map();
      for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([v, n]) => `${v}${n > 1 ? ` (${n}×)` : ""}`);
      notes.push(
        `• "${labels[c]}" (texto, ${values.length} valores, ${counts.size} distintos): ${top.join(", ")}`,
      );
    }
  }
  if (empties) notes.push(`Células vazias: ${empties}.`);
  notes.push(
    numericCols
      ? "Os números acima foram calculados localmente a partir das células. Use-os para responder sobre totais, médias, contagens e comparações."
      : "As contagens acima foram calculadas localmente. Use-as para responder sobre frequências e valores distintos; não invente totais que não aparecem nos dados.",
  );
  return notes.join("\n");
}
