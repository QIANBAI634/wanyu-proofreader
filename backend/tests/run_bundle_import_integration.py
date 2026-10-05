#!/usr/bin/env python3
"""Run the Review Bundle import workflow against a disposable server, with a restart.

#183 的验收里有一条「中断恢复：kill 进程后重启，作业进入确定态（无永久 processing）」。
这条断言只有在真的重启过一次的实例上才有意义，所以本套件跑两遍：

  --prepare-recovery  跑完整条正常流程，最后把一个已完成的导入作业改回 processing
  --verify-recovery   重启之后跑：恢复扫描应重新入队并把它推到确定态，且不产生重复条目

这与 run_rare_characters_integration.py 同一手法，只是它证明的是持久化，本文件证明的是恢复。
"""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

backend = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='fangji-bundle-') as temp:
    root = Path(temp)
    binary = root / 'pocketbase'
    data = root / 'data'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'PB_URL': f'http://127.0.0.1:{port}',
           'APP_ADMIN_EMAIL': 'bundle-admin@example.com', 'APP_ADMIN_PASSWORD': 'BundleTest12345!',
           'PB_ADMIN_EMAIL': 'bundle-super@example.com', 'PB_ADMIN_PASSWORD': 'BundleTest12345!',
           'PB_SUPER_EMAIL': 'bundle-super@example.com', 'PB_SUPER_PASSWORD': 'BundleTest12345!',
           'FANGJI_SKIP_ADMIN_BOOTSTRAP': '0', 'HINGHWA_IDENTITY_BASE_URL': ''}
    subprocess.run(['go', 'build', '-o', str(binary), '.'], cwd=backend, check=True)
    for migration in sorted((backend / 'pb_migrations').glob('*.js'), key=lambda p: int(p.name.split('_')[0])):
        with tempfile.TemporaryDirectory(dir=root) as one:
            shutil.copy(migration, one)
            subprocess.run([str(binary), 'migrate', 'up', f'--dir={data}', f'--migrationsDir={one}'],
                           env={**env, 'FANGJI_SKIP_ADMIN_BOOTSTRAP': '1'}, check=True, stdout=subprocess.DEVNULL)

    handoff = str(root / 'recovery-handoff.json')
    env = {**env, 'BUNDLE_RECOVERY_JOB_FILE': handoff}
    for phase in ('--prepare-recovery', '--verify-recovery'):
        with (root / 'server.log').open('a') as log:
            server = subprocess.Popen([str(binary), 'serve', f'--http=127.0.0.1:{port}', f'--dir={data}',
                                       f'--hooksDir={backend / "pb_hooks"}', f'--migrationsDir={backend / "pb_migrations"}',
                                       '--hooksWatch=false'], env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        with urllib.request.urlopen(env['PB_URL'] + '/api/health', timeout=1):
                            break
                    except OSError:
                        if server.poll() is not None:
                            raise RuntimeError((root / 'server.log').read_text(encoding='utf-8', errors='replace'))
                        time.sleep(.1)
                else:
                    raise RuntimeError('Temporary server did not become ready')
                subprocess.run(['node', str(backend / 'tests/bundle_import_integration.mjs'), phase],
                               env=env, check=True)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
print('PASS: bundle import, partial failure and restart recovery')
