// Errors in words anyone can read. The app is for everyone, so the screen
// says what happened and what to do; the compiler's own text stays one click
// away under "Show details".

/** How many separate problems a compiler message lists (one per line). */
export function problemCount(error: string): number {
  return Math.max(1, error.split('\n').filter(line => line.trim()).length);
}

export function problemsLabel(error: string): string {
  const n = problemCount(error);
  return n === 1 ? '1 problem' : `${n} problems`;
}

/** What went wrong while the app was running, said plainly. */
export function runtimeLabel(error: string): string {
  if (/instruction limit/i.test(error)) return 'Your app got stuck doing the same thing over and over, so it was stopped.';
  if (/out of memory|heap/i.test(error)) return 'Your app ran out of room and was stopped.';
  return 'Something went wrong while your app was running.';
}
