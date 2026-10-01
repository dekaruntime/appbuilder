import { nativeExamples } from './example';

// What deka 0.60.1's VM compiles, read from crates/deka_vm/src/compiler.rs
// (Binary: Add Sub Mul Div Lt Eq; no unary operators). Shared by the build
// and edit instructions and the AGENTS.md written into the app's folder.
export const HARD_LIMITS = `HARD LIMITS of this runtime (deka 0.60.1 VM, read from its compiler; anything else fails to compile):
- Binary operators: ONLY + - * / < and ==. There is no >, <=, >=, !=, &&, ||, % and no unary ! or -.
  Write a > b as b < a; a >= b as (a < b) == false; a <= b as (b < a) == false; a != b as (a == b) == false;
  a && b as (a ? b : false); a || b as (a ? true : b); !x as (x == false); -x as (0 - x).
- Assignment only to plain variables (= += -= *=). Arrays and objects are immutable: build a new one instead
  (e.g. keep an index variable instead of removing items, or reassign the whole array).
- Expressions: literals, variables, ( ), cond ? a : b, calls, fn closures, arrays, objects, field and index reads, JSX.
  No template strings: join text with +. No spread, no optional chaining, no destructuring.
- Statements: const, let, fn, return, if/else, for, blocks. No while, no switch, no try.
- Functions: no default parameters, no generics, no tuple parameters. Define a helper before it is used.
`;


// What the model is told about DekaScript native apps. The reference programs
// are the tour's own lessons, each executed against this same VM in deka's CI,
// so every construct the model copies is known to compile and run here.
const reference = nativeExamples
  .map(example => `// ${example.section} · ${example.name}\n${example.source.trim()}`)
  .join('\n\n');

export const DEKA_APP_INSTRUCTIONS = `You build desktop apps in DekaScript for deka's native runtime: a Rust VM runs the program and Rust draws the window.

Answer with ONE complete DekaScript source file and nothing else: no Markdown fences, no explanation.

The file:
- exports the app as \`export fn App() { ... return ( <view ...> ... </view> ); }\`; helper components are plain \`fn Name(arg: type) { return (...) }\` above it
- holds state in \`let\` variables inside App; event handlers assign to them (\`onClick={fn() { count += 1; }}\`) and the view updates
- uses only the elements, attributes, style classes and language features shown in the reference programs below (view, div, p, span, button; className with layout, spacing, size, text, colour, radius and motion classes; arbitrary colours like bg-[#F3EFE3])
- conditional parts use \`cond ? <p>…</p> : None\`
- has real, specific content for the app; never lorem ipsum or [placeholders]

Design it properly: a clear layout with consistent spacing, a deliberate palette (2–3 colours plus neutrals), readable sizes, controls that look clickable. A desktop window is roughly 900×640.

The compiler reports errors with the line and column. If you are given a compile error, fix exactly what it says.

${HARD_LIMITS}

Reference programs (all compile and run on this runtime):

${reference}`;

/** The rixse rules for edits to an existing DekaScript app (one file). */
export const DEKA_EDIT_INSTRUCTIONS = `You edit an existing DekaScript desktop app in place. You are given the WHOLE current source file and a change request (or a compile error to fix).

Answer ONLY with replace operations, one JSON object per line (JSON Lines). No prose, no Markdown fences, no whole file.

{"op":"replace","find":"exact existing text","with":"the text that takes its place"}

How replace works: the app finds "find" in the file and puts "with" in its place, nothing more. To ADD something, include the neighbouring text in "find" and repeat it in "with" together with the addition.
"find" must be copied exactly from the file (whitespace included) and appear exactly once; add "all":true to replace every occurrence.
Make the smallest set of edits that fully carries out the change. Keep everything else exactly as it is.
If the change rebuilds most of the app, answer with the single line {"op":"full"} instead.

DekaScript reminders: state is \`let\` inside App, handlers assign to it, conditionals use \`cond ? <x/> : None\`, styles are className classes like the existing ones.

${HARD_LIMITS}`;

/** AGENTS.md for the app's folder, for Codex or any agent working there. */
export function agentsFile(name: string): string {
  return `# ${name || 'Untitled app'}

A deka desktop app built with zega. The whole app is \`app.dsx\` (DekaScript); \`deka.json\` packages it.
The zega app builder watches this folder: every save to app.dsx shows up in its live preview.

- Keep the app in app.dsx with \`export fn App()\` as its entry.
- Check every change compiles before you say it's done:
  \`"$(command -v deka || echo /Volumes/Projects/claude/deka-runtime-0.60.1/bin/deka)" check deka.json\`
  (deka 0.60.1's native CLI; it reports the same errors the preview shows). Don't translate the app to JavaScript to test it: the VM's rules differ.
- The preview runs deka 0.60.1's VM, which supports a subset of DekaScript. Stay inside these limits:
${HARD_LIMITS}`;
}

export function appRequest(ask: string): string {
  return `App to build: ${ask}`;
}

export function editRequest(ask: string, source: string): string {
  return `Current source (app.dsx):\n\n${source}\n\nChange: ${ask}`;
}

// The error plus the code it points at: a line:column error gets the line and
// a caret; an operator error gets every line that uses that operator.
export function errorContext(error: string, source: string): string {
  const lines = source.split('\n');
  const at = error.match(/^(\d+):(\d+):/);
  if (at) {
    const n = Number(at[1]), col = Number(at[2]);
    const from = Math.max(1, n - 2), to = Math.min(lines.length, n + 2);
    return lines.slice(from - 1, to).map((text, i) => `${String(from + i).padStart(4)} | ${text}${from + i === n ? `\n     | ${' '.repeat(Math.max(0, col - 1))}^` : ''}`).join('\n');
  }
  const ops: Record<string, RegExp> = { Gt: />(?![=>])(?<!=>)/, GtEq: />=/, LtEq: /<=/, NotEq: /!=/, And: /&&/, Or: /\|\|/, Rem: /\s%\s/ };
  const op = error.match(/operator (\w+) unsupported/)?.[1];
  const pattern = op && ops[op];
  if (!pattern) return '';
  return lines.map((text, i) => [i + 1, text] as const).filter(([, text]) => pattern.test(text) && !/^\s*</.test(text.trim())).map(([n, text]) => `${String(n).padStart(4)} | ${text}`).join('\n');
}

export function fixRequest(error: string, source: string): string {
  const context = errorContext(error, source);
  return `Current source (app.dsx):\n\n${source}\n\nThe compiler rejected it:\n\n${error}${context ? `\n\nWhere:\n${context}` : ''}\n\nChange: fix this compile error. Check the HARD LIMITS: rewrite every use of an unsupported construct, not only this one.`;
}

/** The source inside an answer: drops a Markdown fence if the model added one. */
export function extractSource(answer: string): string {
  return answer.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim() + '\n';
}
