#!/usr/bin/env python3
"""Run the #190 admin screenshot suite against a disposable server.

与 run_scheme_conversion_integration.py 同一套脚手架（临时规则目录 + 一次性服务端，
规则目录同样由 harness.write_scheme_adapters 铺成：夹具原样一份 + 只供本次实例使用的
可运行副本一份），差别只在本文件把 playwright 的脚本与产物目录一起交给套件，
并在收尾校验四张图都在。

需要 playwright 与已构建的 frontend/dist；缺任何一步都显式失败——留这一层不是为了再看
一次图，而是防「套件被静默 SKIP」：没设 SCHEME_BROWSER_SCRIPT 时套件退出 0。
"""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

import harness

backend = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='fangji-scheme-browser-') as temp:
    root = Path(temp)
    binary = root / 'pocketbase'
    data = root / 'data'
    adapters = root / 'adapters'
    harness.write_scheme_adapters(adapters)

    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'PB_URL': f'http://127.0.0.1:{port}',
           'APP_ADMIN_EMAIL': 'scheme-browser@example.com', 'APP_ADMIN_PASSWORD': 'SchemeTest12345!',
           'PB_ADMIN_EMAIL': 'scheme-super@example.com', 'PB_ADMIN_PASSWORD': 'SchemeTest12345!',
           'PB_SUPER_EMAIL': 'scheme-super@example.com', 'PB_SUPER_PASSWORD': 'SchemeTest12345!',
           'FANGJI_SKIP_ADMIN_BOOTSTRAP': '0', 'HINGHWA_IDENTITY_BASE_URL': '',
           'FANGJI_SCHEME_ADAPTER_DIR': str(adapters),
           'SCHEME_BROWSER_SCRIPT': str(backend / 'tests/scheme_conversion_browser.cjs'),
           'SCHEME_BROWSER_FIXTURE': str(root / 'scheme-browser-fixture.json')}
    # 与 run_scheme_conversion_integration.py 同一理由：只有 `schemetest` 构建才允许
    # v1 规则创建作业；生产镜像不带这个标签。
    subprocess.run(['go', 'build', '-tags', 'schemetest', '-o', str(binary), '.'], cwd=backend, check=True)
    for migration in sorted((backend / 'pb_migrations').glob('*.js'), key=lambda p: int(p.name.split('_')[0])):
        with tempfile.TemporaryDirectory(dir=root) as one:
            shutil.copy(migration, one)
            subprocess.run([str(binary), 'migrate', 'up', f'--dir={data}', f'--migrationsDir={one}'],
                           env={**env, 'FANGJI_SKIP_ADMIN_BOOTSTRAP': '1'}, check=True, stdout=subprocess.DEVNULL)

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
            subprocess.run(['node', str(backend / 'tests/scheme_conversion_browser_integration.mjs')],
                           env=env, check=True)
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
print('PASS: scheme conversion admin screenshots')
