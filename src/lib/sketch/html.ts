// sketch.md → a self-contained HTML document, shown in a sandboxed iframe.
// Runs in a Web Worker (sketch.worker.ts). Safety, by construction:
// - the model's text never becomes markup: the compiler emits a JSON spec,
//   and our fixed runtime below builds the DOM with textContent only;
// - {…} values are evaluated by the runtime's own small expression parser
//   (numbers, state, data columns, + - * / % ( ), round/min/max/abs/floor/ceil),
//   never eval or Function;
// - the document's CSP allows no network at all, and the iframe has no
//   same-origin access, so a sketch can't reach the app, its IPC or files.
import { parseSketch, splitTop, type Palette } from './compile';

export type SketchHtml = { name: string; html: string; screens: string[]; warnings: string[] };

type Action = { go: string } | { back: true } | { add: string; by: number } | { set: string; expr: string } | { toggle: string } | { step: string; by: 1 | -1 } | { pick: string };
type Btn = { label: string; primary: boolean; actions: Action[] };
type Node =
  | { t: 'title' | 'text' | 'note' | 'image'; text: string }
  | { t: 'space' }
  | { t: 'header'; title: string; buttons: Btn[] }
  | { t: 'row'; buttons: Btn[] }
  | { t: 'card'; head: string; lines: string[] }
  | { t: 'stat'; label: string; value: string }
  | { t: 'input'; placeholder: string; bind: string | null; numeric: boolean }
  | { t: 'tabs'; items: { label: string; screen: string | null }[] }
  | { t: 'list'; data: string | null; items: string[]; actions: Action[] };

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

  const node = (kind: string, body: string, line: number): Node => {
    switch (kind) {
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
    screens: sketch.screens.map(s => ({ name: s.name, transition: s.transition, nodes: s.blocks.map(b => node(b.kind, b.body, b.line)) })),
  };
  if (sketch.screens.some(s => s.raw.length)) warnings.push('```dsx blocks only run once the app is made real; the sketch leaves them out');
  return { name: sketch.name, screens, warnings, html: documentFor(spec, sketch.theme) };
}

// JSON inside a <script> element: "<" can't close it once escaped.
const embed = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

function documentFor(spec: unknown, p: Palette): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root { --bg: #${p.bg}; --ink: #${p.ink}; --card: #${p.card}; --soft: #${p.soft}; --muted: #${p.muted}; --accent: #${p.accent}; --accent-ink: #${p.accentInk}; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font: 15px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif; }
#app { height: 100%; overflow: hidden; position: relative; }
.screen { position: absolute; inset: 0; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 14px; }
.screen.slide { animation: slide .28s cubic-bezier(.22,1,.36,1); } .screen.fade { animation: fade .25s ease-out; } .screen.scale { animation: scale .25s cubic-bezier(.22,1,.36,1); }
@keyframes slide { from { transform: translateX(28px); opacity: 0; } } @keyframes fade { from { opacity: 0; } } @keyframes scale { from { transform: scale(.96); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .screen { animation: none !important; } }
h1 { margin: 0; font-size: 26px; line-height: 1.15; letter-spacing: -.01em; } p { margin: 0; } .note { color: var(--muted); font-size: 13px; }
.header { display: flex; align-items: center; justify-content: space-between; gap: 12px; } .header h2 { margin: 0; font-size: 19px; }
.row { display: flex; flex-wrap: wrap; gap: 10px; }
button { font: inherit; font-weight: 500; border: 0; border-radius: 10px; padding: 9px 16px; background: var(--soft); color: var(--ink); cursor: pointer; transition: transform .12s, filter .12s; }
button:hover { filter: brightness(.97); } button:active { transform: scale(.97); } button.primary { background: var(--accent); color: var(--accent-ink); }
.card { background: var(--card); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 4px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
.card b { font-size: 17px; } .card span { color: var(--muted); font-size: 14px; }
.image { height: 180px; flex: none; border-radius: 14px; background: var(--soft); display: grid; place-items: center; color: var(--muted); }
.stat { background: var(--card); border-radius: 14px; padding: 14px 16px; } .stat span { color: var(--muted); font-size: 13px; } .stat b { display: block; font-size: 28px; font-variant-numeric: tabular-nums; }
input { font: inherit; width: 100%; padding: 11px 14px; border-radius: 10px; border: 1px solid var(--soft); background: var(--card); color: var(--ink); outline: none; } input:focus { border-color: var(--accent); }
.tabs { display: flex; gap: 4px; padding: 4px; border-radius: 12px; background: var(--soft); margin-top: auto; } .tabs button { flex: 1; background: transparent; color: var(--muted); } .tabs button.on { background: var(--card); color: var(--ink); }
.list { display: flex; flex-direction: column; gap: 8px; } .list button, .list div { text-align: left; background: var(--card); padding: 12px 14px; border-radius: 12px; } .list button.on { outline: 2px solid var(--accent); }
.space { height: 8px; flex: none; }
</style></head><body><div id="app"></div>
<script type="application/json" id="spec">${embed(spec)}</script>
<script>${RUNTIME}</script></body></html>`;
}

// The runtime inside the sandboxed document. Fixed code: only the spec varies.
const RUNTIME = String.raw`(() => {
const spec = JSON.parse(document.getElementById('spec').textContent);
const state = Object.assign({}, spec.state);
const cursor = {}; for (const k in spec.data) cursor[k] = 0;
let screen = spec.screens[0] ? spec.screens[0].name : '';
let back = screen;
const report = (kind, detail) => { try { parent.postMessage({ zegaSketch: kind, detail: String(detail) }, '*'); } catch (_) {} };
const FUNCS = { round: (x, d) => { const f = Math.pow(10, d || 0); return Math.round(x * f) / f; }, min: Math.min, max: Math.max, abs: Math.abs, floor: Math.floor, ceil: Math.ceil };

// value: numbers, "text", state names, data.column, + - * / % ( ), FUNCS(...)
function evaluate(source) {
  const tokens = source.match(/\s*(\d+(?:\.\d+)?|"[^"]*"|[A-Za-z_]\w*(?:\.\d+)?|[-+*\/%(),])/g) || [];
  let i = 0;
  const peek = () => (tokens[i] || '').trim(), take = () => (tokens[i++] || '').trim();
  function atom() {
    const t = take();
    if (t === '(') { const v = sum(); take(); return v; }
    if (t === '-') return -atom();
    if (/^\d/.test(t)) return Number(t);
    if (t[0] === '"') return t.slice(1, -1);
    if (FUNCS[t] && peek() === '(') { take(); const args = []; while (peek() && peek() !== ')') { args.push(sum()); if (peek() === ',') take(); } take(); return FUNCS[t].apply(null, args.map(Number)); }
    const col = t.match(/^(\w+)\.(\d+)$/);
    if (col && spec.data[col[1]]) { const row = spec.data[col[1]][cursor[col[1]]] || []; const v = row[Number(col[2]) - 1]; return v === undefined ? '' : v; }
    if (t in state) return state[t];
    throw new Error('unknown value: ' + t);
  }
  function product() { let v = atom(); while (['*', '/', '%'].includes(peek())) { const op = take(), r = atom(); v = op === '*' ? v * r : op === '/' ? (r === 0 ? 0 : v / r) : v % r; } return v; }
  function sum() { let v = product(); while (['+', '-'].includes(peek())) { const op = take(), r = product(); v = op === '+' ? (typeof v === 'number' && typeof r === 'number' ? v + r : String(v) + String(r)) : v - r; } return v; }
  return sum();
}
const show = v => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '')) : String(v);
const fill = text => text.replace(/\{([^}]+)\}/g, (_, expr) => { try { return show(evaluate(expr)); } catch (e) { return '?'; } });

function run(actions, index) {
  for (const a of actions) {
    if (a.go) { back = screen; screen = a.go; }
    else if (a.back) { const s = screen; screen = back; back = s; }
    else if ('add' in a) state[a.add] = Number(state[a.add] || 0) + a.by;
    else if ('set' in a) { try { state[a.set] = evaluate(a.expr); } catch (e) { report('error', e.message); } }
    else if (a.toggle) state[a.toggle] = state[a.toggle] ? 0 : 1;
    else if (a.step) { const n = spec.data[a.step].length; cursor[a.step] = (cursor[a.step] + a.by + n) % n; }
    else if (a.pick && index !== undefined) cursor[a.pick] = index;
  }
  render();
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
function btn(b) { const e = el('button', b.primary ? 'primary' : '', fill(b.label)); e.addEventListener('click', () => run(b.actions)); return e; }

let shown = null;
function render() {
  const app = document.getElementById('app');
  const s = spec.screens.find(x => x.name === screen) || spec.screens[0];
  if (!s) return;
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.bind : null;
  const scroll = app.firstChild ? app.firstChild.scrollTop : 0;
  const root = el('div', 'screen' + (shown !== s.name && s.transition !== 'none' ? ' ' + s.transition : ''));
  for (const n of s.nodes) {
    if (n.t === 'title') root.append(el('h1', '', fill(n.text)));
    else if (n.t === 'text') root.append(el('p', '', fill(n.text)));
    else if (n.t === 'note') root.append(el('p', 'note', fill(n.text)));
    else if (n.t === 'image') root.append(el('div', 'image', fill(n.text)));
    else if (n.t === 'space') root.append(el('div', 'space'));
    else if (n.t === 'header') { const h = el('div', 'header'); h.append(el('h2', '', fill(n.title))); const r = el('div', 'row'); n.buttons.forEach(b => r.append(btn(b))); h.append(r); root.append(h); }
    else if (n.t === 'row') { const r = el('div', 'row'); n.buttons.forEach(b => r.append(btn(b))); root.append(r); }
    else if (n.t === 'card') { const c = el('div', 'card'); c.append(el('b', '', fill(n.head))); n.lines.forEach(l => c.append(el('span', '', fill(l)))); root.append(c); }
    else if (n.t === 'stat') { const c = el('div', 'stat'); c.append(el('span', '', fill(n.label)), el('b', '', fill(n.value))); root.append(c); }
    else if (n.t === 'input') {
      const i = el('input'); i.placeholder = fill(n.placeholder);
      if (n.bind) { i.dataset.bind = n.bind; i.value = state[n.bind] === undefined ? '' : String(state[n.bind]); if (n.numeric) i.inputMode = 'decimal';
        i.addEventListener('input', () => { state[n.bind] = n.numeric ? (Number(i.value) || 0) : i.value; update(); }); }
      root.append(i);
    }
    else if (n.t === 'tabs') { const t = el('div', 'tabs'); n.items.forEach(it => { const b = el('button', it.screen === screen ? 'on' : '', fill(it.label)); if (it.screen) b.addEventListener('click', () => run([{ go: it.screen }])); t.append(b); }); root.append(t); }
    else if (n.t === 'list') {
      const l = el('div', 'list');
      if (n.data) spec.data[n.data].forEach((row, index) => { const b = el('button', index === cursor[n.data] ? 'on' : '', row.join(' · ')); b.addEventListener('click', () => run(n.actions, index)); l.append(b); });
      else n.items.forEach(item => l.append(el('div', '', fill(item))));
      root.append(l);
    }
  }
  app.replaceChildren(root);
  if (shown === s.name) root.scrollTop = scroll;
  shown = s.name;
  if (focused) { const again = root.querySelector('[data-bind="' + focused + '"]'); if (again) { again.focus(); const v = again.value; again.setSelectionRange(v.length, v.length); } }
}
// Typing re-renders the screen; render() puts focus and the caret back.
function update() { render(); }
window.addEventListener('error', e => report('error', e.message));
try { render(); report('ready', screen); } catch (e) { report('error', e.message); }
})();`;
