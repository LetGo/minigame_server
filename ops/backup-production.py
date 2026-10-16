#!/usr/bin/python3
"""Root-only daily PostgreSQL backup; local retention is not offsite protection."""
from datetime import datetime, timezone
from pathlib import Path
import os
import subprocess
import time

os.umask(0o077)
folder = Path('/var/backups/minigame-server')
folder.mkdir(parents=True, exist_ok=True, mode=0o700)
name = datetime.now(timezone.utc).strftime('minigame-%Y%m%dT%H%M%S%fZ.dump')
target = folder / name
tmp = target.with_suffix('.tmp')
try:
    with tmp.open('xb') as output:
        subprocess.run(['/usr/bin/docker', 'exec', 'minigame-prod-postgres-1',
                        'pg_dump', '-U', 'minigame_owner', '-d', 'minigame', '-Fc'],
                       stdout=output, check=True, timeout=120)
    with tmp.open('rb') as source:
        subprocess.run(['/usr/bin/docker', 'exec', '-i', 'minigame-prod-postgres-1',
                        'pg_restore', '--list'], stdin=source,
                       stdout=subprocess.DEVNULL, check=True, timeout=30)
    tmp.rename(target)
except BaseException:
    tmp.unlink(missing_ok=True)
    raise
for old in folder.glob('minigame-*.dump'):
    if old != target and old.stat().st_mtime < time.time() - 14 * 86400:
        old.unlink()
print(f'Backup created and archive index verified: {target.name}')
