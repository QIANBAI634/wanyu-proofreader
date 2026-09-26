#!/usr/bin/env python3
"""批处理规模实测：10k 行项目的两条全量重算端到端耗时。

两条都量：
- `POST /projects/{id}/findings/recompute` = #177 的 R1–R7 规则 + #180 的逐条 tier 刷新；
- `POST /projects/{id}/identity/recompute` = #178 的跨行检出与身份键回填。
先量前者、再量后者，规则那一跑的结果不受跨行 finding 干扰。

不进 CI：一次跑要往临时库里塞 10000 条 pages，CI 的并行矩阵里它会成为最慢的一环，
而它测的是容量而不是正确性（正确性由 identity_integration.mjs 覆盖）。
需要容量数字时手动跑：

    python3 backend/tests/measure_identity_scale.py [行数，默认 10000]

只记录聚合计数与毫秒数，不输出任何单元格内容。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import harness

BATCH = 1000


def api(url, env, method='GET', body=None):
    base = env['PB_URL'] + url
    req = urllib.request.Request(base, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    token = env.get('SCALE_TOKEN')
    if token:
        req.add_header('Authorization', token)
    if body is not None:
        req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read().decode() or '{}')


def seed(env, rows):
    """逐步换用各自该用的身份：建项目要平台管理员，建用户要 superuser。"""
    super_auth = api('/api/collections/_superusers/auth-with-password', env, 'POST',
                     {'identity': env['PB_SUPER_EMAIL'], 'password': env['PB_SUPER_PASSWORD']})
    platform = api('/api/collections/users/auth-with-password', env, 'POST',
                   {'identity': env['APP_ADMIN_EMAIL'], 'password': env['APP_ADMIN_PASSWORD']})
    env['SCALE_TOKEN'] = platform['token']
    project = api('/api/fangji/projects', env, 'POST', {'name': f'scale-{rows}'})
    env['SCALE_TOKEN'] = super_auth['token']
    manager = api('/api/collections/users/records', env, 'POST', {
        'email': f'scale-manager-{rows}@example.com', 'password': 'ScalePass123!',
        'passwordConfirm': 'ScalePass123!', 'name': 'scale', 'role': 'user'})
    env['SCALE_TOKEN'] = platform['token']
    api(f"/api/fangji/projects/{project['id']}/members/{manager['id']}", env, 'PUT', {'role': 'manager'})
    env['SCALE_TOKEN'] = super_auth['token']
    started = time.monotonic()
    for index in range(rows):
        # 1/4 的行共享同一个身份（同词头同拼音），制造真实分组压力而不是 10k 个单条桶。
        group = index % (rows // 4)
        row = {'词条': f'词{group}', '拼音': f'pin{group}', '莆田IPA': f'ipa{group}',
               '释义': f'义{index}'}
        api('/api/collections/pages/records', env, 'POST', {
            'project': project['id'], 'page_number': index + 1,
            'pdf_page': (index // 5) + 1, 'status': 'pending', 'proofread_round': 1,
            'mismatch_count': 0, 'ocr_row_json': json.dumps(row, ensure_ascii=False),
            'ocr_text': ' '.join(row.values())})
        if (index + 1) % BATCH == 0:
            print(f'  seeded {index + 1}/{rows} ({time.monotonic() - started:.1f}s)', file=sys.stderr)
    manager_auth = api('/api/collections/users/auth-with-password', env, 'POST',
                       {'identity': f'scale-manager-{rows}@example.com', 'password': 'ScalePass123!'})
    env['SCALE_TOKEN'] = manager_auth['token']
    return project['id'], time.monotonic() - started


def main(argv=None):
    rows = int(argv[1]) if argv and len(argv) > 1 and argv[1].isdigit() else 10000
    argv = argv or sys.argv
    with harness.temporary_root() as root:
        binary = harness.build_binary(root / 'pocketbase')
        with harness.server(binary, root) as env:
            project_id, seed_seconds = seed(env, rows)
            rules_started = time.monotonic()
            rules = api(f'/api/fangji/projects/{project_id}/findings/recompute',
                        env, 'POST', {})
            rules_wall = time.monotonic() - rules_started
            started = time.monotonic()
            summary = api(f'/api/fangji/projects/{project_id}/identity/recompute',
                          env, 'POST', {})
            wall = time.monotonic() - started
            again = api(f'/api/fangji/projects/{project_id}/identity/recompute', env, 'POST', {})
            print(json.dumps({
                'rows': rows,
                'seed_seconds': round(seed_seconds, 1),
                'rules_run': rules,
                'rules_run_wall_seconds': round(rules_wall, 1),
                'rules_ms_per_row': round(rules['duration_ms'] / rows, 4),
                'rules_difficulty_tiers': rules.get('difficulty_tiers'),
                'first_run': summary,
                'first_run_wall_seconds': round(wall, 1),
                'second_run_duration_ms': again['duration_ms'],
                'second_run_findings': again['findings'],
                'ms_per_row': round(summary['duration_ms'] / rows, 4),
            }, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
