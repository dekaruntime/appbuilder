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
})();
