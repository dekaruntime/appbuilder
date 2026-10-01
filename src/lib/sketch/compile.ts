// Sketch → DekaScript. A sketch is one Markdown file a person or a model can
// write in seconds; this turns it, deterministically, into a DekaScript app
// for deka 0.60.1's VM, using only constructs and style classes that VM
// accepts (crates/deka_vm/src/compiler.rs, crates/deka_native_ir/src/style.rs).
// Lines it doesn't understand become plain text plus a warning, so a sketch
// always opens.
//
// # Horse Tinder                       app name
// theme: warm                          warm | dark | ocean | forest | mono
// state: likes = 0, mood = "hopeful"   numbers or "text"
// data horses: Clover, 8, Connemara | Maple, 5, Fjord
//
// ## Swipe                             a screen (the first one opens first)
// transition: slide                    slide | fade | scale | none
// - header: Stablemate | [Likes: {likes}] → Matches
// - image: {horses.1}
// - card: **{horses.1}, {horses.2}** · {horses.3}
// - row: [Pass] → next horses | [Like]* → likes +1, next horses
// - list: horses → Profile
// - stat: Likes | {likes}
// - tabs: Swipe | Matches
// - input: Search horses
// - text / title / note / space
//
// Actions after →, comma separated: a screen name, back, x +1, x -1,
// x = value, toggle x, next <data>, prev <data>.

export type SketchResult = { name: string; source: string; screens: string[]; warnings: string[]; rawBlocks: number };

export type Palette = { bg: string; ink: string; card: string; soft: string; muted: string; accent: string; accentInk: string };
const THEMES: Record<string, Palette> = {
  warm: { bg: 'F6F1E7', ink: '1F1A14', card: 'FFFDF8', soft: 'EDE4D3', muted: '8A7F72', accent: 'C2512B', accentInk: 'FFFFFF' },
  dark: { bg: '14161B', ink: 'ECEEF2', card: '1E2129', soft: '2A2E38', muted: '8B92A1', accent: '7C9CFF', accentInk: '0E1016' },
  ocean: { bg: 'EEF4F8', ink: '0F2233', card: 'FFFFFF', soft: 'DCE7EF', muted: '647789', accent: '1F6FB2', accentInk: 'FFFFFF' },
  forest: { bg: 'EFF3EC', ink: '17241A', card: 'FFFFFF', soft: 'DDE6D8', muted: '6B7A6D', accent: '2F7D4A', accentInk: 'FFFFFF' },
  mono: { bg: 'F4F4F2', ink: '161616', card: 'FFFFFF', soft: 'E6E6E3', muted: '7A7A76', accent: '161616', accentInk: 'FFFFFF' },
};

const MOTION: Record<string, string> = { slide: 'enter-slide duration-300', fade: 'enter-fade duration-300', scale: 'enter-scale duration-300', none: '' };

// A block can hold blocks (containers nest by indentation), repeat once per
// row of a data list (`from`), or be a Markdown table (`rows`).
export type Block = { kind: string; body: string; line: number; children: Block[]; from?: string; rows?: string[][] };
// A screen has a main region and, with `layout: sidebar …`, a side region.
export type Screen = { name: string; transition: string; layout: string; blocks: Block[]; side: Block[]; raw: string[] };
// A component: a named group of blocks with parameters, used like a block.
export type Component = { name: string; params: string[]; blocks: Block[] };
export type Sketch = { name: string; theme: Palette; state: [string, string][]; data: Map<string, string[][]>; screens: Screen[]; components: Map<string, Component>; warnings: string[] };

const ident = (text: string) => text.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'value';
const str = (text: string) => JSON.stringify(text);

const newScreen = (name: string, transition = 'slide'): Screen => ({ name, transition, layout: '', blocks: [], side: [], raw: [] });
const indentOf = (line: string) => (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '  ').length;

export function parseSketch(markdown: string): Sketch {
  const sketch: Sketch = { name: 'Untitled app', theme: THEMES.warm, state: [], data: new Map(), screens: [], components: new Map(), warnings: [] };
  let screen: Screen | null = null;
  let region: Block[] = [];
  // Open containers, innermost last: a block goes inside the nearest one
  // indented less than it.
  let stack: { indent: number; block: Block }[] = [];
  let fence: string[] | null = null;
  const place = (block: Block, indent: number) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1].block.children : region).push(block);
    stack.push({ indent, block });
  };
  const ensureScreen = () => { if (!screen) { screen = newScreen('Home', 'none'); sketch.screens.push(screen); region = screen.blocks; stack = []; } return screen; };
  markdown.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trimEnd();
    if (fence) {
      if (line.trim().startsWith('```')) { if (screen) screen.raw.push(fence.join('\n')); fence = null; }
      else fence.push(rawLine);
      return;
    }
    if (line.trim().startsWith('```')) { fence = []; return; }
    if (!line.trim()) return;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^#\s+(.+)$/))) { sketch.name = m[1].trim(); return; }
    if ((m = line.match(/^##\s+component\s+(\w+)\s*(?:\(([^)]*)\))?\s*$/i))) {
      // Its blocks are collected in a screen that isn't shown.
      const holder = newScreen(`component:${m[1]}`);
      sketch.components.set(m[1].toLowerCase(), { name: m[1], params: (m[2] ?? '').split(',').map(p => p.trim()).filter(Boolean), blocks: holder.blocks });
      screen = holder; region = holder.blocks; stack = [];
      return;
    }
    if ((m = line.match(/^##\s+(.+)$/))) { screen = newScreen(m[1].trim()); sketch.screens.push(screen); region = screen.blocks; stack = []; return; }
    if ((m = line.match(/^###\s+(.+)$/))) {
      const s = ensureScreen();
      if (/^side(bar)?$/i.test(m[1].trim())) { region = s.side; stack = []; if (!s.layout) s.layout = 'sidebar right 320'; }
      else { stack = []; region.push({ kind: 'subtitle', body: m[1].trim(), line: index + 1, children: [] }); }
      return;
    }
    if ((m = line.match(/^theme:\s*(\w+)/i))) { sketch.theme = THEMES[m[1].toLowerCase()] ?? sketch.theme; return; }
    if ((m = line.match(/^state:\s*(.+)$/i))) {
      for (const part of splitTop(m[1], ',')) {
        const [k, v] = part.split('=').map(s => s.trim());
        if (k) sketch.state.push([ident(k), v ?? '0']);
      }
      return;
    }
    if ((m = line.match(/^data\s+(\w+):\s*(.+)$/i))) {
      sketch.data.set(m[1], m[2].split('|').map(row => row.split(',').map(cell => cell.trim())));
      return;
    }
    if (screen && (m = line.match(/^transition:\s*(\w+)/i))) { screen.transition = m[1].toLowerCase(); return; }
    if (screen && (m = line.match(/^layout:\s*(.+)$/i))) { screen.layout = m[1].trim().toLowerCase(); return; }
    // A Markdown table row; consecutive rows build one table.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      ensureScreen();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return;
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
      const indent = indentOf(line);
      const top = stack[stack.length - 1];
      if (top && top.block.kind === 'table' && top.indent === indent) top.block.rows!.push(cells);
      else place({ kind: 'table', body: '', line: index + 1, children: [], rows: [cells] }, indent);
      return;
    }
    if ((m = line.match(/^(\s*)[-*]\s+(\w+)(?:\s+from\s+(\w+))?\s*:\s*(.*)$/))) {
      ensureScreen();
      place({ kind: m[2].toLowerCase(), body: m[4], line: index + 1, children: [], from: m[3] }, indentOf(line));
      return;
    }
    if ((m = line.match(/^(\s*)[-*]\s+(space)\s*$/i))) { ensureScreen(); place({ kind: 'space', body: '', line: index + 1, children: [] }, indentOf(line)); return; }
    if (screen) { place({ kind: 'text', body: line.replace(/^\s*[-*>]\s*/, ''), line: index + 1, children: [] }, indentOf(line)); return; }
    sketch.warnings.push(`line ${index + 1}: not part of a screen, skipped: ${line.trim()}`);
  });
  if (!sketch.screens.length) sketch.screens.push({ ...newScreen('Home', 'none'), blocks: [{ kind: 'title', body: sketch.name, line: 1, children: [] }] });
  return sketch;
}

/** Every block in reading order, containers opened up (for the DekaScript draft). */
export function flattenBlocks(blocks: Block[]): Block[] {
  return blocks.flatMap(b => {
    if (b.kind === 'table') return (b.rows ?? []).map(r => ({ kind: 'text', body: r.join(' · '), line: b.line, children: [] }));
    if (b.kind === 'tile') return [{ ...b, kind: 'card', children: [] }];
    if (['grid', 'row', 'columns', 'stack', 'panel'].includes(b.kind)) return flattenBlocks(b.children);
    return [{ ...b, children: [] }, ...flattenBlocks(b.children)];
  });
}

/** Split on a separator that isn't inside [ ] or { }. */
export function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, current = '';
  for (const c of text) {
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) { out.push(current); current = ''; } else current += c;
  }
  out.push(current);
  return out.map(s => s.trim()).filter(Boolean);
}

/** `skipRaw`: indexes of ```dsx blocks to leave out (ones that don't compile). */
export function compileSketch(markdown: string, skipRaw: Set<number> = new Set()): SketchResult {
  const sketch = parseSketch(markdown);
  let rawIndex = 0;
  const p = sketch.theme;
  const warnings = [...sketch.warnings];
  const screens = sketch.screens.map(s => s.name);
  const screenNames = new Map(screens.map(n => [n.toLowerCase(), n]));
  const stateNames = new Set(sketch.state.map(([k]) => k));

  // Text with {state} and {data.column} holes → JSX children.
  const text = (body: string): string => {
    const cleaned = body.replace(/\*\*(.+?)\*\*/g, '$1');
    return cleaned.split(/(\{[^}]+\})/).filter(Boolean).map(part => {
      const hole = part.match(/^\{\s*([\w]+)(?:\.(\d+))?\s*\}$/);
      // Arithmetic on state: {bill * tip / 100}, {(bill + tip) / people}.
      const sum = !hole && part.match(/^\{([\w\s.+\-*/()]+)\}$/);
      if (sum) {
        const names = sum[1].match(/[A-Za-z_]\w*/g) ?? [];
        const unknown = names.filter(n => !stateNames.has(ident(n)));
        if (!unknown.length) return `{${sum[1].replace(/[A-Za-z_]\w*/g, n => ident(n)).trim()}}`;
        warnings.push(`unknown value in {${sum[1].trim()}}: ${unknown.join(', ')}`);
        return part.replace(/[{}]/g, '');
      }
      if (!hole) return part.replace(/[{}<>]/g, '');
      const [, name, col] = hole;
      if (col && sketch.data.has(name)) {
        const column = `${ident(name)}_${col}`;
        return `{${column}.has(${ident(name)}_i) ? ${column}[${ident(name)}_i] : ""}`;
      }
      if (stateNames.has(ident(name))) return `{${ident(name)}}`;
      warnings.push(`unknown value {${part.slice(1, -1)}}: shown as written`);
      return part.replace(/[{}]/g, '');
    }).join('');
  };

  // "likes +1, next horses, Matches" → statements inside a click handler.
  const actions = (list: string): string => splitTop(list, ',').map(action => {
    let m: RegExpMatchArray | null;
    const target = screenNames.get(action.toLowerCase());
    if (target) return `back = screen; screen = ${str(target)};`;
    if (/^back$/i.test(action)) return 'screen = back;';
    if ((m = action.match(/^(\w+)\s*([+-])\s*(\d+)$/))) return `${ident(m[1])} ${m[2]}= ${m[3]};`;
    if ((m = action.match(/^(\w+)\s*=\s*(.+)$/))) return `${ident(m[1])} = ${/^-?\d+(\.\d+)?$/.test(m[2].trim()) ? m[2].trim() : str(m[2].trim().replace(/^"|"$/g, ''))};`;
    if ((m = action.match(/^toggle\s+(\w+)$/i))) return `${ident(m[1])} = 1 - ${ident(m[1])};`;
    if ((m = action.match(/^(next|prev)\s+(\w+)$/i)) && sketch.data.has(m[2])) {
      const i = `${ident(m[2])}_i`, n = sketch.data.get(m[2])!.length;
      return m[1].toLowerCase() === 'next' ? `${i} += 1; if (${i} == ${n}) { ${i} = 0; }` : `if (${i} == 0) { ${i} = ${n}; } ${i} -= 1;`;
    }
    warnings.push(`unknown action "${action}": ignored`);
    return '';
  }).join(' ');

  // [Label]* → Matches   (the * marks the primary button)
  const button = (spec: string): string => {
    const m = spec.match(/^\[(.+?)\](\*)?\s*(?:→|->)?\s*(.*)$/);
    if (!m) return `<span>${text(spec)}</span>`;
    const [, label, primary, act] = m;
    const look = primary ? `px-4 py-2 rounded-lg bg-[#${p.accent}] text-[#${p.accentInk}]` : `px-4 py-2 rounded-lg bg-[#${p.soft}] text-[#${p.ink}]`;
    const handler = act ? ` onClick={fn() { ${actions(act)} }}` : '';
    return `<button className="${look}"${handler}>${text(label)}</button>`;
  };

  const block = (b: Block): string => {
    switch (b.kind) {
      case 'title': return `<p className="text-2xl">${text(b.body)}</p>`;
      case 'subtitle': return `<p className="text-lg">${text(b.body)}</p>`;
      case 'text': return `<p>${text(b.body)}</p>`;
      case 'note': return `<p className="text-sm text-[#${p.muted}]">${text(b.body)}</p>`;
      case 'space': return `<div className="h-4 shrink-0" />`;
      case 'header': {
        const [title, ...rest] = splitTop(b.body, '|');
        return `<div className="w-full flex-row items-center justify-between shrink-0"><p className="text-xl">${text(title)}</p><div className="flex-row gap-2">${rest.map(button).join('')}</div></div>`;
      }
      case 'row': case 'buttons': return `<div className="flex-row flex-wrap gap-3 shrink-0">${splitTop(b.body, '|').map(button).join('')}</div>`;
      case 'button': return `<div className="flex-row shrink-0">${button(b.body)}</div>`;
      case 'card': {
        const [head, ...rest] = b.body.split('·').map(s => s.trim());
        return `<div className="w-full p-4 gap-2 rounded-lg bg-[#${p.card}] shrink-0"><p className="text-lg">${text(head)}</p>${rest.map(r => `<p className="text-sm text-[#${p.muted}]">${text(r)}</p>`).join('')}</div>`;
      }
      case 'image': case 'photo': return `<div className="w-full h-40 rounded-lg bg-[#${p.soft}] items-center justify-center shrink-0"><p className="text-[#${p.muted}]">${text(b.body || 'Image')}</p></div>`;
      case 'stat': {
        const [label, value] = splitTop(b.body, '|');
        return `<div className="p-4 gap-1 rounded-lg bg-[#${p.card}] shrink-0"><p className="text-sm text-[#${p.muted}]">${text(label ?? '')}</p><p className="text-2xl">${text(value ?? '')}</p></div>`;
      }
      case 'input': case 'search': return `<div className="w-full px-4 py-3 rounded-lg bg-[#${p.card}] shrink-0"><p className="text-[#${p.muted}]">${text(b.body)}</p></div>`;
      case 'tabs': {
        const items = splitTop(b.body, '|');
        return `<div className="w-full flex-row gap-2 p-1 rounded-lg bg-[#${p.soft}] shrink-0">${items.map(item => {
          const target = screenNames.get(item.toLowerCase());
          const on = target ? `screen == ${str(target)} ? "grow px-3 py-2 rounded bg-[#${p.card}] text-[#${p.ink}]" : "grow px-3 py-2 rounded bg-[#${p.soft}] text-[#${p.muted}]"` : `"grow px-3 py-2 rounded bg-[#${p.soft}] text-[#${p.muted}]"`;
          return `<button className={${on}}${target ? ` onClick={fn() { back = screen; screen = ${str(target)}; }}` : ''}>${text(item)}</button>`;
        }).join('')}</div>`;
      }
      case 'list': {
        const m = b.body.match(/^(\w+)\s*(?:(?:→|->)\s*(.+))?$/);
        if (m && sketch.data.has(m[1])) {
          const name = ident(m[1]);
          return `<div className="w-full gap-2 shrink-0">{${name}_1.map(fn(item: string) { return (<button className="w-full px-4 py-3 rounded-lg bg-[#${p.card}] text-[#${p.ink}]"${m[2] ? ` onClick={fn() { ${actions(m[2])} }}` : ''}>{item}</button>); })}</div>`;
        }
        const items = splitTop(b.body, ',');
        return `<div className="w-full gap-2 shrink-0">${items.map(item => `<div className="w-full px-4 py-3 rounded-lg bg-[#${p.card}]"><p>${text(item)}</p></div>`).join('')}</div>`;
      }
      default:
        warnings.push(`line ${b.line}: unknown block "${b.kind}", shown as text`);
        return `<p>${text(b.body)}</p>`;
    }
  };

  const first = screens[0];
  const lines: string[] = [];
  lines.push('// Generated from sketch.md by the zega app builder. Edit the sketch, not this file.');
  lines.push('export fn App() {');
  lines.push(`    let screen = ${str(first)};`);
  lines.push(`    let back = ${str(first)};`);
  for (const [k, v] of sketch.state) lines.push(`    let ${k} = ${/^-?\d+(\.\d+)?$/.test(v) ? v : str(v.replace(/^"|"$/g, ''))};`);
  for (const [name, rows] of sketch.data) {
    const width = Math.max(...rows.map(r => r.length));
    lines.push(`    let ${ident(name)}_i = 0;`);
    for (let c = 0; c < width; c++) lines.push(`    const ${ident(name)}_${c + 1} = [${rows.map(r => str(r[c] ?? '')).join(', ')}];`);
  }
  lines.push('');
  lines.push('    return (');
  lines.push(`        <view className="w-full h-full bg-[#${p.bg}] text-[#${p.ink}] overflow-hidden">`);
  for (const s of sketch.screens) {
    const motion = MOTION[s.transition] ?? MOTION.slide;
    const raws = s.raw.map(r => ({ code: r.trim(), index: rawIndex++ })).filter(r => !skipRaw.has(r.index)).map(r => r.code);
    const children = [...flattenBlocks([...s.blocks, ...s.side]).map(block), ...raws].map(c => `                ${c}`).join('\n');
    lines.push(`            {screen == ${str(s.name)} ? <div className="w-full h-full p-6 gap-4 ${motion}">`);
    lines.push(children);
    lines.push('            </div> : None}');
  }
  lines.push('        </view>');
  lines.push('    );');
  lines.push('}');
  return { name: sketch.name, source: lines.join('\n') + '\n', screens, warnings, rawBlocks: rawIndex };
}

/**
 * A sketch always opens: custom ```dsx blocks that don't compile are left out,
 * one by one, keeping every block that does. `check` returns the compiler's
 * error or null.
 */
export async function compileSketchSafely(markdown: string, check: (source: string) => Promise<string | null>): Promise<SketchResult & { dropped: number; error: string | null }> {
  const first = compileSketch(markdown);
  const error = await check(first.source);
  if (!error || !first.rawBlocks) return { ...first, dropped: 0, error };
  const skip = new Set(Array.from({ length: first.rawBlocks }, (_, i) => i));
  for (let i = 0; i < first.rawBlocks; i++) {
    skip.delete(i);
    if (await check(compileSketch(markdown, skip).source)) skip.add(i);
  }
  const result = compileSketch(markdown, skip);
  return { ...result, dropped: skip.size, error: await check(result.source), warnings: [...result.warnings, ...(skip.size ? [`${skip.size} custom ${skip.size === 1 ? 'part was' : 'parts were'} left out because ${skip.size === 1 ? 'it' : 'they'} didn't work`] : [])] };
}
