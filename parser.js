// Recursive-descent parser for Python literal expressions (dict/list/tuple/set/
// str/bytes/int/float/bool/None, plus best-effort support for constructor-style
// reprs like UUID('...'), datetime.datetime(...), and bare object reprs like
// <AsyncResult: id>). Produces a typed AST (not native JS values) so that
// non-string dict keys, tuples vs. lists, etc. survive round-tripping.

class PyParseError extends Error {
  constructor(message, pos) {
    super(message);
    this.name = "PyParseError";
    this.pos = pos;
  }
}

class PyParser {
  constructor(text) {
    this.text = text;
    this.pos = 0;
    this.len = text.length;
  }

  peek(offset = 0) {
    return this.text[this.pos + offset];
  }

  error(message) {
    throw new PyParseError(message, this.pos);
  }

  skipWs() {
    while (this.pos < this.len) {
      const c = this.text[this.pos];
      if (c === "#") {
        while (this.pos < this.len && this.text[this.pos] !== "\n") this.pos++;
      } else if (/\s/.test(c)) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  atEnd() {
    return this.pos >= this.len;
  }

  parseDocument() {
    this.skipWs();
    if (this.atEnd()) this.error("Empty input");
    const value = this.parseValue();
    this.skipWs();
    if (!this.atEnd()) {
      this.error(`Unexpected trailing content: ${JSON.stringify(this.text.slice(this.pos, this.pos + 20))}`);
    }
    return value;
  }

  parseValue() {
    this.skipWs();
    if (this.atEnd()) this.error("Unexpected end of input");
    const c = this.peek();

    if (c === "{") return this.parseBraceExpr();
    if (c === "[") return this.parseSeq("[", "]", "list");
    if (c === "(") return this.parseTuple();
    if (c === "'" || c === '"') return this.parseString("");
    if (c === "<") return this.parseAngleRepr();
    if (/[A-Za-z_]/.test(c)) return this.parseIdentOrKeyword();
    if (/[0-9+\-.]/.test(c)) return this.parseNumber();

    this.error(`Unexpected character '${c}'`);
  }

  // dict {} or set {..}
  parseBraceExpr() {
    const start = this.pos;
    this.pos++; // consume {
    this.skipWs();
    if (this.peek() === "}") {
      this.pos++;
      return { type: "dict", entries: [], start, end: this.pos };
    }
    const firstKey = this.parseValue();
    this.skipWs();
    if (this.peek() === ":") {
      this.pos++;
      this.skipWs();
      const firstVal = this.parseValue();
      const entries = [{ key: firstKey, value: firstVal }];
      this.skipWs();
      while (this.peek() === ",") {
        this.pos++;
        this.skipWs();
        if (this.peek() === "}") break; // trailing comma
        const k = this.parseValue();
        this.skipWs();
        if (this.peek() !== ":") this.error("Expected ':' in dict entry");
        this.pos++;
        this.skipWs();
        const v = this.parseValue();
        entries.push({ key: k, value: v });
        this.skipWs();
      }
      if (this.peek() !== "}") this.error("Expected '}' to close dict");
      this.pos++;
      return { type: "dict", entries, start, end: this.pos };
    }
    // set
    const items = [firstKey];
    this.skipWs();
    while (this.peek() === ",") {
      this.pos++;
      this.skipWs();
      if (this.peek() === "}") break;
      items.push(this.parseValue());
      this.skipWs();
    }
    if (this.peek() !== "}") this.error("Expected '}' to close set");
    this.pos++;
    return { type: "set", items, start, end: this.pos };
  }

  parseSeq(open, close, type) {
    const start = this.pos;
    this.pos++; // consume open
    this.skipWs();
    const items = [];
    if (this.peek() === close) {
      this.pos++;
      return { type, items, start, end: this.pos };
    }
    while (true) {
      this.skipWs();
      if (this.peek() === close) break;
      items.push(this.parseValue());
      this.skipWs();
      if (this.peek() === ",") {
        this.pos++;
        this.skipWs();
        if (this.peek() === close) break;
      } else {
        break;
      }
    }
    this.skipWs();
    if (this.peek() !== close) this.error(`Expected '${close}'`);
    this.pos++;
    return { type, items, start, end: this.pos };
  }

  parseTuple() {
    const start = this.pos;
    this.pos++; // consume (
    this.skipWs();
    if (this.peek() === ")") {
      this.pos++;
      return { type: "tuple", items: [], start, end: this.pos };
    }
    const first = this.parseValue();
    this.skipWs();
    let isTuple = false;
    const items = [first];
    while (this.peek() === ",") {
      isTuple = true;
      this.pos++;
      this.skipWs();
      if (this.peek() === ")") break;
      items.push(this.parseValue());
      this.skipWs();
    }
    if (this.peek() !== ")") this.error("Expected ')'");
    this.pos++;
    if (!isTuple) return first; // plain parenthesized expression
    return { type: "tuple", items, start, end: this.pos };
  }

  parseString(prefix) {
    const start = this.pos;
    const quoteChar = this.peek();
    let triple = false;
    if (this.peek(1) === quoteChar && this.peek(2) === quoteChar) {
      triple = true;
      this.pos += 3;
    } else {
      this.pos += 1;
    }
    const isRaw = /r/i.test(prefix);
    let raw = "";
    while (true) {
      if (this.atEnd()) this.error("Unterminated string literal");
      const c = this.peek();
      if (!isRaw && c === "\\") {
        raw += c + (this.peek(1) ?? "");
        this.pos += 2;
        continue;
      }
      if (triple) {
        if (c === quoteChar && this.peek(1) === quoteChar && this.peek(2) === quoteChar) {
          this.pos += 3;
          break;
        }
      } else if (c === quoteChar) {
        this.pos += 1;
        break;
      }
      raw += c;
      this.pos += 1;
    }
    const decoded = isRaw ? raw : decodePyEscapes(raw);
    const isBytes = /b/i.test(prefix);
    return {
      type: isBytes ? "bytes" : "str",
      value: decoded,
      start,
      end: this.pos,
    };
  }

  parseAngleRepr() {
    const start = this.pos;
    let depth = 0;
    do {
      const c = this.peek();
      if (c === "<") depth++;
      else if (c === ">") depth--;
      else if (this.atEnd()) this.error("Unterminated '<...>' repr");
      this.pos++;
    } while (depth > 0);
    return { type: "repr", value: this.text.slice(start, this.pos), start, end: this.pos };
  }

  parseIdentOrKeyword() {
    const start = this.pos;
    let name = this.readIdentifier();

    // string/bytes prefix like b'...' r'...' rb'...' f'...'
    if (/^[a-zA-Z]{1,2}$/.test(name) && (this.peek() === "'" || this.peek() === '"')) {
      return this.parseString(name);
    }

    if (name === "True") return { type: "bool", value: true, start, end: this.pos };
    if (name === "False") return { type: "bool", value: false, start, end: this.pos };
    if (name === "None") return { type: "none", value: null, start, end: this.pos };
    if (name === "nan" || name === "NaN") return { type: "float", raw: "nan", value: NaN, start, end: this.pos };
    if (name === "inf" || name === "Infinity") return { type: "float", raw: "inf", value: Infinity, start, end: this.pos };

    // dotted name: module.Class
    while (this.peek() === "." && /[A-Za-z_]/.test(this.peek(1) ?? "")) {
      this.pos++; // consume .
      name += "." + this.readIdentifier();
    }

    // constructor-call style repr: Name(args)
    if (this.peek() === "(") {
      return this.parseCall(name, start);
    }

    return { type: "ident", value: name, start, end: this.pos };
  }

  readIdentifier() {
    const start = this.pos;
    if (!/[A-Za-z_]/.test(this.peek() ?? "")) this.error("Expected identifier");
    this.pos++;
    while (/[A-Za-z0-9_]/.test(this.peek() ?? "")) this.pos++;
    return this.text.slice(start, this.pos);
  }

  parseCall(name, start) {
    this.pos++; // consume (
    this.skipWs();
    const args = [];
    const kwargs = [];
    if (this.peek() !== ")") {
      while (true) {
        this.skipWs();
        const kwMatch = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(this.text.slice(this.pos));
        if (kwMatch) {
          const eqIdx = kwMatch[0].indexOf("=");
          const kwName = kwMatch[0].slice(0, eqIdx).trim();
          this.pos += kwMatch[0].length;
          this.skipWs();
          const val = this.parseValue();
          kwargs.push({ name: kwName, value: val });
        } else {
          args.push(this.parseValue());
        }
        this.skipWs();
        if (this.peek() === ",") {
          this.pos++;
          this.skipWs();
          if (this.peek() === ")") break;
        } else {
          break;
        }
      }
    }
    this.skipWs();
    if (this.peek() !== ")") this.error("Expected ')' to close call");
    this.pos++;
    return { type: "call", name, args, kwargs, start, end: this.pos };
  }

  parseNumber() {
    const start = this.pos;
    const re = /^[+-]?(\d[\d_]*\.\d[\d_]*(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?|\d[\d_]*(?:[eE][+-]?\d+)?)j?/;
    const m = re.exec(this.text.slice(this.pos));
    if (!m) this.error("Invalid number");
    const raw = m[0];
    this.pos += raw.length;
    const isComplex = raw.endsWith("j");
    const numeric = raw.replace(/_/g, "").replace(/j$/, "");
    const isFloat = /[.eE]/.test(numeric) || isComplex;
    return {
      type: isFloat ? "float" : "int",
      raw,
      value: isFloat ? parseFloat(numeric) : numeric,
      start,
      end: this.pos,
    };
  }
}

function decodePyEscapes(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) {
      const n = raw[i + 1];
      const map = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0", b: "\b", f: "\f", v: "\v" };
      if (n in map) {
        out += map[n];
        i++;
        continue;
      }
      if (n === "x" && i + 3 < raw.length) {
        const hex = raw.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 3;
          continue;
        }
      }
      if (n === "u" && i + 5 < raw.length) {
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
          continue;
        }
      }
      out += c + n;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function parsePython(text) {
  const parser = new PyParser(text);
  return parser.parseDocument();
}

// ---- AST -> pretty Python text ----
function pyStringLiteral(s) {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else out += ch;
  }
  return quote + out + quote;
}

function pyRepr(node, indent = 0, step = 4) {
  const pad = (n) => " ".repeat(n * step);
  switch (node.type) {
    case "dict": {
      if (node.entries.length === 0) return "{}";
      const inner = node.entries
        .map((e) => `${pad(indent + 1)}${pyRepr(e.key, indent + 1, step)}: ${pyRepr(e.value, indent + 1, step)}`)
        .join(",\n");
      return `{\n${inner}\n${pad(indent)}}`;
    }
    case "list": {
      if (node.items.length === 0) return "[]";
      const inner = node.items.map((it) => `${pad(indent + 1)}${pyRepr(it, indent + 1, step)}`).join(",\n");
      return `[\n${inner}\n${pad(indent)}]`;
    }
    case "tuple": {
      if (node.items.length === 0) return "()";
      if (node.items.length === 1) return `(${pyRepr(node.items[0], indent, step)},)`;
      const inner = node.items.map((it) => `${pad(indent + 1)}${pyRepr(it, indent + 1, step)}`).join(",\n");
      return `(\n${inner}\n${pad(indent)})`;
    }
    case "set": {
      if (node.items.length === 0) return "set()";
      const inner = node.items.map((it) => `${pad(indent + 1)}${pyRepr(it, indent + 1, step)}`).join(",\n");
      return `{\n${inner}\n${pad(indent)}}`;
    }
    case "str":
      return pyStringLiteral(node.value);
    case "bytes":
      return "b" + pyStringLiteral(node.value);
    case "bool":
      return node.value ? "True" : "False";
    case "none":
      return "None";
    case "int":
      return node.value;
    case "float":
      return node.raw;
    case "repr":
      return node.value;
    case "ident":
      return node.value;
    case "call": {
      const parts = [
        ...node.args.map((a) => pyRepr(a, indent, step)),
        ...node.kwargs.map((k) => `${k.name}=${pyRepr(k.value, indent, step)}`),
      ];
      return `${node.name}(${parts.join(", ")})`;
    }
    default:
      return String(node.value ?? "");
  }
}

// ---- AST -> JSON-compatible text ----
function pyToJsonValue(node) {
  switch (node.type) {
    case "dict": {
      const obj = {};
      for (const e of node.entries) {
        const key = e.key.type === "str" ? e.key.value : pyRepr(e.key, 0);
        obj[key] = pyToJsonValue(e.value);
      }
      return obj;
    }
    case "list":
    case "tuple":
    case "set":
      return node.items.map(pyToJsonValue);
    case "str":
      return node.value;
    case "bytes":
      return node.value;
    case "bool":
      return node.value;
    case "none":
      return null;
    case "int":
      return Number.isSafeInteger(Number(node.value)) ? Number(node.value) : node.value;
    case "float":
      return node.value;
    case "repr":
    case "ident":
      return node.value;
    case "call":
      return pyRepr(node, 0);
    default:
      return node.value ?? null;
  }
}

function pyToJsonText(node) {
  return JSON.stringify(pyToJsonValue(node), null, 2);
}
