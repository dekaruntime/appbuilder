#!/usr/bin/env python3
"""Two controlled source reversions; always restore the implementation.
Run alone, with no other build of this checkout in flight.
"""
import subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[1]
cases = [
    ('rename', 'crawler.rs',
     'let key = format!("{volume}:{file_id}:{fingerprint}");',
     'let key = format!("{volume}:{file_id}:{fingerprint}:{}", path.display());',
     'rename_preserves_engine_identity', 'rename must preserve the identity key'),
    ('offline', 'lib.rs', 'if !present(&r) {', 'if false && !present(&r) {',
     'unmounted_volume_is_offline_not_deleted', 'unmount must mark the node offline'),
]
for label, name, original, reverted, test, expected in cases:
    source = root / 'src-tauri/computer-index/src' / name
    saved = source.read_bytes()
    assert saved.decode().count(original) == 1, f'{label}: source marker changed'
    try:
        source.write_text(saved.decode().replace(original, reverted))
        result = subprocess.run(['cargo', 'test', '--locked', '--manifest-path', str(root / 'src-tauri/Cargo.toml'), '-p', 'computer-index', '--test', 'fixture', test, '--', '--exact', '--nocapture'], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (root / '.tmp' / f'revert-{label}.log').write_text(result.stdout)
        assert result.returncode == 101 and expected in result.stdout, result.stdout
        print(f'PROOF reverted {label}: exit {result.returncode}; {expected}')
    finally:
        source.write_bytes(saved)
# Confirm both restored behaviours together; the full suite is a separate gate.
result = subprocess.run(['cargo', 'test', '--locked', '--manifest-path', str(root / 'src-tauri/Cargo.toml'), '-p', 'computer-index', '--test', 'fixture', '--', '--nocapture'], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
(root / '.tmp/revert-restored.log').write_text(result.stdout)
assert result.returncode == 0, result.stdout
print('PROOF restored implementation: fixture tests exit 0')
