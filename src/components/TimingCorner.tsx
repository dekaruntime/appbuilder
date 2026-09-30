'use client';
import { formatMs, formatTokens, useLastTiming } from '../lib/timing';

export default function TimingCorner() {
  const timing = useLastTiming();
  if (!timing) return null;
  return <output className="timing-corner" aria-live="polite">
    {timing.label} in {formatMs(timing.ms)}{timing.tokens ? ` · ${formatTokens(timing.tokens)}` : ''}
  </output>;
}
