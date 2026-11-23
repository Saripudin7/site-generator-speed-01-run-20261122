// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01): run(input) returns exactly
// makefun-site 1.0.0's build output for the case's site, byte for byte, computed with a fused
// Markdown lexer/renderer, batched HTML escaping, ASCII-fast slugification with a per-case cache,
// and templates compiled once to plain functions. No dependencies.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const INCLUDE_DEPTH = 8;
const SLUG_MAX = 64;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = Object.hasOwn;

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** HTML-escape & < > " ' (bulk calls only; the regex engine scans faster than a JS char loop). */
function esc(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** JS \s membership by UTF-16 code unit. */
function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** Word count: runs of non-whitespace (what /\S+/g counts), without allocating the matches. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWsCode(c))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

const MARK_RE = /\p{M}/gu;

/** makefun-site's slug rule; pure-ASCII text skips NFKD (identity there, and no marks to drop). */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
      if (out.length > SLUG_MAX) break; // the cut below only keeps 64; a longer tail cannot change it
    }
    out = out.slice(0, SLUG_MAX);
    while (out.endsWith('-')) out = out.slice(0, -1);
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  const d1 = date.indexOf('-');
  const d2 = date.indexOf('-', d1 + 1);
  return `${Number(date.slice(d2 + 1))} ${MONTHS[Number(date.slice(d1 + 1, d2)) - 1]} ${date.slice(0, d1)}`;
}

// ---------------------------------------------------------------- front matter

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Front matter + body, or { error }; scans only the front-matter lines, body by slice. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  const fmLines = [];
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let body = null;
  while (pos <= text.length) {
    const end = text.indexOf('\n', pos);
    const line = end === -1 ? text.slice(pos) : text.slice(pos, end);
    if (line === '---') { body = end === -1 ? '' : text.slice(end + 1); break; }
    fmLines.push(line);
    if (end === -1) break;
    pos = end + 1;
  }
  if (body === null) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;
const isEscapableAt = (s, j) => { const c = s.charCodeAt(j); return c < 128 && ESCAPABLE[c] === 1; };

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  let n = 0;
  while (line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  let i = n;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  const len = line.length;
  while (i < len) { const cc = line.charCodeAt(i); if (cc === 32 || cc === 9) i++; else break; }
  let end = len;
  while (end > i) { const cc = line.charCodeAt(end - 1); if (cc === 32 || cc === 9) end--; else break; }
  if (end <= i) return null;
  const text = line.slice(i, end);
  if (text.indexOf('\u2028') !== -1 || text.indexOf('\u2029') !== -1) return null;
  return { depth: n, text };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return null;
  if (line.charCodeAt(1) !== 32) return null;
  const rest = line.slice(2);
  if (rest.indexOf('\u2028') !== -1 || rest.indexOf('\u2029') !== -1) return null;
  return rest;
}

function orderedOf(line) {
  let i = 0;
  const len = line.length;
  while (i < len) { const c = line.charCodeAt(i); if (c >= 48 && c <= 57) i++; else break; }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  const rest = line.slice(i + 2);
  if (rest.indexOf('\u2028') !== -1 || rest.indexOf('\u2029') !== -1) return null;
  return { num: Number(line.slice(0, i)), rest };
}

function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  return !isWsCode(line.charCodeAt(i));
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) { const c = line.charCodeAt(a); if (c === 32 || c === 9) a++; else break; }
  while (b > a) { const c = line.charCodeAt(b - 1); if (c === 32 || c === 9) b--; else break; }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function endsParagraph(line) {
  if (isBlank(line)) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

function findCloseBracket(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapableAt(s, j + 1)) { j++; continue; }
    if (c === 93) return j;
  }
  return -1;
}

function findStrongClose(s, from, end) {
  for (let j = from; j + 1 < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapableAt(s, j + 1)) { j++; continue; }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapableAt(s, j + 1)) { j++; continue; }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

/**
 * Inline rendering over s[a..b), appending to `parts` (no intermediate strings for the recursive
 * strong/emphasis/link bodies). One regex finds the next Markdown special or HTML-escapable char,
 * so plain runs between them need no escaping pass. `link` resolves hrefs.
 */
function inlineRange(s, a, b, link, re, parts) {
  let i = a;
  while (i < b) {
    re.lastIndex = i;
    const m = re.exec(s);
    const j = m === null || m.index > b ? b : m.index;
    if (j > i) { parts.push(s.slice(i, j)); i = j; if (i >= b) break; }
    const c = s.charCodeAt(i);
    if (c === 38) { parts.push('&amp;'); i++; }
    else if (c === 60) { parts.push('&lt;'); i++; }
    else if (c === 62) { parts.push('&gt;'); i++; }
    else if (c === 34) { parts.push('&quot;'); i++; }
    else if (c === 39) { parts.push('&#39;'); i++; }
    else if (c === 92) {
      if (i + 1 < b && isEscapableAt(s, i + 1)) { parts.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]); i += 2; }
      else { parts.push('\\'); i++; }
    } else if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1 && k < b) { parts.push('<code>', esc(s.slice(i + 1, k)), '</code>'); i = k + 1; }
      else { parts.push('`'); i++; }
    } else if (c === 42) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const k = findStrongClose(s, i + 2, b);
        if (k > i + 2) { parts.push('<strong>'); inlineRange(s, i + 2, k, link, re, parts); parts.push('</strong>'); i = k + 2; }
        else { parts.push('**'); i += 2; }
      } else {
        const k = findSingleStar(s, i + 1, b);
        if (k > i + 1) { parts.push('<em>'); inlineRange(s, i + 1, k, link, re, parts); parts.push('</em>'); i = k + 1; }
        else { parts.push('*'); i++; }
      }
    } else if (c === 91) { // '['
      const k = findCloseBracket(s, i + 1, b);
      const m2 = k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 || m2 >= b ? '' : s.slice(k + 2, m2);
      if (target !== '' && !hasWs(target)) {
        parts.push('<a href="', esc(link(target)), '">');
        inlineRange(s, i + 1, k, link, re, parts);
        parts.push('</a>');
        i = m2 + 1;
      } else { parts.push('['); i++; }
    } else { parts.push(s[i]); i++; }
  }
}

function inline(s, link) {
  const parts = [];
  inlineRange(s, 0, s.length, link, /[\\`*[\&<>"']/g, parts);
  return parts.join('');
}

/** One body rendered in a single pass: { html, toc, excerpt }. `slug` is the cached slugifier. */
function renderMarkdown(src, link, slug) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const len = lines.length;
  while (i < len) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < len && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
        blocks.push(`<pre><code${cls}>${body.length ? `${esc(body.join('\n'))}\n` : ''}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slug(h.text), ids);
        const html = inline(h.text, link);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const kept = [];
      while (i < len && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') kept.push(l);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) { blocks.push('<hr>\n'); i++; continue; }
      const first = bulletOf(line);
      if (first !== null) {
        const items = [];
        while (i < len) {
          const rest = bulletOf(lines[i]);
          if (rest !== null) { items.push([trimLine(rest)]); i++; }
          else if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        let html = '<ul>\n';
        for (const item of items) html += `<li>${inline(item.join('\n'), link)}</li>\n`;
        blocks.push(`${html}</ul>\n`);
        continue;
      }
    } else if (c0 >= 48 && c0 <= 57) {
      const first = orderedOf(line);
      if (first !== null) {
        const start = first.num;
        const items = [];
        while (i < len) {
          const o = orderedOf(lines[i]);
          if (o !== null) { items.push([trimLine(o.rest)]); i++; }
          else if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        let html = start !== 1 ? `<ol start="${start}">\n` : '<ol>\n';
        for (const item of items) html += `<li>${inline(item.join('\n'), link)}</li>\n`;
        blocks.push(`${html}</ol>\n`);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < len && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const BLANK_SP = /^[ \t]*$/;

function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = BLANK_SP.test(src.slice(lineStart, open)) && BLANK_SP.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookupRoot(stack, name) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (hasOwn(stack[i], name)) return stack[i][name];
  }
  return undefined;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

let tmpSeq = 0;
function lookupCode(path) {
  const v = `v${tmpSeq++}`;
  let code = `let ${v}=C.root(S,${JSON.stringify(path[0])});`;
  for (let k = 1; k < path.length; k++) {
    code += `${v}=(${v}!==null&&typeof ${v}==="object"&&C.has(${v},${JSON.stringify(path[k])}))?${v}[${JSON.stringify(path[k])}]:undefined;`;
  }
  return { v, code };
}

function genNodes(nodes, out, memoSet) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(`O.push(${JSON.stringify(n.text)});`);
        break;
      case 'var': {
        const { v, code } = lookupCode(n.path);
        out.push(`{${code}O.push(C.escTxt(${v}));}`);
        break;
      }
      case 'raw': {
        const { v, code } = lookupCode(n.path);
        out.push(`{${code}O.push(C.txt(${v}));}`);
        break;
      }
      case 'if': {
        const { v, code } = lookupCode(n.path);
        out.push(`{${code}if(C.tru(${v})!==${n.not}){`);
        genNodes(n.then, out, memoSet);
        if (n.else !== null) { out.push('}else{'); genNodes(n.else, out, memoSet); }
        out.push('}}');
        break;
      }
      case 'for': {
        const { v, code } = lookupCode(n.path);
        const xs = `x${tmpSeq++}`;
        const vs = `s${tmpSeq++}`;
        const lp = `l${tmpSeq++}`;
        const k = `k${tmpSeq++}`;
        out.push(`{${code}const ${xs}=${v};if(Array.isArray(${xs})){const ${vs}={};const ${lp}={index:0,first:false,last:false,length:${xs}.length};S.push(${vs});for(let ${k}=0;${k}<${xs}.length;${k}++){${vs}[${JSON.stringify(n.name)}]=${xs}[${k}];${vs}.loop=${lp};${lp}.index=${k}+1;${lp}.first=${k}===0;${lp}.last=${k}===${xs}.length-1;`);
        genNodes(n.body, out, memoSet);
        out.push(`}S.pop();}}`);
        break;
      }
      case 'include': {
        const t = `t${tmpSeq++}`;
        if (memoSet.has(n.name)) {
          const mk = `m${tmpSeq++}`;
          const mo = `o${tmpSeq++}`;
          out.push(`{const ${t}=C.templates.get(${JSON.stringify(n.name)});if(${t}!==undefined&&D<${INCLUDE_DEPTH}){const ${mk}=${JSON.stringify(`${n.name}@`)}+(D+1);let ${mo}=C.memo.get(${mk});if(${mo}===undefined){const ${mo}p=[];${t}(S,C,${mo}p,D+1);${mo}=${mo}p.join("");C.memo.set(${mk},${mo});}O.push(${mo});}}`);
        } else {
          out.push(`{const ${t}=C.templates.get(${JSON.stringify(n.name)});if(${t}!==undefined&&D<${INCLUDE_DEPTH})${t}(S,C,O,D+1);}`);
        }
        break;
      }
    }
  }
}

/** A template compiled to a function (S scope stack, C helpers, O output parts, D include depth). */
function compileNodes(nodes, memoSet) {
  const out = [];
  genNodes(nodes, out, memoSet);
  return new Function('S', 'C', 'O', 'D', out.join('\n'));
}

/**
 * Which templates render the same on every page of a case: those whose transitive free root names
 * are only site/tags/recent (fixed per case), provided no {% for %} anywhere binds one of those
 * names (which would shadow the root value inside an include). Their include renders are memoized
 * per include depth in C.memo.
 */
function memoizableTemplates(parsed) {
  const boundAll = new Set();
  const freeMap = new Map();
  const edges = new Map();
  const walk = (nodes, bound, free, ed) => {
    for (const n of nodes) {
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        walk(n.then, bound, free, ed);
        if (n.else !== null) walk(n.else, bound, free, ed);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        boundAll.add(n.name);
        boundAll.add('loop');
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2, free, ed);
      } else if (n.kind === 'include') {
        ed.push({ target: n.name, bound: new Set(bound) });
      }
    }
  };
  for (const [name, nodes] of parsed) {
    const free = new Set();
    const ed = [];
    walk(nodes, new Set(), free, ed);
    freeMap.set(name, free);
    edges.set(name, ed);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, ed] of edges) {
      const f = freeMap.get(name);
      for (const e of ed) {
        const tf = freeMap.get(e.target);
        if (tf === undefined) continue;
        for (const x of tf) {
          if (!e.bound.has(x) && !f.has(x)) { f.add(x); changed = true; }
        }
      }
    }
  }
  const memoSet = new Set();
  if (!boundAll.has('site') && !boundAll.has('tags') && !boundAll.has('recent')) {
    for (const [name, f] of freeMap) {
      let ok = true;
      for (const x of f) if (x !== 'site' && x !== 'tags' && x !== 'recent') { ok = false; break; }
      if (ok) memoSet.add(name);
    }
  }
  return memoSet;
}

// ---------------------------------------------------------------- the build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dirParts, rel) {
  const parts = [...dirParts];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const slug = (t) => {
    let v = slugCache.get(t);
    if (v === undefined) { v = slugify(t); slugCache.set(t, v); }
    return v;
  };
  const dateCache = new Map();
  const ldate = (d) => {
    let v = dateCache.get(d);
    if (v === undefined) { v = longDate(d); dateCache.set(d, v); }
    return v;
  };

  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const memoSet = memoizableTemplates(parsed);
  const templates = new Map();
  for (const [name, nodes] of parsed) templates.set(name, compileNodes(nodes, memoSet));
  const C = { templates, esc, txt: textOf, escTxt: (v) => (typeof v === 'string' ? esc(v) : esc(textOf(v))), tru: truthy, root: lookupRoot, has: hasOwn, memo: new Map() };
  const base = input.site.base_url.replace(/\/+$/, '');

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  sources = kept;

  const bySource = new Map();
  {
    const taken = new Map();
    for (const s of sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      let set = taken.get(dir);
      if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
      s.slug = uniqueSlug(s.data.slug ?? slug(s.data.title), set);
      s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  const broken = new Set();
  {
    const staticPaths = new Set(statics.map((f) => f.path));
    for (const s of sources) {
      const dir = dirOf(s.path);
      const dirParts = dir === '' ? [] : dir.split('/');
      const link = (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      };
      const md = renderMarkdown(s.body, link, slug);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (!seen.has(sl)) { seen.add(sl); out.push({ name, slug: sl }); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug: sl } of ownTags(p)) {
      let tag = bySlug.get(sl);
      if (tag === undefined) { tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] }; bySlug.set(sl, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug: sl }) => bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : ldate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : ldate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn([{ site, tags: allTags, recent, ...vars }], C, out, 0);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
