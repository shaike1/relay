#!/bin/bash
# Sync sessions.json to backup relay on .12 with flipped hosts
python3 - << 'PYEOF'
import json, tempfile, os, subprocess

sessions = json.load(open('/root/relay/sessions.json'))
sessions_12 = []
for s in sessions:
    entry = dict(s)
    if s['host'] is None:
        entry['host'] = 'root@your-primary-host'
    elif s['host'] == 'root@your-backup-host':
        entry['host'] = None
    sessions_12.append(entry)

with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
    json.dump(sessions_12, f, indent=2)
    tmp = f.name

result = subprocess.run(
    ['scp', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5',
     tmp, 'root@your-backup-host:/root/relay/sessions.json'],
    capture_output=True
)
os.unlink(tmp)
if result.returncode == 0:
    print('sessions.json synced to .12')
else:
    print(f'sync failed: {result.stderr.decode()}')
PYEOF
