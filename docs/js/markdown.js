// Gem.AI · renderizador Markdown enxuto e seguro (sem dependências)
// Todo o conteúdo é escapado antes de qualquer substituição -> sem XSS.

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function inline(escaped) {
  const codeSpans = [];
  let out = escaped.replace(/`([^`\n]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\u0000C${codeSpans.length - 1}\u0000`;
  });

  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_, label, href) =>
      `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  out = out.replace(/\u0000C(\d+)\u0000/g, (_, index) => {
    return `<code class="inline-code">${codeSpans[Number(index)]}</code>`;
  });
  return out;
}

function renderText(text) {
  const lines = text.split("\n");
  const out = [];
  let listType = null;
  let listItems = [];
  let paragraph = [];

  const flushList = () => {
    if (!listType) return;
    out.push(
      `<${listType}>${listItems.map((item) => `<li>${inline(escapeHtml(item))}</li>`).join("")}</${listType}>`,
    );
    listType = null;
    listItems = [];
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(escapeHtml(paragraph.join("\n"))).replace(/\n/g, "<br>")}</p>`);
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      flushParagraph();
      continue;
    }

    let match;
    if ((match = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushList();
      flushParagraph();
      const level = match[1].length;
      out.push(`<h${level}>${inline(escapeHtml(match[2]))}</h${level}>`);
    } else if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      flushList();
      flushParagraph();
      out.push("<hr>");
    } else if ((match = line.match(/^>\s?(.*)$/))) {
      flushList();
      flushParagraph();
      out.push(`<blockquote>${inline(escapeHtml(match[1]))}</blockquote>`);
    } else if ((match = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(match[1]);
    } else if ((match = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(match[1]);
    } else {
      flushList();
      paragraph.push(line);
    }
  }

  flushList();
  flushParagraph();
  return out.join("");
}

export function renderMarkdown(source) {
  const text = String(source ?? "").replace(/\r\n/g, "\n");
  const blocks = [];
  const fence = /```([\w+.-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > lastIndex) blocks.push(renderText(text.slice(lastIndex, match.index)));
    const language = escapeHtml(match[1] || "código");
    const code = escapeHtml(match[2].replace(/\n$/, ""));
    blocks.push(
      `<pre class="code-block"><div class="code-head"><span>${language}</span>` +
        `<button type="button" class="copy-code">Copiar</button></div><code>${code}</code></pre>`,
    );
    lastIndex = fence.lastIndex;
  }
  if (lastIndex < text.length) blocks.push(renderText(text.slice(lastIndex)));

  return blocks.join("");
}
