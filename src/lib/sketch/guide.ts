// What the model is told about sketches: the whole format fits in one page,
// which is why a sketch round takes seconds.
const FORMAT = `A sketch is ONE Markdown file. The app runs it as a real, clickable app.

# App name
theme: warm | dark | ocean | forest | mono
state: likes = 0, mood = "hopeful"          (numbers, or "text"; toggles use 0 and 1)
data horses: Clover, 8, Connemara | Maple, 5, Fjord   (rows split by |, columns by ,)

## Screen name                              (the first screen opens first)
transition: slide | fade | scale | none
- header: Title | [Button] → action
- title: Big text
- text: Plain text, can show {likes}, {horses.1} (column 1 of the current horse), or maths: {bill * tip / 100}, {round((bill + bill * tip / 100) / people, 2)}  (round, min, max, abs, floor, ceil)
- note: Small grey text
- image: Caption
- card: **Heading** · line two · line three
- row: [Pass] → next horses | [Like]* → likes +1, next horses      (* = primary button)
- button: [Start]* → Swipe
- stat: Label | {likes}
- list: horses → Profile          (one row per item; tapping one makes it the current item, then goes to Profile)   or   list: Milk, Eggs, Bread
- tabs: Swipe | Matches           (switches between screens)
- input: Bill amount → bill       (a real field: typing updates the state value bill, and everything showing {bill} updates live)
- space
- tile: **Heading** · line two → actions      (a tappable card, e.g. a product in a grid)
- subtitle via a ### line inside a screen

LAYOUT: blocks nest by indentation (two spaces) under a container:
- grid: 3                 (3 equal columns)
- row:                    (side by side, wrapping)
- columns:                (side by side, equal widths)
- stack:                  (top to bottom)
- panel:                  (a card that holds blocks)
  - (children indented here)
Any block can end with constraints: @width 1/3 or @width 320, @height 200, @align left|center|right, @gap tight|loose, @grow, @scroll, @sticky
Screen layout (line under the ## heading): layout: sidebar right 340 | sidebar left 300 | centered 480 | split
  then a "### Side" line starts the sidebar's blocks.

TABLES: plain Markdown tables, with {values} and [Buttons] in cells:
| Item | Qty | Price |
| Classic | {classic} | \${classic * 4} |

REPEAT: add "from <data>" to any block to draw it once per row, with {menu.1} as that row:
- tile from menu: **{menu.1}** · \${menu.2} → pick, Detail

COMPONENTS: declare once, use like a block:
## component MenuItem(name, price)
- tile: **{name}** · \${price} → order +1
…then inside a screen: - MenuItem: Classic, 4

Actions after →, separated by commas: a screen name (go there), back, likes +1, likes -1, total = bill * 2, mood = "happy", toggle open, next horses, prev horses.

Use only the blocks above: a sketch has no code. If something can't be expressed, describe it in a note: line; it gets built when the app is made real.`;

export const SKETCH_INSTRUCTIONS = `You sketch desktop apps in a tiny Markdown format. Write the sketch fast: the whole app in a few screens, with real, specific content (never lorem ipsum), real behaviour wired with actions, and a fitting theme.

Answer with the whole sketch file and nothing else: no Markdown fence around it, no explanation.

${FORMAT}`;

export const SKETCH_EDIT_INSTRUCTIONS = `You edit an app sketch (one Markdown file) in place. You are given the whole sketch and a change request.

Answer ONLY with replace operations, one JSON object per line (JSON Lines). No prose, no Markdown fences.
{"op":"replace","find":"exact existing text","with":"the text that takes its place"}
"find" must be copied exactly from the sketch and appear once; to ADD a line, include the line before it in "find" and repeat it in "with" followed by the new line.
If the change rebuilds most of the sketch, answer with the single line {"op":"full"} instead.

${FORMAT}`;

export function sketchRequest(ask: string): string {
  return `App to sketch: ${ask}`;
}

export function sketchEditRequest(ask: string, sketch: string): string {
  return `Current sketch (sketch.md):\n\n${sketch}\n\nChange: ${ask}`;
}

/** "Make it real": the sketch is the spec, the generated app is a working start. */
export function realRequest(sketch: string, generated: string): string {
  return `Build this app properly from its sketch. The sketch is the spec: keep every screen, every piece of content and every behaviour.
Make it look and feel like a finished, polished app (layout, hierarchy, spacing, colour, motion), not a sketch.

The sketch (sketch.md):

${sketch}

A version generated mechanically from the sketch. It compiles and runs, so you can reuse its state and wiring:

${generated}`;
}

export function extractSketch(answer: string): string {
  return answer.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim() + '\n';
}
