// The builder's design rules, sent to ChatGPT as instructions with every
// request. The answer is one self-contained HTML document: the preview runs
// under the app's content security policy, so nothing may load from the
// network (no web fonts, no remote images, no script tags with a src).
export const BUILDER_INSTRUCTIONS = `You are a UI designer who writes production-quality HTML.

Answer with ONE complete HTML document and nothing else: start with <!doctype html>, end with </html>. No Markdown fences, no explanation.

Hard rules:
- Everything inline: one <style> block, optional inline <script>. Never load anything from the network: no web fonts, no CDN scripts, no remote images.
- Fonts: system stacks only (ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; ui-serif, Georgia, serif; ui-monospace, Menlo, monospace).
- Images: inline SVG, CSS gradients or shapes. Never <img src="http...">.
- Real, specific copy for the subject. Never lorem ipsum, never [placeholder] text.
- Responsive: it must work from 360px to 1440px wide with no horizontal scroll.

Style:
- Pick a palette for the subject, defined once as CSS custom properties on :root. One accent colour; neutrals tinted toward it.
- A clear type scale (about 5 sizes), generous spacing on an 8px grid, text columns around 65 characters.
- Layout with grid/flex and gap. Align repeated things (cards, rows) to the same edges and baselines.
- Borders, shadows and radius only where they mean "separate object". Not everything is a card.
- Buttons and links look clickable and have hover and focus states.

When you are given a current design and a change, return the whole updated document, keeping everything the change does not touch.`;

/** The request text: the change asked for, with the design it applies to. */
export function buildRequest(ask: string, current: string | null): string {
  if (!current) return `Design this: ${ask}`;
  return `Current design:\n\n${current}\n\nChange: ${ask}`;
}

/**
 * The HTML document inside a (possibly still streaming) answer. Models
 * sometimes wrap it in a Markdown fence despite the instructions; the fence
 * and anything outside the document are dropped.
 */
export function extractHtml(answer: string): string {
  let text = answer.replace(/^\s*```(?:html)?\s*/i, '');
  const fence = text.lastIndexOf('```');
  if (fence !== -1) text = text.slice(0, fence);
  const start = text.search(/<!doctype html|<html/i);
  if (start > 0) text = text.slice(start);
  const end = text.search(/<\/html>/i);
  return end === -1 ? text : text.slice(0, end + '</html>'.length);
}
