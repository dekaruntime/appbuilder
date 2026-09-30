'use client';
import { useEffect, useState } from 'react';

// The bottom-right readout: how long the last thing took, measured end to
// end from the webview (the IPC round trip included), and for ChatGPT
// answers the tokens it used from the user's plan.
export type Tokens = { input: number; cached_input: number; output: number; reasoning: number };
export type Timing = { label: string; ms: number; tokens?: Tokens | null };

let last: Timing | null = null;
const listeners = new Set<(timing: Timing) => void>();

export function reportTiming(timing: Timing) {
  last = timing;
  listeners.forEach(listener => listener(timing));
}

export function useLastTiming() {
  const [timing, setTiming] = useState<Timing | null>(last);
  useEffect(() => {
    listeners.add(setTiming);
    return () => { listeners.delete(setTiming); };
  }, []);
  return timing;
}

export const formatMs = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
// Everyday screens show output tokens only: they are what an answer costs
// most and what rixse edits save. The full breakdown lives in Settings.
export const formatTokens = (tokens: Tokens) => `${tokens.output.toLocaleString()} output tokens`;
export const formatTokenBreakdown = (tokens: Tokens) =>
  `${tokens.output.toLocaleString()} output · ${tokens.input.toLocaleString()} input${tokens.cached_input ? ` (${tokens.cached_input.toLocaleString()} cached)` : ''}${tokens.reasoning ? ` · ${tokens.reasoning.toLocaleString()} of the output was reasoning` : ''}`;
