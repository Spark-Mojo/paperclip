import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
parent = Path(os.environ['PAPERCLIP_RUN_SCRATCH_DIR'])
assert parent.is_dir() and not parent.is_relative_to(root)
fixture = Path(tempfile.mkdtemp(prefix='isolated-controls-', dir=parent))
files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
for name in filter(None, files):
    source = root / name
    target = fixture / name
    if not source.is_file():
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
modules = sorted({(root / name).parent / 'node_modules' for name in files if name.endswith('package.json') and (root / name).parent.joinpath('node_modules').is_dir()})

def snapshot():
    result = {}
    for module in modules:
        for current, dirs, names in os.walk(module, followlinks=False):
            dirs[:] = [d for d in dirs if d != '.pnpm']
            for name in dirs + names:
                path = Path(current) / name
                if path.is_symlink():
                    result[str(path)] = (os.readlink(path), str(path.resolve()))
    return result

before = snapshot()

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

try:
    for module in modules:
        target = fixture / module.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        copy_dependency(module, target)
    assert snapshot() == before, 'workspace dependency links changed'
    for module in modules:
        scope = fixture / module.relative_to(root) / '@paperclipai'
        if scope.exists():
            assert not scope.is_symlink(), 'scope must be a real directory'
            for entry in scope.iterdir():
                assert entry.resolve().is_relative_to(fixture), str(entry)
    controls = [
        ('diagnostics', 'server/src/services/heartbeat-query-diagnostics.ts', '        state.inFlight -= 1;', '        state.inFlight += 0;', 'server/src/__tests__/heartbeat-query-diagnostics.test.ts', 'AssertionError'),
        ('backfill', 'server/src/services/activity.ts', '.slice(0, 20)', '.slice(0, 0)', 'server/src/__tests__/activity-service.test.ts', 'AssertionError'),
        ('migration', 'packages/db/src/migrations/9283_missing_terminal_run_liveness_index.sql', "NOT IN ('queued', 'running')", "NOT IN ('queued', 'running', 'scheduled_retry')", 'packages/db/src/heartbeat-context-snapshot-index-migration.test.ts', 'AssertionError'),
    ]
    for label, name, old, new, suite, expected in controls:
        path = fixture / name
        assert path.resolve().is_relative_to(fixture)
        original = path.read_text()
        assert original.count(old) == 1
        for phase in ['baseline', 'mutation', 'restored']:
            path.write_text(original.replace(old, new) if phase == 'mutation' else original)
            result = subprocess.run(['timeout', '600', str(fixture / 'node_modules/.bin/vitest'), 'run', suite], cwd=fixture, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            print(result.stdout, flush=True)
            assert snapshot() == before, 'workspace dependency links changed'
            assert (root / name).read_text() == original, 'workspace source changed'
            if phase == 'mutation':
                assert result.returncode == 1 and expected in result.stdout and 'FAIL' in result.stdout
            else:
                assert result.returncode == 0 and 'passed' in result.stdout
            print(f'{label} {phase} exit={result.returncode}', flush=True)
    print('ISOLATED_CONTROLS_PASS workspace-links-unchanged', flush=True)
finally:
    assert snapshot() == before, 'workspace dependency links changed'
    shutil.rmtree(fixture)
