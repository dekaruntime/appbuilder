import { invoke } from '@tauri-apps/api/core';
import type { Tokens } from './timing';

export type ChatGptView = { status: 'signed_out' | 'pending' | 'signed_in'; email: string | null; error: string | null };
export type Model = { slug: string; display_name: string };
export type AskEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'completed'; tokens: Tokens | null; elapsed_ms: number; first_word_ms: number | null }
  | { kind: 'failed'; code: string | null; message: string; usage_limited: boolean };

const USAGE_URL = 'https://chatgpt.com/settings/usage';
export const openUsage = () => { void invoke('plugin:opener|open_url', { url: USAGE_URL }).catch(() => {}); };
