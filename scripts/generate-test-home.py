#!/usr/bin/env python3
"""Deterministic local fixture. Only writes under this clone's .tmp directory."""
import argparse
import json
import struct
import zlib
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--root', type=Path, default=BASE / '.tmp/test-home')
a = p.parse_args()
root = a.root.resolve()
if not root.is_relative_to(BASE / '.tmp'):
    p.error('fixture root must be inside the clone .tmp directory')
if root.exists():
    p.error('choose a new, empty fixture root')
root.mkdir(parents=True)
for folder in ['Documents', 'Pictures', 'Movies', 'Downloads', 'Desktop', 'Applications']:
    (root / folder).mkdir()
for i in range(2000):
    folder = root / 'Documents' / f'batch-{i // 200:02}'
    folder.mkdir(exist_ok=True)
    (folder / f'notes-{i:04}.txt').write_text(f'Local fixture document {i}\n')
(root / 'Applications/Fixture.desktop').write_text('[Desktop Entry]\nType=Application\nName=Fixture\nExec=fixture\n')
# TIFF/EXIF offsets are written by us, no EXIF-writing library or network.
def exif():
    data = bytearray(b'II*\x00\x08\x00\x00\x00')
    def directory(entries):
        start = len(data)
        data.extend(struct.pack('<H', len(entries)) + bytes(12 * len(entries)) + bytes(4))
        for i, (tag, typ, count, payload) in enumerate(entries):
            if len(payload) <= 4:
                value = payload.ljust(4, b'\x00')
            else:
                value = struct.pack('<I', len(data))
                data.extend(payload)
            struct.pack_into('<HHI4s', data, start + 2 + 12 * i, tag, typ, count, value)
        return start
    first = directory([(0x010F, 2, 8, b'Fixture\0'), (0x0110, 2, 7, b'Camera\0'),
                       (0x8769, 4, 1, bytes(4)), (0x8825, 4, 1, bytes(4))])
    details = directory([(0x9003, 2, 20, b'2026:07:15 12:30:00\0'),
                         (0xA002, 4, 1, struct.pack('<I', 32)), (0xA003, 4, 1, struct.pack('<I', 24))])
    rational = lambda values: b''.join(struct.pack('<II', n, d) for n, d in values)
    gps = directory([(1, 2, 2, b'N\0'), (2, 5, 3, rational([(38, 1), (43, 1), (20, 1)])),
                     (3, 2, 2, b'W\0'), (4, 5, 3, rational([(9, 1), (8, 1), (20, 1)]))])
    struct.pack_into('<I', data, first + 2 + 2 * 12 + 8, details)
    struct.pack_into('<I', data, first + 2 + 3 * 12 + 8, gps)
    return bytes(data)
def chunk(tag, body):
    return struct.pack('>I', len(body)) + tag + body + struct.pack('>I', zlib.crc32(tag + body))
for i in range(50):
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', 32, 24, 8, 2, 0, 0, 0))
    png += chunk(b'eXIf', exif())
    png += chunk(b'IDAT', zlib.compress((b'\0' + bytes([i * 5, 80, 140]) * 32) * 24))
    png += chunk(b'IEND', b'')
    (root / 'Pictures' / f'IMG_{i:04}.png').write_bytes(png)
def atom(tag, body): return struct.pack('>I', 8 + len(body)) + tag + body
# Small, synthetic ISO BMFF containers: real mvhd/tkhd creation, duration,
# dimensions and QuickTime GPS atoms, no encoded audio/video samples.
for i in range(5):
    import datetime
    created = int(datetime.datetime(2026, 7, 15, tzinfo=datetime.timezone.utc).timestamp()) + 2082844800
    mvhd = bytes(4) + struct.pack('>IIII', created, created, 1000, 12000 + i * 1000) + bytes(80)
    tkhd = bytearray(84)
    struct.pack_into('>II', tkhd, 76, 1920 << 16, 1080 << 16)
    gps = b'+38.7222-009.1389/'
    moov = atom(b'mvhd', mvhd) + atom(b'trak', atom(b'tkhd', tkhd)) + atom(b'udta', atom(b'\xa9xyz', struct.pack('>HH', len(gps), 0) + gps))
    (root / 'Movies' / f'clip-{i}.mp4').write_bytes(atom(b'ftyp', b'isom\0\0\0\0isommp42') + atom(b'moov', moov) + atom(b'mdat', b''))
for folder in ['.hidden', '.git', 'node_modules', 'Library', 'caches']:
    (root / folder).mkdir()
    (root / folder / 'must-not-index.txt').write_text('Excluded fixture data\n')
print(json.dumps({'root': str(root), 'File': 2000, 'Photo': 50, 'Video': 5, 'App': 1,
                  'Folder': 17, 'Place': 1, 'Camera': 1, 'Day': 1, 'Period': 1, 'Volume': 1}))
