import defaults from './launcher-shortcut.json';

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
export function bindingLabel(binding: Binding, mac: boolean) {
  return [binding.control && (mac ? '⌃' : 'Control'), binding.alt && (mac ? '⌥' : 'Alt'), binding.shift && (mac ? '⇧' : 'Shift'), binding.superKey && (mac ? '⌘' : 'Super'), binding.key.replace(/^Key/, '')].filter(Boolean).join(mac ? '' : '+');
}
export { defaults };
