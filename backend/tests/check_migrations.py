#!/usr/bin/env python3
"""Verify every pb_migrations file up, down and up again on a disposable database.

This replaces two per-migration scripts that hard-coded one index name and one
file name each, so a new index migration silently went unverified. Walking the
migrations also exercises 1788941000_pagination_indexes.js, whose down() no
earlier check ever ran, and asserts that the initial schema refuses a rollback
instead of dropping a populated database.
"""
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import harness

# Assertions a migration must satisfy while it is applied.
SPECS = {
    '1788941000_pagination_indexes.js': {
        'indexes': ['idx_pages_project_status_order',
                    'idx_attempts_page_round_kind_user',
                    'idx_membership_user_role_project'],
        'plans': [('pages', "SELECT id FROM pages WHERE project=? AND status=? AND page_number>? ORDER BY page_number,id LIMIT 25",
                   ('p', 'pending', 1), 'idx_pages_project_status_order')],
    },
    '1788942000_join_attempt_retention.js': {
        'indexes': ['idx_project_join_attempt_window', 'idx_project_join_source_attempt_window'],
        'plans': [('project_join_attempts',
                   "SELECT id FROM project_join_attempts WHERE window_started != '' AND window_started <= ? AND blocked_until <= ? ORDER BY window_started,id LIMIT 250",
                   ('2026-01-01', '2026-01-01'), 'idx_project_join_attempt_window'),
                  ('project_join_source_attempts',
                   "SELECT id FROM project_join_source_attempts WHERE window_started != '' AND window_started <= ? AND blocked_until <= ? ORDER BY window_started,id LIMIT 250",
                   ('2026-01-01', '2026-01-01'), 'idx_project_join_source_attempt_window')],
    },
    '1789027200_pdf_task_affinity.js': {
        'indexes': ['idx_pages_pdf_affinity'],
        'plans': [('pages',
                   'SELECT id FROM pages WHERE project=? AND project_file=? AND pdf_page=? AND status=? ORDER BY page_number,id',
                   ('p', 'f', 2, 'pending'), 'idx_pages_pdf_affinity')],
        # PocketBase keeps declared index SQL in the collection record; a migration
        # that only touches sqlite_master disappears on the next schema sync.
        'collection_indexes': ('pages', 'idx_pages_pdf_affinity'),
    },
    '1789113600_review_findings.js': {
        'indexes': ['idx_findings_page_current', 'idx_findings_project_kind',
                    'idx_findings_rule_identity', 'idx_gate_rule_identity'],
        'plans': [
            # The read path #176 actually uses: current (not superseded) findings of one page.
            ('review_findings',
             "SELECT id FROM review_findings WHERE page=? AND superseded_at='' ORDER BY produced_at DESC",
             ('p',), 'idx_findings_page_current'),
            # Manager-side statistics grouping.
            ('review_findings',
             'SELECT id FROM review_findings WHERE project=? AND kind=?',
             ('p', 'merged_columns'), 'idx_findings_project_kind'),
            # Gate lookup by rule identity — one row per (producer, version, kind, message_key).
            ('assist_rule_gates',
             'SELECT id FROM assist_rule_gates WHERE producer=? AND producer_version=? AND kind=? AND message_key=?',
             ('rule', 'v1', 'merged_columns', 'bracket_unbalanced'), 'idx_gate_rule_identity'),
        ],
        'collection_indexes': ('review_findings', 'idx_findings_page_current'),
    },
    '1789113700_page_difficulty.js': {
        'indexes': ['idx_pages_project_tier'],
        # #162 的筛选谓词就是「某项目里 tier = ?」，不带排序；带排序时优化器会选
        # 已有的 (project, page_number) 唯一索引，那是正确选择，不是本索引的失败。
        'plans': [('pages',
                   'SELECT id FROM pages WHERE project=? AND difficulty_tier=?',
                   ('p', 'A'), 'idx_pages_project_tier')],
        'collection_indexes': ('pages', 'idx_pages_project_tier'),
    },
    '1789113800_entry_identity.js': {
        'indexes': ['idx_pages_project_identity', 'idx_dismissal_group'],
        'plans': [
            ('pages', 'SELECT id FROM pages WHERE project=? AND entry_identity_key=?',
             ('p', 'k'), 'idx_pages_project_identity'),
            ('finding_dismissals', 'SELECT id FROM finding_dismissals WHERE project=? AND group_key=? AND kind=?',
             ('p', 'k', 'duplicate_identity'), 'idx_dismissal_group'),
        ],
        'collection_indexes': ('pages', 'idx_pages_project_identity'),
    },
}
FIRST = '1788940000_initial_schema.js'


def spec_coverage(migrations_dir=None, specs=None):
    """Reconcile SPECS against the migrations on disk, without booting anything.

    Deriving the migration list from a disk glob alone made this file weaker than
    the two hardcoded scripts it replaced: move a migration out and the run still
    reported PASS, because SPECS is only ever read by `SPECS.get(name)`. Both
    directions must fail — a migration without assertions, and an assertion for a
    migration that no longer exists.
    """
    root = Path(migrations_dir) if migrations_dir else harness.MIGRATIONS
    specs = SPECS if specs is None else specs
    on_disk = sorted(path.name for path in root.glob('*.js'))
    problems = []
    if FIRST not in on_disk:
        problems.append(f'{FIRST} is absent from {root}, so the verifier would pass vacuously')
    for name in on_disk:
        if name != FIRST and name not in specs:
            problems.append(f'{name} is walked but has no assertions in SPECS')
    for name in sorted(specs):
        if name not in on_disk:
            problems.append(f'SPECS covers {name} but that migration no longer exists')
    return on_disk, problems


def migrate(binary, data, *command, expect_success=True):
    env = {**os.environ, 'FANGJI_SKIP_ADMIN_BOOTSTRAP': '1'}
    result = subprocess.run([str(binary), 'migrate', *[str(part) for part in command],
                            f'--dir={data}', f'--migrationsDir={harness.MIGRATIONS}'],
                            env=env, input='y\n', text=True, capture_output=True)
    joined = result.stdout + result.stderr
    if expect_success and result.returncode != 0:
        raise AssertionError(f'migrate {command} failed: {joined[-4000:]}')
    if not expect_success and result.returncode == 0:
        raise AssertionError(f'migrate {command} unexpectedly succeeded: {joined[-4000:]}')
    return joined


def applied(data):
    """Only this repository's JS migrations; PocketBase also records its own Go ones."""
    with sqlite3.connect(data / 'data.db') as db:
        return [row[0] for row in db.execute(
            "SELECT file FROM _migrations WHERE file LIKE '%.js' ORDER BY file")]


def index_names(data):
    with sqlite3.connect(data / 'data.db') as db:
        return {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}


def assert_applied(data, migration, problems):
    spec = SPECS.get(migration, {})
    present = index_names(data)
    for name in spec.get('indexes', []):
        if name not in present:
            problems.append(f'{migration}: index {name} missing after up')
    collection = spec.get('collection_indexes')
    if collection:
        table, name = collection
        with sqlite3.connect(data / 'data.db') as db:
            declared = json.loads(db.execute('SELECT indexes FROM _collections WHERE name=?', (table,)).fetchone()[0])
        if not any(name in sql for sql in declared):
            problems.append(f'{migration}: {table} collection metadata lost index {name}')
    for table, query, parameters, name in spec.get('plans', []):
        with sqlite3.connect(data / 'data.db') as db:
            plan = str(db.execute(f'EXPLAIN QUERY PLAN {query}', parameters).fetchall())
        if name not in plan:
            problems.append(f'{migration}: {table} query plan does not use {name}: {plan}')


def assert_absent(data, migration, problems, context):
    present = index_names(data)
    for name in SPECS.get(migration, {}).get('indexes', []):
        if name in present:
            problems.append(f'{migration}: index {name} survived {context}')


def assert_state(data, expected, through, problems, context):
    """`through` is the newest migration that must still be applied; newer ones gone."""
    for migration in expected:
        if migration <= through:
            assert_applied(data, migration, problems)
        else:
            assert_absent(data, migration, problems, context)


def main():
    expected, problems = spec_coverage()
    if problems:
        for problem in problems:
            print(f'migration coverage drift: {problem}', file=sys.stderr)
        return 1
    with harness.temporary_root() as root:
        binary = harness.build_binary(root / 'pocketbase')
        data = root / 'data'
        rollbackable = [name for name in expected if name != FIRST]

        migrate(binary, data, 'up')
        if applied(data) != expected:
            problems.append(f'applied set {applied(data)} != files {expected}')
        assert_state(data, expected, expected[-1], problems, 'initial up')

        # Round trip each migration: PocketBase reverts the newest applied files
        # first, so stepping down to a target also lifts everything after it.
        for target in reversed(rollbackable):
            newer = [name for name in applied(data) if name >= target]
            previous = expected[expected.index(target) - 1]
            migrate(binary, data, 'down', len(newer))
            assert_state(data, expected, previous, problems, f'down of {target}')
            migrate(binary, data, 'up')
            assert_state(data, expected, expected[-1], problems, f'reapply of {target}')

        # The oldest migration must refuse to revert rather than drop the schema.
        for target in reversed(rollbackable):
            migrate(binary, data, 'down', len([name for name in applied(data) if name >= target]))
        if applied(data) != [FIRST]:
            problems.append(f'walking down left {applied(data)} != [{FIRST}]')
        output = migrate(binary, data, 'down', 1, expect_success=False)
        if 'backup' not in output.lower():
            problems.append(f'initial schema down() did not refuse with a backup message: {output[-1500:]}')
        assert_state(data, expected, FIRST, problems, 'refused down')
        migrate(binary, data, 'up')
        if applied(data) != expected:
            problems.append(f'reapply left {applied(data)} != {expected}')
        assert_state(data, expected, expected[-1], problems, 'final up')

    if problems:
        print('migration verification failed:', file=sys.stderr)
        for problem in sorted(set(problems)):
            print(f'  - {problem}', file=sys.stderr)
        return 1
    print(f'PASS: {len(expected)} migrations verified up, down, up and initial-schema refusal')
    return 0


if __name__ == '__main__':
    sys.exit(main())
