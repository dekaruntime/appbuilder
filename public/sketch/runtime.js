// The zega sketch runtime: runs inside the sketch's sandboxed iframe. Fixed
// code shipped with the app; only the JSON spec it reads varies. Builds the
// DOM with textContent only and evaluates {…} with its own parser, never eval.
(() => {
const spec = JSON.parse(document.getElementById('spec').textContent);
// Theme colours from the spec, set through the CSSOM (no inline styles needed).
for (const [k, v] of Object.entries(spec.theme || {})) document.documentElement.style.setProperty('--' + k, '#' + v);
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

// @width 1/3 | 320, @height 200, @align left|center|right, @gap tight|loose,
// @grow, @scroll, @sticky — applied through the CSSOM (no inline style text).
function applyMods(e, m) {
  if (!m) return;
  if (m.width) { const f = m.width.match(/^(\d+)\/(\d+)$/); e.style.width = f ? (100 * f[1] / f[2]) + '%' : (/^\d+$/.test(m.width) ? m.width + 'px' : ''); e.style.flex = 'none'; }
  if (m.height && /^\d+$/.test(m.height)) e.style.height = m.height + 'px';
  if (m.align) { const a = { left: 'flex-start', start: 'flex-start', center: 'center', right: 'flex-end', end: 'flex-end' }[m.align.trim()]; if (a) { e.style.alignSelf = a; e.style.textAlign = m.align.trim() === 'center' ? 'center' : ''; } }
  if (m.gap) e.style.gap = { tight: '6px', normal: '14px', loose: '26px' }[m.gap.trim()] || '';
  if (m.grow) e.style.flex = '1 1 0';
  if (m.scroll) { e.style.overflowY = 'auto'; e.style.minHeight = '0'; }
  if (m.sticky) { e.style.position = 'sticky'; e.style.top = '0'; e.style.zIndex = '1'; }
}

function draw(n, index) {
  let e;
  if (n.t === 'title') e = el('h1', '', fill(n.text));
  else if (n.t === 'subtitle') e = el('h3', '', fill(n.text));
  else if (n.t === 'text') e = el('p', '', fill(n.text));
  else if (n.t === 'note') e = el('p', 'note', fill(n.text));
  else if (n.t === 'image') e = el('div', 'image', fill(n.text));
  else if (n.t === 'space') e = el('div', 'space');
  else if (n.t === 'header') { e = el('div', 'header'); e.append(el('h2', '', fill(n.title))); const r = el('div', 'row'); n.buttons.forEach(b => r.append(btn(b))); e.append(r); }
  else if (n.t === 'row') { e = el('div', 'row'); n.buttons.forEach(b => e.append(btn(b))); }
  else if (n.t === 'card') { e = el('div', 'card'); e.append(el('b', '', fill(n.head))); n.lines.forEach(l => e.append(el('span', '', fill(l)))); }
  else if (n.t === 'tile') {
    e = el('button', 'tile'); e.append(el('b', '', fill(n.head))); n.lines.forEach(l => e.append(el('span', '', fill(l))));
    e.addEventListener('click', () => run(n.actions, index));
  }
  else if (n.t === 'stat') { e = el('div', 'stat'); e.append(el('span', '', fill(n.label)), el('b', '', fill(n.value))); }
  else if (n.t === 'input') {
    e = el('input'); e.placeholder = fill(n.placeholder);
    if (n.bind) { e.dataset.bind = n.bind; e.value = state[n.bind] === undefined ? '' : String(state[n.bind]); if (n.numeric) e.inputMode = 'decimal';
      e.addEventListener('input', () => { state[n.bind] = n.numeric ? (Number(e.value) || 0) : e.value; update(); }); }
  }
  else if (n.t === 'tabs') { e = el('div', 'tabs'); n.items.forEach(it => { const b = el('button', it.screen === screen ? 'on' : '', fill(it.label)); if (it.screen) b.addEventListener('click', () => run([{ go: it.screen }])); e.append(b); }); }
  else if (n.t === 'list') {
    e = el('div', 'list');
    if (n.data) spec.data[n.data].forEach((row, i) => { const b = el('button', i === cursor[n.data] ? 'on' : '', row.join(' · ')); b.addEventListener('click', () => run(n.actions, i)); e.append(b); });
    else n.items.forEach(item => e.append(el('div', '', fill(item))));
  }
  else if (n.t === 'table') {
    e = el('div', 'table-wrap'); const t = el('table');
    const cellEl = (c, tag) => { const td = el(tag); if (c.button) td.append(btn(c.button)); else td.textContent = fill(c.text); return td; };
    if (n.header.length) { const tr = el('tr'); n.header.forEach(c => tr.append(cellEl(c, 'th'))); const head = el('thead'); head.append(tr); t.append(head); }
    const body = el('tbody'); n.rows.forEach(r => { const tr = el('tr'); r.forEach(c => tr.append(cellEl(c, 'td'))); body.append(tr); }); t.append(body);
    e.append(t);
  }
  else if (n.t === 'box') {
    e = el('div', 'box ' + n.kind);
    if (n.kind === 'grid') e.style.gridTemplateColumns = 'repeat(' + Math.max(1, n.cols) + ', minmax(0, 1fr))';
    n.children.forEach(c => drawInto(e, c));
  }
  else e = el('p', '', '');
  applyMods(e, n.mods);
  return e;
}

// A block with `from <data>` is drawn once per row, each with that row as
// the current item (so {menu.1} and → pick refer to it).
function drawInto(parent, n) {
  if (!n.from) { parent.append(draw(n)); return; }
  const rows = spec.data[n.from] || [];
  const saved = cursor[n.from];
  rows.forEach((_, i) => { cursor[n.from] = i; parent.append(draw(n, i)); });
  cursor[n.from] = saved;
}

function render() {
  const app = document.getElementById('app');
  const s = spec.screens.find(x => x.name === screen) || spec.screens[0];
  if (!s) return;
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.bind : null;
  const scrolls = [...app.querySelectorAll('.region')].map(r => r.scrollTop);
  const root = el('div', 'screen' + (shown !== s.name && s.transition !== 'none' ? ' ' + s.transition : ''));
  // layout: sidebar right 340 | sidebar left 300 | centered 480 | split
  const layout = (s.layout || '').split(/\s+/);
  const main = el('div', 'region main');
  s.nodes.forEach(n => drawInto(main, n));
  if (layout[0] === 'sidebar' || layout[0] === 'split' || (s.side && s.side.length)) {
    root.classList.add('with-side');
    const side = el('div', 'region side');
    (s.side || []).forEach(n => drawInto(side, n));
    const width = layout.find(w => /^\d+$/.test(w));
    if (layout[0] === 'split') { side.style.flex = '1 1 0'; main.style.flex = '1 1 0'; }
    else if (width) side.style.width = width + 'px';
    if (layout.includes('left')) root.append(side, main); else root.append(main, side);
  } else {
    if (layout[0] === 'centered') { const w = layout.find(x => /^\d+$/.test(x)) || '520'; main.style.maxWidth = w + 'px'; main.style.marginInline = 'auto'; main.style.width = '100%'; }
    root.append(main);
  }
  app.replaceChildren(root);
  if (shown === s.name) [...root.querySelectorAll('.region')].forEach((r, i) => { r.scrollTop = scrolls[i] || 0; });
  shown = s.name;
  if (focused) { const again = root.querySelector('[data-bind="' + focused + '"]'); if (again) { again.focus(); const v = again.value; again.setSelectionRange(v.length, v.length); } }
}
// Typing re-renders the screen; render() puts focus and the caret back.
function update() { render(); }
window.addEventListener('error', e => report('error', e.message));
try { render(); report('ready', screen); } catch (e) { report('error', e.message); }
})();
