#!/usr/bin/env python3
"""Run every backend integration suite with one shared build.

Suites come from suites.json, the same registry CI builds its matrix from; a suite
that is missing from it fails check_test_inventory.py. Each suite still gets its
own data directory and server process.

Usage:
  python3 backend/tests/run_all.py                 # every suite, sequentially
  python3 backend/tests/run_all.py --jobs 4        # parallel servers
  python3 backend/tests/run_all.py --race          # race-detector build
  python3 backend/tests/run_all.py pdf_ phase1     # name filters
  python3 backend/tests/run_all.py --list
"""
import argparse
import concurrent.futures
import os
import sys
import time

import harness


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('filters', nargs='*', help='only run suites whose name contains this')
    parser.add_argument('--jobs', type=int, default=1, help='suites to run at once (default 1)')
    parser.add_argument('--race', action='store_true', help='build the server with the race detector')
    parser.add_argument('--list', action='store_true', help='print discovered suites and exit')
    return parser.parse_args(argv)


def select(registry, filters):
    """Suites with their own runner need more than one server cycle."""
    chosen = []
    for entry in registry:
        suite = entry['suite']
        if entry.get('ci_runner'):
            print(f'skip {suite}: {entry["ci_runner"]} restarts the server to re-verify persistence')
            continue
        # 这类套件缺环境时会自己打印 SKIP 并退出 0。让它进正常通道就会被汇总成
        # "PASS assist_browser_integration.mjs (795 ms)"——一次什么都没验证的绿。
        required_env = entry.get('requires_env')
        if required_env and not os.environ.get(required_env):
            print(f'skip {suite}: 需要 {required_env}，未设置时它自己会 SKIP 并以 0 退出')
            continue
        if not filters or any(pattern in suite for pattern in filters):
            chosen.append(suite)
    return chosen


def main(argv=None):
    args = parse_args(argv)
    registry = harness.discover_registry()
    if args.list:
        print('\n'.join(entry['suite'] for entry in registry))
        return 0
    suites = select(registry, args.filters)
    if not suites:
        print(f'no suite matches {args.filters}', file=sys.stderr)
        return 2

    with harness.temporary_root() as root:
        binary = harness.build_binary(root / 'pocketbase', race=args.race)
        print(f'{len(suites)} suite(s), shared build at {binary}\n', flush=True)

        def run(suite):
            with harness.temporary_root() as per_suite:
                started = time.monotonic()
                try:
                    with harness.server(binary, per_suite) as env:
                        harness.run_suite(suite, env)
                    return suite, int((time.monotonic() - started) * 1000), ''
                except Exception as failure:  # reported in the summary, re-raised via exit code
                    return suite, int((time.monotonic() - started) * 1000), str(failure)

        failures = {}
        if args.jobs > 1:
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
                results = list(pool.map(run, suites))
        else:
            results = [run(suite) for suite in suites]
        for suite, milliseconds, error in results:
            if error:
                failures[suite] = error
                print(f'FAIL {suite} ({milliseconds} ms)\n{error}\n', flush=True)
            else:
                print(f'PASS {suite} ({milliseconds} ms)', flush=True)

    print(f'\n{len(suites) - len(failures)}/{len(suites)} suites passed')
    if failures:
        print('failed: ' + ', '.join(sorted(failures)), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
