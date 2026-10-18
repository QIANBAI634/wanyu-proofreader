#!/usr/bin/env python3
"""Fail when the suite files, suites.json and the CI/docs lists drift apart.

The matrix used to live only inside ci.yml, so CONTRIBUTING.md listed four
suites while CI ran eleven. Adding a suite file now requires registering it, and
every coverage claim below is read out of the parsed workflow's `run:` steps and
the `env:` that feeds them, rather than matched against the file as text — so
deleting a job, leaving the job's name behind in a comment, or pinning a matrix
value to a constant can no longer keep this guard green. A step only counts as
feeding a suite when it runs the suite runner itself.
"""
import json
import re
import sys

import harness
import yaml

ROOT = harness.BACKEND.parent
CI = ROOT / '.github' / 'workflows' / 'ci.yml'
CONTRIBUTING = ROOT / 'CONTRIBUTING.md'
TESTS = harness.BACKEND / 'tests'
MATRIX_JOB = 'pocketbase-compatibility'
PREPARE_JOB = 'prepare-matrix'
MATRIX_EXPRESSION = '${{ fromJson(needs.prepare-matrix.outputs.suites) }}'
RUNNER = 'backend/tests/run_integration.py'
# The negative lookahead keeps `matrix.suites` and `matrix.suite_extra` out: a job
# fans out over `matrix.suite`, and only that name carries a suite.
MATRIX_SUITE = re.compile(r'\$\{\{\s*matrix\.suite(?![A-Za-z0-9_])')


def strip_shell_comments(script):
    """Drop full-line shell comments from a `run:` scalar.

    A suite name is satisfied by being *executed*, not by being described. Without
    this, `wc -l` of a comment block counts as coverage: the scheme conversion
    browser suite was kept green by a single comment naming its file, which was
    that file name's only appearance anywhere in the workflow.
    """
    return '\n'.join(line for line in script.splitlines() if not line.lstrip().startswith('#'))


def run_commands(workflow):
    """Every script CI would actually execute, one entry per job."""
    commands = {}
    for name, job in (workflow.get('jobs') or {}).items():
        scripts = [str(step['run']) for step in (job.get('steps') or [])
                   if isinstance(step, dict) and step.get('run')]
        commands[name] = strip_shell_comments('\n'.join(scripts))
    return commands


def runner_steps(job):
    """The `run:` scripts of this job that invoke the suite runner."""
    return [str(step['run']) for step in (job.get('steps') or [])
            if isinstance(step, dict) and step.get('run')
            and RUNNER in strip_shell_comments(str(step['run']))]


def self_test():
    """The matching above must not be satisfiable by a comment.

    Always run, and in-process: the failure it guards against is invisible from the
    outside — the guard stays green while the CI step it claims exists is only a
    comment. If a later edit stops stripping comments, this goes red immediately
    instead of quietly widening what counts as coverage.
    """
    workflow = {'jobs': {'a-job': {'steps': [{'run': '# backend/tests/only_a_comment.mjs\n'}]}}}
    return 'only_a_comment.mjs' not in '\n'.join(run_commands(workflow).values())


def suite_matrix_jobs(workflow):
    """Jobs whose strategy fans out over a `suite` matrix."""
    for name, job in (workflow.get('jobs') or {}).items():
        matrix = ((job or {}).get('strategy') or {}).get('matrix') or {}
        if 'suite' in matrix:
            yield name, job


def suite_matrix_is_consumed(job):
    """True when a runner step of this job is fed by the matrix value.

    The value reaches a step either directly or through an `env:` name the step
    expands — a step env, or a job env every step inherits. Reading the key out of
    the YAML instead of assuming one keeps any alias and any `${{matrix.suite}}`
    spacing working. Only the commands that run the runner count: the check used
    to accept the matrix value appearing in any step at all, so a decorative
    `echo ${{ matrix.suite }}` alongside a hardcoded runner call read as consumed
    while every job ran the same suite.
    """
    commands = runner_steps(job)
    if not commands:
        return False
    steps = [step for step in (job.get('steps') or []) if isinstance(step, dict)]
    handed = ([step.get('env') or {} for step in steps if step.get('run')]
              + [job.get('env') or {}])
    names = {str(key) for env in handed for key, value in env.items()
             if MATRIX_SUITE.search(str(value))}
    return any(MATRIX_SUITE.search(command)
               or any(re.search(r'\$\{' + re.escape(name) + r'\}', command) for name in names)
               for command in commands)


def ci_builds_matrix_from_registry(workflow):
    """True only when a real job feeds suites.json into the matrix at runtime."""
    jobs = workflow.get('jobs') or {}
    matrix = jobs.get(MATRIX_JOB) or {}
    if matrix.get('needs') != PREPARE_JOB or PREPARE_JOB not in jobs:
        return False
    expression = ((matrix.get('strategy') or {}).get('matrix') or {}).get('include')
    if expression != MATRIX_EXPRESSION:
        return False
    # The prepare job must really read the registry, not emit a constant list.
    if 'suites.json' not in run_commands(workflow).get(PREPARE_JOB, ''):
        return False
    # And the matrix job must still run the suites it was handed, by name.
    return suite_matrix_is_consumed(matrix)


def main():
    entries = json.loads((TESTS / 'suites.json').read_text())
    registered = {entry['suite']: entry for entry in entries}
    on_disk = sorted(path.name for path in TESTS.glob('*_integration.mjs'))
    workflow = yaml.safe_load(CI.read_text())
    commands = run_commands(workflow)
    executed = '\n'.join(commands.values())
    problems = []

    if not executed.strip():
        problems.append('ci.yml declares no runnable steps at all')
    if not self_test():
        problems.append('this checker no longer strips shell comments: a comment can keep a claim green')
    matrix_driven = ci_builds_matrix_from_registry(workflow)
    if not matrix_driven:
        problems.append(f'ci.yml does not feed suites.json into {MATRIX_JOB} through {PREPARE_JOB}')

    # The check above only follows the registry link. race-integration and
    # core-workflows fan out over their own literal suite lists, so each of them
    # gets the same "does the matrix value reach a runner" question asked here.
    for name, job in suite_matrix_jobs(workflow):
        if not suite_matrix_is_consumed(job):
            problems.append(f'{name}: declares a suite matrix but no runner step consumes it')

    for suite in sorted(set(on_disk) - set(registered)):
        problems.append(f'{suite}: exists on disk but is not registered in suites.json')
    for suite in sorted(set(registered) - set(on_disk)):
        problems.append(f'{suite}: listed in suites.json but backend/tests/{suite} is missing')

    for suite, entry in registered.items():
        if entry.get('ci_matrix') and matrix_driven:
            continue
        # What must actually appear in an executed step: a dedicated runner, else
        # the suite file itself.
        wanted = entry.get('ci_runner') or suite
        if wanted not in executed:
            problems.append(f'{suite}: registered but no CI step executes {wanted}')

    for check in sorted(path.name for path in TESTS.glob('check_*.py')):
        if check not in executed:
            problems.append(f'{check}: exists but no CI step executes it')

    if 'make check' not in CONTRIBUTING.read_text():
        problems.append('CONTRIBUTING.md does not document `make check`')

    if problems:
        print('test inventory drift:', file=sys.stderr)
        for problem in problems:
            print(f'  - {problem}', file=sys.stderr)
        return 1
    print(f'PASS: {len(on_disk)} integration suites registered on disk and executed by CI')
    return 0


if __name__ == '__main__':
    sys.exit(main())
