#!/usr/bin/env python3
"""Prove macOS fixture indexing/search opens zero internet sockets or DNS calls.
Run after cargo build -p computer-index --example index_probe. No root needed.
"""
import json
import os
import platform
import re
import subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[1]
if platform.system() != 'Darwin':
    raise SystemExit('macOS interposition proof; run native network tracing in the platform round')
env = dict(os.environ, TMPDIR=str(root / '.tmp'))
lib = root / '.tmp/network-audit.dylib'
subprocess.run(['clang', '-dynamiclib', '-Wall', '-Wextra', '-Werror', str(root / 'tests/fixtures/network-audit.c'), '-o', str(lib)], env=env, check=True)
probe = root / '.target/debug/examples/index_probe'
env['DYLD_INSERT_LIBRARIES'] = str(lib)
control = subprocess.run([str(probe), '--network-control'], env=env, text=True, capture_output=True, check=True)
assert 'NETWORK_AUDIT attempts=1' in control.stderr, control.stderr
fixture = root / f'.tmp/network-home-{os.getpid()}'
subprocess.run(['python3', str(root / 'scripts/generate-test-home.py'), '--root', str(fixture)], env={k:v for k,v in env.items() if k != 'DYLD_INSERT_LIBRARIES'}, check=True, capture_output=True)
queries = ['lisbon photos', 'lisbn', 'videos last summer', 'notes-0123']
requests = ''.join(json.dumps({'command':'index_search','args':{'query':query}})+'\n' for query in queries)
run = subprocess.run(['/usr/bin/time', '-l', '/usr/bin/env', f'DYLD_INSERT_LIBRARIES={lib}', str(probe), str(fixture), str(root / f'.tmp/network-graph-{os.getpid()}')], input=requests, env=env, text=True, capture_output=True, check=True)
reports = re.findall(r'NETWORK_AUDIT attempts=(\d+)', run.stderr)
assert reports and all(int(n) == 0 for n in reports), run.stderr
answers = [json.loads(line) for line in run.stdout.splitlines()]
assert answers[0]['counts']['Photo'] == 50
for answer in answers[1:]: assert answer.get('value'), answer
print(run.stdout, end='')
print(run.stderr, end='')
print('PROOF zero network attempts; positive control detected one blocked attempt')
