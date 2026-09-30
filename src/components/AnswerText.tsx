'use client';
import type { ReactNode } from 'react';

// A small, safe Markdown subset for streamed answers: paragraphs, bullet and
// numbered lists, **bold**, *italic* and `code`. Built as React elements,
// never as HTML, so nothing in an answer can inject markup. Links show their
// text only. rixse genUI replaces prose answers later; this keeps them
// readable until then.
function inline(text: string, key: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    const k = `${key}-${n++}`;
    if (token.startsWith('**')) parts.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) parts.push(<code key={k}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('[')) parts.push(token.slice(1, token.indexOf('](')));
    else parts.push(<em key={k}>{token.slice(1, -1)}</em>);
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function AnswerText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{inline(item, `li${blocks.length}-${i}`)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push(<p key={blocks.length}>{inline(paragraph.join(' '), `p${blocks.length}`)}</p>);
    paragraph = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      endParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (heading) {
      endParagraph(); flush();
      blocks.push(<p key={blocks.length}><strong>{inline(heading[1], `h${blocks.length}`)}</strong></p>);
    } else if (!line.trim()) {
      endParagraph(); flush();
    } else {
      flush();
      paragraph.push(line.trim());
    }
  }
  endParagraph(); flush();
  return <>{blocks}</>;
}
