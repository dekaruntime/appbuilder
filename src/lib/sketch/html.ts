// sketch.md → a self-contained HTML document, shown in a sandboxed iframe.
// Runs in a Web Worker (sketch.worker.ts). Safety, by construction:
// - the model's text never becomes markup: the compiler emits a JSON spec,
//   and our fixed runtime below builds the DOM with textContent only;
// - {…} values are evaluated by the runtime's own small expression parser
//   (numbers, state, data columns, + - * / % ( ), round/min/max/abs/floor/ceil),
//   never eval or Function;
// - the document's CSP allows no network at all, and the iframe has no
//   same-origin access, so a sketch can't reach the app, its IPC or files.
import { parseSketch, splitTop, type Block, type Palette } from './compile';

export type SketchHtml = { name: string; html: string; screens: string[]; warnings: string[] };

type Action = { go: string } | { back: true } | { add: string; by: number } | { set: string; expr: string } | { toggle: string } | { step: string; by: 1 | -1 } | { pick: string };
type Btn = { label: string; primary: boolean; actions: Action[] };
// Layout constraints any block can carry: @width 1/3, @align center, …
type Mods = { width?: string; height?: string; align?: string; gap?: string; grow?: boolean; scroll?: boolean; sticky?: boolean };
type Node = (
  | { t: 'title' | 'subtitle' | 'text' | 'note' | 'image'; text: string }
  | { t: 'space' }
  | { t: 'header'; title: string; buttons: Btn[] }
  | { t: 'row'; buttons: Btn[] }
  | { t: 'card'; head: string; lines: string[] }
  | { t: 'stat'; label: string; value: string }
  | { t: 'input'; placeholder: string; bind: string | null; numeric: boolean }
  | { t: 'tabs'; items: { label: string; screen: string | null }[] }
  | { t: 'list'; data: string | null; items: string[]; actions: Action[] }
  | { t: 'box'; kind: 'grid' | 'row' | 'columns' | 'stack' | 'panel'; cols: number; children: Node[] }
  | { t: 'tile'; head: string; lines: string[]; actions: Action[] }
  | { t: 'table'; header: Cell[]; rows: Cell[][] }) & { mods?: Mods; from?: string };
// A table cell: text with {values}, or a button.
type Cell = { text: string } | { button: Btn };

export function compileSketchHtml(markdown: string): SketchHtml {
  const sketch = parseSketch(markdown);
  const warnings = [...sketch.warnings];
  const screens = sketch.screens.map(s => s.name);
  const screenNames = new Map(screens.map(n => [n.toLowerCase(), n]));
  const stateNames = new Set(sketch.state.map(([k]) => k));

  const actions = (list: string, pickFrom?: string): Action[] => splitTop(list, ',').flatMap((action): Action[] => {
    let m: RegExpMatchArray | null;
    const target = screenNames.get(action.toLowerCase());
    if (target) return pickFrom ? [{ pick: pickFrom }, { go: target }] : [{ go: target }];
    if (/^back$/i.test(action)) return [{ back: true }];
    if ((m = action.match(/^(\w+)\s*([+-])\s*(\d+(?:\.\d+)?)$/))) return [{ add: m[1], by: Number(m[3]) * (m[2] === '-' ? -1 : 1) }];
    if ((m = action.match(/^(\w+)\s*=\s*(.+)$/))) return [{ set: m[1], expr: m[2].trim() }];
    if ((m = action.match(/^toggle\s+(\w+)$/i))) return [{ toggle: m[1] }];
    if ((m = action.match(/^(next|prev)\s+(\w+)$/i)) && sketch.data.has(m[2])) return [{ step: m[2], by: m[1].toLowerCase() === 'next' ? 1 : -1 }];
    if ((m = action.match(/^pick$/i)) && pickFrom) return [{ pick: pickFrom }];
    warnings.push(`unknown action "${action}": ignored`);
    return [];
  });

  const button = (spec: string): Btn | null => {
    const m = spec.match(/^\[(.+?)\](\*)?\s*(?:→|->)?\s*(.*)$/);
    return m ? { label: m[1], primary: !!m[2], actions: m[3] ? actions(m[3]) : [] } : null;
  };
  const buttons = (body: string) => splitTop(body, '|').map(button).filter((b): b is Btn => !!b);
  const clean = (text: string) => text.replace(/\*\*(.+?)\*\*/g, '$1').trim();

  const MOD = /\s*@(width|height|align|gap|grow|scroll|sticky)\b\s*([^@]*)/gi;
  const mods = (body: string): [string, Mods | undefined] => {
    const found: Mods = {};
    let any = false;
    const rest = body.replace(MOD, (_, key: string, value: string) => {
      any = true;
      const v = value.trim();
      if (key === 'grow' || key === 'scroll' || key === 'sticky') found[key as 'grow'] = true;
      else found[key as 'width'] = v;
      return ' ';
    }).trim();
    return [rest, any ? found : undefined];
  };
  const cell = (text: string): Cell => { const b = button(text); return b ? { button: b } : { text: clean(text) }; };
  // A component use: "- MenuItem: Classic, 4, Peeled" → its blocks with
  // {name} {price} {note} replaced by the arguments.
  const expand = (b: Block, depth: number): Node => {
    const c = sketch.components.get(b.kind)!;
    const [args, m] = mods(b.body);
    const values = splitTop(args, ',');
    const substitute = (blk: Block): Block => ({ ...blk, body: c.params.reduce((t, p, i) => t.replace(new RegExp(`\\{${p}\\}`, 'g'), values[i] ?? ''), blk.body), children: blk.children.map(substitute) });
    const made: Node = { t: 'box', kind: 'stack', cols: 1, children: depth > 8 ? [] : c.blocks.map(substitute).map(x => build(x, depth + 1)) };
    if (m) made.mods = m;
    if (b.from) made.from = b.from;
    return made;
  };
  const build = (b: Block, depth = 0): Node => {
    if (sketch.components.has(b.kind)) return expand(b, depth);
    const [body, m] = mods(b.body);
    const made = node(b.kind, body, b.line, b);
    if (m) made.mods = m;
    if (b.from) {
      if (sketch.data.has(b.from)) made.from = b.from;
      else warnings.push(`line ${b.line}: no data list called "${b.from}"`);
    }
    return made;
  };
  const node = (kind: string, body: string, line: number, b: Block): Node => {
    switch (kind) {
      case 'subtitle': return { t: 'subtitle', text: clean(body) };
      case 'grid': case 'row': case 'columns': case 'stack': case 'panel': {
        const cols = Number(body.match(/\d+/)?.[0] ?? (kind === 'columns' ? Math.max(1, b.children.length) : 3));
        return { t: 'box', kind, cols, children: b.children.map(child => build(child)) };
      }
      case 'tile': {
        const m = body.match(/^(.*?)\s*(?:→|->)\s*(.+)$/);
        const [head, ...rest] = (m ? m[1] : body).split('·').map(clean);
        return { t: 'tile', head: head ?? '', lines: rest, actions: m ? actions(m[2], b.from) : [] };
      }
      case 'table': {
        const [header = [], ...rows] = b.rows ?? [];
        return { t: 'table', header: header.map(cell), rows: rows.map((r: string[]) => r.map(cell)) };
      }
      case 'title': case 'text': case 'note': return { t: kind, text: clean(body) };
      case 'image': case 'photo': return { t: 'image', text: clean(body) || 'Image' };
      case 'space': return { t: 'space' };
      case 'header': { const [title, ...rest] = splitTop(body, '|'); return { t: 'header', title: clean(title ?? ''), buttons: rest.map(button).filter((b): b is Btn => !!b) }; }
      case 'row': case 'buttons': case 'button': return { t: 'row', buttons: buttons(body) };
      case 'card': { const [head, ...rest] = body.split('·').map(clean); return { t: 'card', head: head ?? '', lines: rest }; }
      case 'stat': { const [label, value] = splitTop(body, '|'); return { t: 'stat', label: clean(label ?? ''), value: clean(value ?? '') }; }
      case 'input': case 'search': {
        const m = body.match(/^(.*?)\s*(?:→|->)\s*(\w+)\s*$/);
        const bind = m && stateNames.has(m[2]) ? m[2] : null;
        const initial = bind ? sketch.state.find(([k]) => k === bind)?.[1] ?? '' : '';
        return { t: 'input', placeholder: clean(m ? m[1] : body), bind, numeric: /^-?\d/.test(initial) };
      }
      case 'tabs': return { t: 'tabs', items: splitTop(body, '|').map(label => ({ label: clean(label), screen: screenNames.get(label.trim().toLowerCase()) ?? null })) };
      case 'list': {
        const m = body.match(/^(\w+)\s*(?:(?:→|->)\s*(.+))?$/);
        if (m && sketch.data.has(m[1])) return { t: 'list', data: m[1], items: [], actions: m[2] ? actions(m[2], m[1]) : [{ pick: m[1] }] };
        return { t: 'list', data: null, items: splitTop(body, ',').map(clean), actions: [] };
      }
      default:
        warnings.push(`line ${line}: unknown block "${kind}", shown as text`);
        return { t: 'text', text: clean(body) };
    }
  };

  const spec = {
    name: sketch.name,
    state: Object.fromEntries(sketch.state.map(([k, v]) => [k, /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v.replace(/^"|"$/g, '')])),
    data: Object.fromEntries(sketch.data),
    screens: sketch.screens.map(s => ({ name: s.name, transition: s.transition, layout: s.layout, nodes: s.blocks.map(b => build(b)), side: s.side.map(b => build(b)) })),
  };
  if (sketch.screens.some(s => s.raw.length)) warnings.push('```dsx blocks only run once the app is made real; the sketch leaves them out');
  return { name: sketch.name, screens, warnings, html: documentFor(spec, sketch.theme) };
}

// JSON inside a <script> element: "<" can't close it once escaped.
const embed = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

function documentFor(spec: Record<string, unknown>, p: Palette): string {
  const theme = { bg: p.bg, ink: p.ink, card: p.card, soft: p.soft, muted: p.muted, accent: p.accent, 'accent-ink': p.accentInk };
  // No inline code or styles: the runtime and stylesheet are files shipped
  // with the app (allowed by the app's own CSP, which this srcdoc document
  // inherits), and the spec is a non-executable JSON block. The meta policy
  // adds: no network, no frames, no forms.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'">
<link rel="stylesheet" href="/sketch/frame.css">
</head><body><div id="app"></div>
<script type="application/json" id="spec">${embed({ ...spec, theme })}</script>
<script src="/sketch/runtime.js"></script></body></html>`;
}
