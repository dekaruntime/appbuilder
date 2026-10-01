import { nativeExamples } from './example';

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

The compiler reports errors like Rust's, with the line and a hint. If you are given a compile error, fix exactly what it says.

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

DekaScript reminders: state is \`let\` inside App, handlers assign to it, conditionals use \`cond ? <x/> : None\`, styles are className classes like the existing ones.`;

export function appRequest(ask: string): string {
  return `App to build: ${ask}`;
}

export function editRequest(ask: string, source: string): string {
  return `Current source (app.dsx):\n\n${source}\n\nChange: ${ask}`;
}

export function fixRequest(error: string, source: string): string {
  return `Current source (app.dsx):\n\n${source}\n\nThe compiler rejected it:\n\n${error}\n\nChange: fix this compile error.`;
}

/** The source inside an answer: drops a Markdown fence if the model added one. */
export function extractSource(answer: string): string {
  return answer.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim() + '\n';
}
