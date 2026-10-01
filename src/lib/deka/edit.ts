// rixse edits on one DekaScript source file: replace ops, applied exactly or
// counted as missed, never guessed.
export type SourceOp = { op: 'replace'; find: string; with: string; all?: boolean } | { op: 'full' };

/** Every complete top-level JSON object in a (possibly still streaming) answer. */
export function jsonObjects(text: string): { objects: string[]; rest: string } {
  const objects: string[] = [];
  let depth = 0, start = -1, inString = false, escaped = false, consumed = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) { objects.push(text.slice(start, i + 1)); consumed = i + 1; }
  }
  return { objects, rest: text.slice(consumed) };
}

export function parseSourceOp(text: string): SourceOp | null {
  try {
    const op = JSON.parse(text);
    if (op?.op === 'full') return { op: 'full' };
    if (op?.op === 'replace' && typeof op.find === 'string' && typeof op.with === 'string') return op;
  } catch { /* not an op */ }
  return null;
}

/** The source with one op applied, or null when its find text is missing or ambiguous. */
export function applySourceOp(source: string, op: Extract<SourceOp, { op: 'replace' }>): string | null {
  const count = op.find ? source.split(op.find).length - 1 : 0;
  if (count === 0 || (count > 1 && !op.all)) return null;
  return op.all ? source.split(op.find).join(op.with) : source.replace(op.find, () => op.with);
}
