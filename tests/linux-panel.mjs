// Hardware check: launch zega, open search, then pass its native process ID.
// Example: node tests/linux-panel.mjs 1234 0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const pid = Number(process.argv[2]);
assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Pass the zega process ID');
const args = process.argv[3] ? ['-i', process.argv[3]] : [];
const windows = JSON.parse(execFileSync('hyprctl', [...args, '-j', 'clients'], {encoding: 'utf8'}))
  .filter(window => window.pid === pid && window.mapped && !window.hidden);
const panel = windows.find(window => window.title === 'zega Search');
assert.ok(panel, `Search must be open; found ${windows.map(window => window.title).join(', ')}`);
assert.equal(panel.xwayland, false, 'Exercise the native Wayland path');
assert.equal(panel.floating, true, 'Search must float above the desktop instead of becoming a tiled window');
assert.deepEqual(panel.size, [680, 440], 'The compositor must preserve the search panel size');
const monitors = JSON.parse(execFileSync('hyprctl', [...args, '-j', 'monitors'], {encoding: 'utf8'}));
const monitor = monitors.find(item => item.id === panel.monitor);
assert.ok(monitor, 'Search is on an active monitor');
const [left, top, right, bottom] = monitor.reserved;
const width = monitor.width / monitor.scale;
const height = monitor.height / monitor.scale;
const center = [monitor.x + left + (width - left - right - panel.size[0]) / 2,
  monitor.y + top + (height - top - bottom - panel.size[1]) / 2];
assert.ok(panel.at.every((value, axis) => Math.abs(value - center[axis]) <= 1), `Search must open centered: ${panel.at} versus ${center}`);
assert.ok(!windows.some(window => window.title === 'zega'), 'Opening search must keep the main window hidden');
console.log('PASS: native Wayland search floats centered at 680×440; main window hidden');
