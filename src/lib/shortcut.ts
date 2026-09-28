import platformDefaults from './launcher-shortcut.json';
const defaults = platformDefaults.macos;

export function platformDefault(platform: string) {
  return platformDefaults[platform as keyof typeof platformDefaults] ?? defaults;
}

export type Binding = typeof defaults;
export type ShortcutStatus = {
  binding: Binding;
  label: string;
  platform: 'macos' | 'windows' | 'linux';
  registered: boolean;
  portal: boolean;
  error: string | null;
  phase: 'idle' | 'waiting' | 'received' | 'confirmed' | 'expired';
};
export function bindingLabel(binding: Binding, mac: boolean, windows = false) {
  return [binding.control && (mac ? '⌃' : 'Control'), binding.alt && (mac ? '⌥' : 'Alt'), binding.shift && (mac ? '⇧' : 'Shift'), binding.superKey && (mac ? '⌘' : windows ? 'Windows' : 'Super'), binding.key.replace(/^Key/, '')].filter(Boolean).join(mac ? '' : '+');
}
export { defaults };
