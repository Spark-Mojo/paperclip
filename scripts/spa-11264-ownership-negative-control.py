import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

SOURCE = 'server/src/services/conversation-continuation.ts'
SUITE = 'server/src/__tests__/conversation-ownership-query.test.ts'
TEST_COUNT = 8

NATIVE_ARM = "${heartbeatRuns.nativeIssueId} = ${issueId}::uuid or "
NATIVE_NON_SARGABLE = "${heartbeatRuns.nativeIssueId}::text = ${issueId} or "
CONTEXT_ARM = "${heartbeatRuns.nativeIssueId} is null and ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}"
CONTEXT_NON_SARGABLE = "${heartbeatRuns.nativeIssueId} is null and concat(${heartbeatRuns.contextSnapshot}->>'issueId', '') = ${issueId}"
NULL_GUARD = "${heartbeatRuns.nativeIssueId} is null and "

NATIVE_PLAN_TEST = 'binds the native uuid arm to a native-issue index with an issue-specific Index Cond'
CONTEXT_PLAN_TEST = 'binds the context arm to the context-issue index with an issue-specific Index Cond'
SCAN_SHAPE_TEST = 'reads heartbeat_runs through an index scan for both arms, never a sequential scan'
COALESCE_ORACLE_TEST = 'keeps the result set equal to the coalesce oracle on the selective fixture'
DIFFERENTIAL_TEST = 'selects the same rows in the same order as the original predicate for every issue input shape'

MUTATIONS = [
    ('native-equality-non-sargable', NATIVE_ARM, NATIVE_NON_SARGABLE,
     [NATIVE_PLAN_TEST, SCAN_SHAPE_TEST]),
    ('context-expression-non-sargable', CONTEXT_ARM, CONTEXT_NON_SARGABLE,
     [CONTEXT_PLAN_TEST, SCAN_SHAPE_TEST]),
    ('dropped-native-null-guard', NULL_GUARD, '',
     [DIFFERENTIAL_TEST, COALESCE_ORACLE_TEST]),
]

root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
parent = Path(os.environ['PAPERCLIP_RUN_SCRATCH_DIR'])
assert parent.is_dir() and not parent.is_relative_to(root), 'scratch dir must be outside the workspace'
fixture = Path(tempfile.mkdtemp(prefix='isolated-ownership-', dir=parent))
tracked = [name for name in subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0') if name]
for name in tracked:
    source = root / name
    if not source.is_file():
        continue
    target = fixture / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
modules = sorted({(root / name).parent / 'node_modules' for name in tracked
                  if name.endswith('package.json') and (root / name).parent.joinpath('node_modules').is_dir()})


def snapshot_links():
    result = {}
    for module in modules:
        for current, dirs, names in os.walk(module, followlinks=False):
            dirs[:] = [d for d in dirs if d != '.pnpm']
            for name in dirs + names:
                path = Path(current) / name
                if path.is_symlink():
                    result[str(path)] = (os.readlink(path), str(path.resolve()))
    return result


def workspace_digest():
    digest = hashlib.sha256()
    for name in tracked:
        source = root / name
        if source.is_symlink() or not source.is_file():
            continue
        digest.update(name.encode())
        digest.update(b'\0')
        digest.update(hashlib.sha256(source.read_bytes()).hexdigest().encode())
        digest.update(b'\n')
    return digest.hexdigest()


links_before = snapshot_links()
bytes_before = workspace_digest()


def copy_dependency(source, target):
    assert not target.exists() and not target.is_symlink()
    if source.is_symlink():
        resolved = source.resolve(strict=True)
        if resolved.is_relative_to(root) and not resolved.is_relative_to(root / 'node_modules'):
            resolved = fixture / resolved.relative_to(root)
        target.symlink_to(resolved, target_is_directory=source.is_dir())
    elif source.is_dir():
        if source.name == '.pnpm':
            target.symlink_to(source, target_is_directory=True)
        else:
            target.mkdir()
            for entry in source.iterdir():
                copy_dependency(entry, target / entry.name)
    else:
        shutil.copy2(source, target)


def run_suite(phase):
    report = fixture / 'phase-report.json'
    if report.exists():
        report.unlink()
    result = subprocess.run(
        ['timeout', '900', str(fixture / 'node_modules/.bin/vitest'), 'run', SUITE,
         '--reporter=json', f'--outputFile={report}'],
        cwd=fixture, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    statuses = {}
    executed = 0
    if report.exists():
        payload = json.loads(report.read_text())
        for entry in payload.get('testResults', []):
            for assertion in entry.get('assertionResults', []):
                statuses[assertion['title']] = assertion['status']
                executed += 1
    print(f'{phase} exit={result.returncode} executed={executed}', flush=True)
    for title, status in statuses.items():
        print(f'    {status} | {title}', flush=True)
    return result.returncode, statuses, executed


try:
    for module in modules:
        target = fixture / module.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        copy_dependency(module, target)
    assert snapshot_links() == links_before, 'workspace dependency links changed'
    for module in modules:
        scope = fixture / module.relative_to(root) / '@paperclipai'
        if scope.exists():
            assert not scope.is_symlink(), 'scope must be a real directory'
            for entry in scope.iterdir():
                assert entry.resolve().is_relative_to(fixture), str(entry)

    name = SOURCE
    path = fixture / name
    assert path.resolve().is_relative_to(fixture), 'fixture copy must not escape the fixture'
    original = path.read_text()

    code, statuses, executed = run_suite('baseline')
    assert code == 0, 'baseline must pass'
    assert executed == TEST_COUNT, f'baseline executed {executed} tests, expected {TEST_COUNT}'
    assert all(status == 'passed' for status in statuses.values()), 'baseline must not skip or fail a test'

    for label, old, new, targets in MUTATIONS:
        assert original.count(old) == 1, f'{label}: expected one occurrence, found {original.count(old)}'
        assert old not in new, f'{label}: replacement must differ'
        path.write_text(original.replace(old, new))
        try:
            code, statuses, executed = run_suite(f'mutation {label}')
            assert code != 0, f'{label}: suite must exit nonzero'
            for target in targets:
                assert statuses.get(target) == 'failed', \
                    f'{label}: targeted test did not fail: {target!r} is {statuses.get(target)!r}'
        finally:
            path.write_text(original)

    code, statuses, executed = run_suite('restored')
    assert code == 0, 'restored must pass'
    assert executed == TEST_COUNT, f'restored executed {executed} tests, expected {TEST_COUNT}'
    assert all(status == 'passed' for status in statuses.values()), 'restored must not skip or fail a test'

    assert (root / name).read_text() == original, 'workspace source changed'
    assert snapshot_links() == links_before, 'workspace dependency links changed'
    assert workspace_digest() == bytes_before, 'workspace tracked bytes changed'
    print(f'WORKSPACE_SHA256={bytes_before}', flush=True)
    print('ISOLATED_CONTROLS_PASS workspace-links-unchanged', flush=True)
finally:
    assert snapshot_links() == links_before, 'workspace dependency links changed'
    assert workspace_digest() == bytes_before, 'workspace tracked bytes changed'
    shutil.rmtree(fixture)