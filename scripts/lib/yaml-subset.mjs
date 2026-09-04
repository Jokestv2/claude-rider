// A deliberately small YAML reader for RIDER.md frontmatter (subset documented in README).

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) throw new Error("RIDER.md: no frontmatter block (--- … ---) at the top");
  return { data: parseYamlSubset(m[1]), body: m[2].trim() };
}

export function parseYamlSubset(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    let line = raw;
    while (unbalanced(line) && i + 1 < lines.length) line += ` ${lines[++i].trim()}`;
    items.push({ indent: /^ */.exec(line)[0].length, text: line.trim(), lineNo: i + 1 });
  }
  if (!items.length) return {};
  const [value, next] = parseBlock(items, 0, items[0].indent);
  if (next !== items.length) throw new Error(`yaml: unexpected content at line ${items[next].lineNo}: ${items[next].text}`);
  return value;
}

function unbalanced(s) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return depth > 0;
}

function parseBlock(items, idx, indent) {
  if (items[idx].text.startsWith("- ")) return parseList(items, idx, indent);
  return parseMap(items, idx, indent);
}

function parseList(items, idx, indent) {
  const out = [];
  while (idx < items.length && items[idx].indent === indent && items[idx].text.startsWith("- ")) {
    out.push(scalar(items[idx].text.slice(2).trim(), items[idx].lineNo));
    idx++;
  }
  return [out, idx];
}

function parseMap(items, idx, indent) {
  const out = {};
  while (idx < items.length && items[idx].indent === indent) {
    const { text, lineNo } = items[idx];
    if (text.startsWith("- ")) break;
    const m = /^([^:{}[\]"']+?):(?:\s+(.*))?$/.exec(text);
    if (!m) throw new Error(`yaml: expected "key: value" at line ${lineNo}: ${text}`);
    const key = m[1].trim();
    const rest = (m[2] ?? "").trim();
    idx++;
    if (rest === "") {
      if (idx < items.length && items[idx].indent > indent) {
        const [v, n] = parseBlock(items, idx, items[idx].indent);
        out[key] = v;
        idx = n;
      } else out[key] = null;
    } else out[key] = value(rest, lineNo);
  }
  return [out, idx];
}

function value(s, lineNo) {
  if (s.startsWith("{")) return closed(flowMap(s, 0, lineNo), s, lineNo);
  if (s.startsWith("[")) return closed(flowSeq(s, 0, lineNo), s, lineNo);
  return scalar(s, lineNo);
}

function closed([v, n], s, lineNo) {
  if (s.slice(n).trim() !== "") throw new Error(`yaml: trailing text after a flow collection at line ${lineNo}`);
  return v;
}

function flowMap(s, i, lineNo) {
  const out = {};
  i++;
  for (;;) {
    i = skipWs(s, i);
    if (s[i] === "}") return [out, i + 1];
    if (i >= s.length) throw new Error(`yaml: unterminated { at line ${lineNo}`);
    const colon = s.indexOf(":", i);
    if (colon < 0) throw new Error(`yaml: flow map entry without ":" at line ${lineNo}`);
    const key = s.slice(i, colon).trim();
    i = skipWs(s, colon + 1);
    let v;
    if (s[i] === "{") [v, i] = flowMap(s, i, lineNo);
    else if (s[i] === "[") [v, i] = flowSeq(s, i, lineNo);
    else {
      const end = flowScalarEnd(s, i);
      v = scalar(s.slice(i, end).trim(), lineNo);
      i = end;
    }
    out[key] = v;
    i = skipWs(s, i);
    if (s[i] === ",") i++;
  }
}

function flowSeq(s, i, lineNo) {
  const out = [];
  i++;
  for (;;) {
    i = skipWs(s, i);
    if (s[i] === "]") return [out, i + 1];
    if (i >= s.length) throw new Error(`yaml: unterminated [ at line ${lineNo}`);
    const end = flowScalarEnd(s, i);
    out.push(scalar(s.slice(i, end).trim(), lineNo));
    i = skipWs(s, end);
    if (s[i] === ",") i++;
  }
}

function skipWs(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function flowScalarEnd(s, i) {
  let q = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === "," || c === "}" || c === "]") return i;
  }
  return i;
}

function scalar(s, lineNo) {
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
    if (!m) throw new Error(`yaml: bad double-quoted scalar at line ${lineNo}: ${s}`);
    return m[1].replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'$/.exec(s);
    if (!m) throw new Error(`yaml: bad single-quoted scalar at line ${lineNo}: ${s}`);
    return m[1].replace(/''/g, "'");
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
