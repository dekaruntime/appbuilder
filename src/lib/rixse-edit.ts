// rixse iteration: the agent changes a design only through typed edit ops,
// the way rixse agents change state through typed actions. It sees the whole
// current document and answers with one JSON op per line, applied as each
// line arrives, so the page changes in place instead of being rewritten.

export type EditOp =
  | { op: 'text'; sel: string; text: string; all?: boolean }
  | { op: 'html'; sel: string; html: string; all?: boolean }
  | { op: 'replace'; sel: string; html: string; all?: boolean }
  | { op: 'insert'; sel: string; where: 'before' | 'after' | 'prepend' | 'append'; html: string }
  | { op: 'remove'; sel: string; all?: boolean }
  | { op: 'attr'; sel: string; name: string; value: string | null; all?: boolean }
  | { op: 'css'; css: string }
  | { op: 'title'; text: string }
  | { op: 'full'; reason: string };

export const RIXSE_INSTRUCTIONS = `You edit an existing HTML design in place. You are given the WHOLE current document and a change request.

Answer ONLY with edit operations, one JSON object per line (JSON Lines). No prose, no Markdown fences, no full document.

Operations ("sel" is a CSS selector that must match in the current document; add "all": true to apply to every match, otherwise only the first match changes):
{"op":"text","sel":"...","text":"..."}                 replace an element's text
{"op":"html","sel":"...","html":"..."}                 replace an element's inner HTML
{"op":"replace","sel":"...","html":"..."}              replace the element itself
{"op":"insert","sel":"...","where":"before|after|prepend|append","html":"..."}
{"op":"remove","sel":"..."}
{"op":"attr","sel":"...","name":"...","value":"..."}   set an attribute (value null removes it)
{"op":"css","css":"..."}                               add CSS rules after the existing styles (later rules win; redefine :root custom properties here to change the palette)
{"op":"title","text":"..."}                           the document title
{"op":"full","reason":"..."}                           ONLY if the change rebuilds most of the page; send this line alone

Bulky data (SVG path geometry, embedded images) appears as tokens like RX_BULK_12. Each stands for data the app keeps. To keep that graphic when you move or rewrite its element, copy the token exactly; never invent new tokens, and write real new SVG when you draw something new.

Rules:
- Make the smallest set of edits that fully carries out the change, and keep everything the request does not touch exactly as it is.
- Change every place the request affects: copy, headings, product names, prices, image alt text, the title.
- Prefer precise selectors (ids, classes, :nth-of-type) that exist in the document you were given.
- New HTML follows the design's existing classes, tokens and conventions: no network resources, no lorem ipsum.`;

export function editRequest(ask: string, current: string): string {
  return `Current document:\n\n${current}\n\nChange: ${ask}`;
}

// Bulky data the model never needs to read: SVG path geometry and embedded
// data: URIs. The request carries a short token in its place; the document
// the ops apply to keeps the original, and tokens the model copies into new
// HTML are expanded back before the op is applied.
const BULK_TOKEN = /RX_BULK_(\d+)/g;
const BULKY = [
  /(\s(?:d|points)=")([^"]{80,})(")/g,
  /(\sd=')([^']{80,})(')/g,
  /()(data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]{120,})()/gi,
];

export type Collapsed = { text: string; bulk: string[] };

export function collapseBulk(html: string): Collapsed {
  const bulk: string[] = [];
  let text = html;
  for (const pattern of BULKY) {
    text = text.replace(pattern, (_, before: string, data: string, after: string) => {
      bulk.push(data);
      return `${before}RX_BULK_${bulk.length - 1}${after}`;
    });
  }
  return { text, bulk };
}

export function expandBulk(text: string, bulk: string[]): string {
  return text.replace(BULK_TOKEN, (token, index: string) => bulk[Number(index)] ?? token);
}

/** An op with every bulk token in its payload expanded back to the original data. */
export function expandOp(op: EditOp, bulk: string[]): EditOp {
  if (!bulk.length) return op;
  const expand = (value: string) => expandBulk(value, bulk);
  switch (op.op) {
    case 'html': case 'replace': case 'insert': return { ...op, html: expand(op.html) };
    case 'css': return { ...op, css: expand(op.css) };
    case 'attr': return { ...op, value: op.value === null ? null : expand(op.value) };
    default: return op;
  }
}

/** Complete JSON lines from a streaming answer; the unfinished tail stays behind. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map(line => line.trim()).filter(line => line && !line.startsWith('```')), rest };
}

export function parseOp(line: string): EditOp | null {
  try {
    const value = JSON.parse(line) as EditOp;
    return value && typeof value === 'object' && typeof value.op === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function parseDocument(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

export function serialize(doc: Document): string {
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function targets(doc: Document, sel: string, all: boolean | undefined): Element[] {
  try {
    return all ? [...doc.querySelectorAll(sel)] : [doc.querySelector(sel)].filter((el): el is Element => el !== null);
  } catch {
    return [];
  }
}

function fragment(doc: Document, html: string): DocumentFragment {
  const template = doc.createElement('template');
  template.innerHTML = html;
  return template.content;
}

/** Apply one op to the document in place. False when its selector matched nothing. */
export function applyOp(doc: Document, op: EditOp): boolean {
  switch (op.op) {
    case 'css': {
      const style = doc.createElement('style');
      style.setAttribute('data-rixse', '');
      style.textContent = op.css;
      doc.head.append(style);
      return true;
    }
    case 'title':
      doc.title = op.text;
      return true;
    case 'full':
      return true;
    case 'insert': {
      const [el] = targets(doc, op.sel, false);
      if (!el) return false;
      const where = { before: 'beforebegin', after: 'afterend', prepend: 'afterbegin', append: 'beforeend' }[op.where] as InsertPosition | undefined;
      if (!where) return false;
      el.insertAdjacentHTML(where, op.html);
      return true;
    }
    default: {
      const els = targets(doc, op.sel, op.all);
      for (const el of els) {
        if (op.op === 'text') el.textContent = op.text;
        else if (op.op === 'html') el.innerHTML = op.html;
        else if (op.op === 'replace') el.replaceWith(fragment(doc, op.html));
        else if (op.op === 'remove') el.remove();
        else if (op.op === 'attr') { if (op.value === null) el.removeAttribute(op.name); else el.setAttribute(op.name, op.value); }
      }
      return els.length > 0;
    }
  }
}
