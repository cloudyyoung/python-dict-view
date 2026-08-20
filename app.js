const SAMPLE = `{'name': 'Ada Lovelace', 'age': 36, 'height_m': 1.65, 'active': True, 'deceased': True, 'nickname': None, 'tags': ['mathematician', 'writer', 'visionary'], 'scores': (98, 87, 91), 'skills': {'python', 'analysis', 'poetry'}, 'address': {'city': 'London', 'zip': 'W1A 1AA', 'country': 'UK'}, 'friends': [{'name': 'Charles Babbage', 'role': 'collaborator'}, {'name': 'Mary Somerville', 'role': 'mentor'}], 'avatar': b'\\x89PNG\\r\\n', 'created_at': datetime.date(1815, 12, 10), 'ref': <Object: id=42>}`;

const input = document.getElementById("input");
const output = document.getElementById("output");
const statusEl = document.getElementById("status");
const searchBox = document.getElementById("search");
const btnSample = document.getElementById("btn-sample");
const btnTheme = document.getElementById("btn-theme");
const btnClear = document.getElementById("btn-clear");
const btnPaste = document.getElementById("btn-paste");
const btnExpand = document.getElementById("btn-expand");
const btnCollapse = document.getElementById("btn-collapse");
const btnCopy = document.getElementById("btn-copy");
const tabs = Array.from(document.querySelectorAll(".tab"));

let lastAst = null;
let currentView = "tree";

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function createSpan(cls, text) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function isContainer(n) {
  return n.type === "dict" || n.type === "list" || n.type === "tuple" || n.type === "set";
}

function itemsOf(node) {
  return node.type === "dict" ? node.entries : node.items;
}

function bracketsFor(type) {
  if (type === "dict" || type === "set") return ["{", "}"];
  if (type === "list") return ["[", "]"];
  return ["(", ")"];
}

function countLabel(node) {
  const n = itemsOf(node).length;
  if (node.type === "dict") return n === 1 ? "1 key" : `${n} keys`;
  return n === 1 ? "1 item" : `${n} items`;
}

function scalarSpan(node) {
  switch (node.type) {
    case "str":
      return createSpan("k-str", pyStringLiteral(node.value));
    case "bytes":
      return createSpan("k-str", "b" + pyStringLiteral(node.value));
    case "int":
      return createSpan("k-num", String(node.value));
    case "float":
      return createSpan("k-num", node.raw);
    case "bool":
      return createSpan("k-bool", node.value ? "True" : "False");
    case "none":
      return createSpan("k-none", "None");
    case "repr":
      return createSpan("k-repr", node.value);
    case "ident":
      return createSpan("k-ident", node.value);
    case "call":
      return createSpan("k-ident", pyRepr(node, 0));
    default:
      return createSpan("k-ident", String(node.value ?? ""));
  }
}

function appendKey(line, keyNode) {
  if (keyNode.type === "str") {
    line.appendChild(createSpan("k-key", keyNode.value));
  } else {
    line.appendChild(createSpan("k-key", pyRepr(keyNode, 0)));
  }
  line.appendChild(createSpan("k-punct", ": "));
}

function buildRow(valueNode, keyNode, trailingComma) {
  if (isContainer(valueNode)) return buildContainerRow(valueNode, keyNode, trailingComma);

  const row = document.createElement("div");
  row.className = "node leaf";
  const line = document.createElement("div");
  line.className = "tree-line";
  line.appendChild(createSpan("toggle-spacer", ""));
  if (keyNode) appendKey(line, keyNode);
  line.appendChild(scalarSpan(valueNode));
  if (trailingComma) line.appendChild(createSpan("k-punct", ","));
  row.appendChild(line);
  return row;
}

function buildContainerRow(node, keyNode, trailingComma) {
  const [open, close] = bracketsFor(node.type);
  const items = itemsOf(node);
  const row = document.createElement("div");
  row.className = "node";

  const line = document.createElement("div");
  line.className = "tree-line";

  if (items.length === 0) {
    row.classList.add("leaf");
    line.appendChild(createSpan("toggle-spacer", ""));
    if (keyNode) appendKey(line, keyNode);
    if (node.type === "set") line.appendChild(createSpan("k-ident", "set()"));
    else {
      line.appendChild(createSpan("k-punct", open));
      line.appendChild(createSpan("k-punct", close));
    }
    if (trailingComma) line.appendChild(createSpan("k-punct", ","));
    row.appendChild(line);
    return row;
  }

  const toggle = document.createElement("span");
  toggle.className = "toggle";
  toggle.addEventListener("click", () => row.classList.toggle("collapsed"));
  line.appendChild(toggle);
  if (keyNode) appendKey(line, keyNode);
  line.appendChild(createSpan("k-punct", open));

  const summary = document.createElement("span");
  summary.className = "collapsed-summary";
  summary.appendChild(createSpan("k-count", ` ${countLabel(node)} `));
  summary.appendChild(createSpan("k-punct", close));
  if (trailingComma) summary.appendChild(createSpan("k-punct", ","));
  line.appendChild(summary);

  row.appendChild(line);

  const childrenWrap = document.createElement("div");
  childrenWrap.className = "children";
  if (node.type === "dict") {
    node.entries.forEach((e, i) => {
      childrenWrap.appendChild(buildRow(e.value, e.key, i < node.entries.length - 1));
    });
  } else {
    node.items.forEach((it, i) => {
      childrenWrap.appendChild(buildRow(it, null, i < node.items.length - 1));
    });
  }
  row.appendChild(childrenWrap);

  const closingLine = document.createElement("div");
  closingLine.className = "tree-line closing-line";
  closingLine.appendChild(createSpan("toggle-spacer", ""));
  closingLine.appendChild(createSpan("k-punct", close));
  if (trailingComma) closingLine.appendChild(createSpan("k-punct", ","));
  row.appendChild(closingLine);

  return row;
}

function posToLineCol(text, pos) {
  const lines = text.slice(0, pos).split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

function describeAst(node) {
  if (node.type === "dict") return `dict — ${node.entries.length} key${node.entries.length === 1 ? "" : "s"}`;
  if (node.type === "list" || node.type === "tuple" || node.type === "set") {
    return `${node.type} — ${node.items.length} item${node.items.length === 1 ? "" : "s"}`;
  }
  return node.type;
}

function render() {
  const text = input.value;
  if (!text.trim()) {
    statusEl.textContent = "Paste a Python dict to get started.";
    statusEl.classList.remove("error");
    output.innerHTML = '<div class="empty-state">Nothing to show yet.</div>';
    lastAst = null;
    return;
  }
  try {
    const ast = parsePython(text);
    lastAst = ast;
    statusEl.classList.remove("error");
    statusEl.textContent = describeAst(ast);
    renderActiveView();
  } catch (err) {
    lastAst = null;
    statusEl.classList.add("error");
    if (err instanceof PyParseError) {
      const { line, col } = posToLineCol(text, err.pos);
      statusEl.textContent = `Parse error at line ${line}, col ${col}: ${err.message}`;
    } else {
      statusEl.textContent = `Parse error: ${err.message}`;
    }
    output.innerHTML =
      '<div class="empty-state">Fix the input to see a preview. Common issues: unbalanced quotes/brackets, or unescaped quotes inside a string (from copy/paste).</div>';
  }
}

function renderActiveView() {
  if (!lastAst) return;
  output.innerHTML = "";
  if (currentView === "tree") {
    const root = buildRow(lastAst, null, false);
    root.classList.add("root");
    output.appendChild(root);
  } else if (currentView === "python") {
    const pre = document.createElement("pre");
    pre.className = "text-view";
    pre.textContent = pyRepr(lastAst, 0);
    output.appendChild(pre);
  } else if (currentView === "json") {
    let text;
    try {
      text = pyToJsonText(lastAst);
    } catch (e) {
      text = `// Could not convert to JSON: ${e.message}`;
    }
    const pre = document.createElement("pre");
    pre.className = "text-view";
    pre.textContent = text;
    output.appendChild(pre);
  }
  applySearch(searchBox.value.trim());
}

function clearMarks() {
  output.querySelectorAll("mark").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
}

function wrapMatch(textNode, q) {
  const text = textNode.textContent;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);
  const frag = document.createDocumentFragment();
  if (before) frag.appendChild(document.createTextNode(before));
  const mark = document.createElement("mark");
  mark.textContent = match;
  frag.appendChild(mark);
  if (after) frag.appendChild(document.createTextNode(after));
  textNode.parentNode.replaceChild(frag, textNode);
}

function applySearch(query) {
  clearMarks();
  if (!query) return;
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(output, NodeFilter.SHOW_TEXT);
  const matches = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.textContent.toLowerCase().includes(q)) matches.push(node);
  }
  matches.forEach((textNode) => {
    const parentEl = textNode.parentElement;
    wrapMatch(textNode, q);
    let el = parentEl;
    while (el && el !== output) {
      if (el.classList && el.classList.contains("node")) el.classList.remove("collapsed");
      el = el.parentElement;
    }
  });
}

function flash(btn, text, ms = 1100) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = original), ms);
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentView = tab.dataset.view;
    renderActiveView();
  });
});

input.addEventListener("input", debounce(render, 150));

searchBox.addEventListener(
  "input",
  debounce(() => applySearch(searchBox.value.trim()), 120)
);

btnExpand.addEventListener("click", () => {
  output.querySelectorAll(".node").forEach((n) => n.classList.remove("collapsed"));
});

btnCollapse.addEventListener("click", () => {
  output.querySelectorAll(".node:not(.root):not(.leaf)").forEach((n) => n.classList.add("collapsed"));
});

btnCopy.addEventListener("click", async () => {
  if (!lastAst) return;
  const text = currentView === "json" ? pyToJsonText(lastAst) : pyRepr(lastAst, 0);
  try {
    await navigator.clipboard.writeText(text);
    flash(btnCopy, "Copied!");
  } catch (e) {
    flash(btnCopy, "Copy failed");
  }
});

btnSample.addEventListener("click", () => {
  input.value = SAMPLE;
  render();
});

btnClear.addEventListener("click", () => {
  input.value = "";
  render();
  input.focus();
});

btnPaste.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    input.value = text;
    render();
  } catch (e) {
    statusEl.classList.add("error");
    statusEl.textContent = "Clipboard permission denied — paste manually with Cmd/Ctrl+V instead.";
  }
});

const THEME_KEY = "pdv-theme";
function applyTheme(mode) {
  if (mode === "light" || mode === "dark") {
    document.documentElement.setAttribute("data-theme", mode);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}
btnTheme.addEventListener("click", () => {
  const current = localStorage.getItem(THEME_KEY) || "auto";
  const next = current === "auto" ? "light" : current === "light" ? "dark" : "auto";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  btnTheme.title = `Theme: ${next}`;
});
applyTheme(localStorage.getItem(THEME_KEY) || "auto");

input.value = SAMPLE;
render();
