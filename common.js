// Shared helpers and Markdown rendering for the app page.
// Requires markdown-it, its plugins, texmath, katex, highlight.js and mermaid as globals.

const token = new URLSearchParams(location.search).get("token");

export async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

export function toast(message, isError = false) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(el.timer);
  el.timer = setTimeout(() => el.classList.remove("show"), 1400);
}

// CRLF keeps line breaks intact in every Windows paste target.
export async function copyText(text, label = "Copied") {
  await navigator.clipboard.writeText(text.replace(/\r?\n/g, "\r\n"));
  toast(label);
}

export const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>'),
  code: svg('<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>'),
  arrowUp: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
  terminal: svg('<path d="m5 8 4 4-4 4M12 16h7"/>'),
  brain: svg('<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1ZM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m14 6 4 4"/>'),
  pin: svg('<path d="M12 17v5"/><path d="M9 10.76 7.11 11.66A2 2 0 0 0 6 13.46V16h12v-2.54a2 2 0 0 0-1.11-1.8L15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'),
  spinner: '<span class="spin"></span>',
};

texmath.katex = katex;
mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });

// Follows Pi's theme appearance; applies to diagrams rendered after the call.
export function setMermaidTheme(appearance) {
  mermaid.initialize({ startOnLoad: false, theme: appearance === "light" ? "default" : "dark", securityLevel: "strict" });
}

const md = markdownit({ html: false, linkify: true, breaks: true })
  .use(markdownitFootnote)
  .use(markdownitTaskLists, { enabled: false })
  .use(texmath, { engine: katex, delimiters: ["dollars", "brackets", "beg_end"], katexOptions: { throwOnError: false } });

const headButton = (action, icon, label) =>
  `<button class="icon-btn" data-action="${action}" title="${label}" aria-label="${label}">${ICONS[icon]}</button>`;

md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = t.info.trim().split(/\s+/)[0];
  const source = t.content.replace(/\n$/, "");
  const raw = escapeHtml(source);
  if (lang === "mermaid") {
    return `<div class="mermaid-block" data-raw="${raw}"><div class="block-head"><span class="lang">mermaid</span>` +
      headButton("toggle", "code", "Source") + headButton("copy", "copy", "Copy") +
      `</div><div class="diagram"></div><pre hidden>${raw}</pre></div>`;
  }
  const body = lang && hljs.getLanguage(lang) ? hljs.highlight(source, { language: lang, ignoreIllegals: true }).value : raw;
  return `<div class="code-block" data-raw="${raw}"><div class="block-head"><span class="lang">${escapeHtml(lang || "text")}</span>` +
    headButton("copy", "copy", "Copy") + `</div><pre><code class="hljs">${body}</code></pre></div>`;
};
md.renderer.rules.code_block = (tokens, idx) => md.renderer.rules.fence(tokens, idx);

md.renderer.rules.table_open = (tokens, idx) => {
  const [start, end] = tokens[idx].map;
  return `<div class="table-block" data-lines="${start},${end}"><div class="block-head"><span class="lang">table</span>` +
    headButton("copy-tsv", "table", "TSV") + headButton("copy-md", "copy", "Markdown") + `</div><div class="scroll"><table>`;
};
md.renderer.rules.table_close = () => "</table></div></div>";

function tableToTsv(table) {
  return [...table.rows]
    .map((row) => [...row.cells].map((cell) => cell.innerText.replace(/\s+/g, " ").trim()).join("\t"))
    .join("\n");
}

let mermaidId = 0;

// Render Markdown source into the container and wire up block toolbars.
// Streaming replies pass diagrams=false so Mermaid is not re-rendered on every delta.
export async function renderMarkdown(container, source, { diagrams = true } = {}) {
  container.classList.add("markdown");
  container.innerHTML = md.render(source);
  const lines = source.split(/\r?\n/);

  for (const block of container.querySelectorAll(".code-block")) {
    block.querySelector('[data-action="copy"]').onclick = () => copyText(block.dataset.raw, "Copied code");
  }
  for (const block of container.querySelectorAll(".table-block")) {
    const [start, end] = block.dataset.lines.split(",").map(Number);
    block.querySelector('[data-action="copy-md"]').onclick = () => copyText(lines.slice(start, end).join("\n").trim(), "Copied Markdown table");
    block.querySelector('[data-action="copy-tsv"]').onclick = () => copyText(tableToTsv(block.querySelector("table")), "Copied TSV, ready to paste into Excel");
  }
  for (const block of container.querySelectorAll(".mermaid-block")) {
    const diagram = block.querySelector(".diagram");
    const pre = block.querySelector("pre");
    block.querySelector('[data-action="copy"]').onclick = () => copyText(block.dataset.raw, "Copied Mermaid source");
    block.querySelector('[data-action="toggle"]').onclick = () => {
      pre.hidden = !pre.hidden;
      diagram.hidden = !pre.hidden;
    };
    if (!diagrams) {
      pre.hidden = false;
      diagram.hidden = true;
      continue;
    }
    try {
      const { svg: rendered } = await mermaid.render(`mermaid-${++mermaidId}`, block.dataset.raw);
      diagram.innerHTML = rendered;
    } catch (error) {
      diagram.innerHTML = `<div class="error">${escapeHtml(String(error?.message ?? error))}</div>`;
    }
  }
}
