#!/usr/bin/env python3
"""Shared harness for backend integration suites.

Every suite runs against a throwaway data directory so the suites stay
order-independent, but the Go build is reused across suites by run_all.py.
"""
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
MIGRATIONS = BACKEND / 'pb_migrations'
HOOKS = BACKEND / 'pb_hooks'

ADMIN_EMAIL = 'unicode-admin@example.com'
ADMIN_PASSWORD = 'UnicodeTest12345!'
SUPER_EMAIL = 'unicode-super@example.com'
SUPER_PASSWORD = 'UnicodeTest12345!'


def integration_env(base_url, extra=None):
    env = {**os.environ,
           'PB_URL': base_url,
           'APP_ADMIN_EMAIL': ADMIN_EMAIL,
           'APP_ADMIN_PASSWORD': ADMIN_PASSWORD,
           'PB_ADMIN_EMAIL': SUPER_EMAIL,
           'PB_ADMIN_PASSWORD': SUPER_PASSWORD,
           'PB_SUPER_EMAIL': SUPER_EMAIL,
           'PB_SUPER_PASSWORD': SUPER_PASSWORD,
           'FANGJI_SKIP_ADMIN_BOOTSTRAP': '0',
           'HINGHWA_IDENTITY_BASE_URL': '',
           # A standalone -race binary only prints WARNING: DATA RACE and exits 0;
           # this makes a race abort the server so the suite cannot pass over it.
           # Ignored entirely by binaries built without the race detector.
           'GORACE': 'halt_on_error=1'}
    if extra:
        env.update(extra)
    return env


# fetch 规范禁止发往的端口（WHATWG Fetch 的 "bad port" 列表，undici 照此实现）。
#
# 这份表**不是我们的发明**，是从规范抄下来的；写在仓库里是因为没有零依赖的运行时来源。
# 后果要记住：`free_port()` 抽到表内端口时，Go 起的 PocketBase 会正常监听、`/api/health`
# 也探得通，而套件里第一个 `fetch` 直接抛 `TypeError: fetch failed`（cause 是 `bad port`）——
# 报错里一个字都不提端口，读起来像套件或被测代码坏了。本表过期（规范加了新端口而我们没跟）
# 时的现象就是那个症状重新出现。
#
# 只在**动态端口范围覆盖到这些端口**的机器上有影响。CI 的 ubuntu-latest 临时端口从
# 32768 起，不覆盖表内端口，所以这不是一条会拦合并的红线；受害的是把范围配到低位段的
# 本机贡献者（Windows 默认动态范围就是 1024 起，见 #277）。
BANNED_PORTS = frozenset({
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
    101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
    179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
    587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
    5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
})

# 重抽上界。表只覆盖动态范围的一小部分，正常情况下第一次或第二次就能中；
# 给上界是为了让「表被写错」或「范围几乎全在表内」时以一个带「端口」二字的错误失败，
# 而不是让整个测试入口在这里死循环。
_FREE_PORT_ATTEMPTS = 64


def free_port():
    """让操作系统分配一个**够安全**的端口，禁用端口一律跳过。

    `bind(('127.0.0.1', 0))` 只保证端口当下空闲，不保证 Node 的 `fetch` 愿意往那儿发请求——
    禁用表（见 `BANNED_PORTS`）是另一回事，操作系统不知道它。所以这里抽到表内端口就重抽。
    """
    for _ in range(_FREE_PORT_ATTEMPTS):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        if port not in BANNED_PORTS:
            return port
    raise RuntimeError(
        f'连续 {_FREE_PORT_ATTEMPTS} 次都没抽到一个可用的测试端口：'
        f'本机动态端口范围可能几乎全被 fetch 的禁用端口表占满，'
        f'或 harness.py 的 BANNED_PORTS 表被写坏了。'
        f'（最后抽到的是 {port}）')



# 一次性测试实例里的合成适配器。这里要解决的问题不是「夹具能不能跑作业」，而是
# 「由谁决定它能不能」：声明（rule_status）加契约（schema_version）两道判据缺一不可，
# 见 backend/scheme_conversion.go 的 jobAdapter。仓库里的 adapter_synthetic.json 写的是
# test，那是它的实情，不能为了跑测试把它改掉——改掉就等于把闸门本身拆了。
#
# 另一道判据是构建标签：v1 规则在**生产构建**里无论如何都不能创建真实作业。scheme
# 的两个 runner 以 `-tags schemetest` 编译一次性二进制，只有那个二进制放行 v1。
# 换句话说，下面这份「可运行副本」能被跑，是因为这是测试构建，不是因为它把
# rule_status 改成了 production。
#
# 所以脚手架另写一份**可运行副本**，与夹具并排放在同一个临时规则目录里：
#   * 另一个 source_scheme_id —— 两份文件撞同一个注册表键是启动期错误；
#   * rule_status=production —— 这份副本**只**活在一次性的临时目录里，服务端与数据库都是
#     临时的、没有真实数据，作业跑完随目录一起消失；
#   * rule_status_basis 把上面这件事写成规则文件里的一行字，谁打开临时目录都读得到。
# 夹具本体照原样复制过去，好让套件能实测「仓库里那份声明确实是 test、而且确实建不出作业」。
# 两份都在，闸门的两侧才都有证据。
RUNNABLE_SCHEME = 'synthetic-runnable'


def write_scheme_adapters(adapters_dir, source=None):
    """Materialise a disposable adapter directory: the repo fixture plus a runnable copy."""
    adapters_dir = Path(adapters_dir)
    adapters_dir.mkdir(parents=True, exist_ok=True)
    fixture = (source or BACKEND / 'scheme' / 'testdata' / 'adapter_synthetic.json').read_text(encoding='utf-8')
    (adapters_dir / 'adapter_synthetic.json').write_text(fixture, encoding='utf-8')

    runnable = json.loads(fixture)
    runnable['source_scheme_id'] = RUNNABLE_SCHEME
    runnable['rule_status'] = 'production'
    runnable['rule_status_comment'] = (
        '本副本的 rule_status 是 production，因为这份文件只存在于一次性的临时规则目录里；'
        '规则内容仍然是合成的，见 comment 与每条 basis。'
    )
    runnable['rule_status_basis'] = (
        '仅测试：由 backend/tests/harness.py 的 write_scheme_adapters 从 adapter_synthetic.json 复制而来，'
        '只供一次性实例使用（临时目录、临时数据库、没有真实数据）。'
        '仓库里那份夹具声明 rule_status=test，它才是这两份文件里代表真实情况的那一份。'
    )
    (adapters_dir / 'adapter_runnable.json').write_text(
        json.dumps(runnable, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


RULES_UPGRADED_VERSION = 'synthetic-v2'


def upgrade_runnable_rule_version(adapters_dir):
    """Bump the runnable copy's rule_version in place, to stage a mid-job rule upgrade.

    Called between two server starts: the registry is read once at startup, so a rule
    upgrade that is supposed to be seen by the resumed job has to land before the server
    that resumes it comes up.
    """
    path = Path(adapters_dir) / 'adapter_runnable.json'
    adapter = json.loads(path.read_text(encoding='utf-8'))
    adapter['rule_version'] = RULES_UPGRADED_VERSION
    path.write_text(json.dumps(adapter, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def build_binary(dest, race=False):
    command = ['go', 'build']
    if race:
        command.append('-race')
    subprocess.run([*command, '-o', str(dest), '.'], cwd=BACKEND, check=True)
    return dest


def apply_migrations_individually(binary, data, migrations=MIGRATIONS):
    """Apply one migration per invocation to prove ordering is self-sufficient."""
    for migration in sorted(migrations.glob('*.js'), key=lambda path: int(path.name.split('_')[0])):
        with tempfile.TemporaryDirectory() as single:
            shutil.copy(migration, single)
            subprocess.run([str(binary), 'migrate', 'up', f'--dir={data}',
                            f'--migrationsDir={single}'],
                           env={**os.environ, 'FANGJI_SKIP_ADMIN_BOOTSTRAP': '1'},
                           check=True, stdout=subprocess.DEVNULL)


@contextmanager
def server(binary, root, extra_env=None, data=None, migrations=MIGRATIONS, hooks=HOOKS):
    """Serve a freshly migrated instance and yield its base URL."""
    root = Path(root)
    data = Path(data) if data else root / 'data'
    binary = build_binary(root / 'pocketbase') if binary is None else binary
    apply_migrations_individually(binary, data, migrations)
    port = free_port()
    env = integration_env(f'http://127.0.0.1:{port}', extra_env)
    with (root / 'server.log').open('a') as log:
        process = subprocess.Popen([str(binary), 'serve', f'--http=127.0.0.1:{port}', f'--dir={data}',
                                    f'--hooksDir={hooks}', f'--migrationsDir={migrations}',
                                    '--hooksWatch=false'], env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(env['PB_URL'] + '/api/health', timeout=1):
                        break
                except OSError:
                    if process.poll() is not None:
                        raise RuntimeError(_log_tail(root))
                    time.sleep(.1)
            else:
                raise RuntimeError('Temporary server did not become ready\n' + _log_tail(root))
            yield env
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        log_text = _log_tail(root, size=10 ** 6)
        if 'DATA RACE' in log_text:
            raise RuntimeError('race detector reported a data race:\n' + _race_excerpt(log_text))
        if process.returncode not in (0, -15, 143):
            raise RuntimeError(f'server exited {process.returncode}\n{_log_tail(root)}')


def run_suite(name, env, cwd=None):
    """Run one node suite (or a python callable) with the server environment."""
    if callable(name):
        return name(env)
    return subprocess.run(['node', str(BACKEND / 'tests' / name)], env=env, check=True, cwd=cwd)


def _race_excerpt(text):
    start = text.find('WARNING: DATA RACE')
    return text[start if start >= 0 else 0:][:4000]


def _log_tail(root, size=20000):
    # Only disposable, generated test identities are present in this log.
    try:
        return (Path(root) / 'server.log').read_text()[-size:]
    except OSError:
        return '<no server.log>'


@contextmanager
def temporary_root(keep=False):
    if keep:
        root = Path(tempfile.mkdtemp(prefix='fangji-integration-'))
        try:
            yield root
        finally:
            print(f'kept temporary root: {root}', flush=True)
    else:
        with tempfile.TemporaryDirectory(prefix='fangji-integration-') as temp:
            yield Path(temp)


def discover_registry():
    """Return the registered suite entries in run order; suites.json is the source of truth."""
    entries = json.loads((BACKEND / 'tests' / 'suites.json').read_text())
    registered = [entry['suite'] for entry in entries]
    missing = [suite for suite in registered if not (BACKEND / 'tests' / suite).exists()]
    if missing:
        raise SystemExit(f'suites.json references missing files: {", ".join(missing)}')
    return entries
