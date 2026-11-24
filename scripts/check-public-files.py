"""Validate and safely synchronize the explicit public source inventory; never stage or publish files."""
import argparse
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'public-files.json'
FORBIDDEN_DIR_PARTS = frozenset({
    '.git',
    '.local',
    '.tools',
    'node_modules',
    '__pycache__',
    'artifacts',
    'evidence',
    'dist',
    'dist-extension',
})


def ignore_text(paths):
    children = {}
    for name in paths:
        parts = name.split('/')
        for index, part in enumerate(parts):
            parent = '/'.join(parts[:index])
            child = '/'.join(parts[:index + 1])
            children.setdefault(parent, set()).add((child, index < len(parts) - 1))
    lines = ['# Generated from public-files.json by scripts/check-public-files.py --write-ignore.',
             '# Unlisted local files are retained but excluded from Git.']
    for parent in sorted(children, key=lambda p: (p.count('/') + bool(p), p)):
        lines.append('/' + (parent + '/' if parent else '') + '*')
        for child, directory in sorted(children[parent]):
            lines.append('!/' + child + ('/' if directory else ''))
    return '\n'.join(lines) + '\n'


def git(*arguments, root=ROOT):
    return subprocess.check_output(
        ['git', '-c', f'safe.directory={root.as_posix()}', *arguments], cwd=root)


def normalize_relative_path(raw_name):
    cleaned = raw_name.replace('\\', '/').strip()
    if cleaned.startswith('./'):
        cleaned = cleaned[2:]
    return cleaned


def validate_paths(paths, *, root=ROOT):
    if not paths or paths != sorted(set(paths)):
        raise ValueError('files must be a nonempty sorted list without duplicates')
    resolved_root = root.resolve()
    for name in paths:
        relative = PurePosixPath(name)
        if '\\' in name or relative.is_absolute() or '..' in relative.parts or relative.as_posix() != name:
            raise ValueError(f'Invalid relative path: {name}')
        if any(part in FORBIDDEN_DIR_PARTS for part in relative.parts):
            raise ValueError(f'Local/generated directory in inventory: {name}')
        if relative.name.startswith('.env') and relative.name != '.env.example':
            raise ValueError(f'Only .env.example is allowed: {name}')
        source = root / name
        if not source.is_file() or not source.resolve().is_relative_to(resolved_root):
            raise ValueError(f'Missing or external file: {name}')
        if source.is_symlink():
            raise ValueError(f'Symlink is not permitted: {name}')
        # Check ancestors explicitly, including Windows directory links/junctions.
        for ancestor in source.parents:
            if ancestor == root:
                break
            if ancestor.is_symlink() or (hasattr(ancestor, 'is_junction') and ancestor.is_junction()):
                raise ValueError(f'Linked parent is not permitted: {name}')


def write_manifest(manifest_path, data, paths):
    updated = dict(data)
    updated['files'] = paths
    manifest_path.write_text(
        json.dumps(updated, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8',
        newline='\n',
    )


def run_check(argv=None, *, root=ROOT):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged', action='store_true', help='Require the entire Git index to match the inventory')
    parser.add_argument('--write-ignore', action='store_true', help='Regenerate the default-deny .gitignore')
    parser.add_argument(
        '--sync',
        action='store_true',
        help='Sync public-files.json from the Git index (plus any --add paths), pruning deleted files and rewriting .gitignore',
    )
    parser.add_argument(
        '--add',
        nargs='+',
        default=[],
        metavar='PATH',
        help='Explicitly validate and add repo-relative file path(s) to public-files.json and regenerate .gitignore',
    )
    args = parser.parse_args(argv)
    manifest_path = root / 'public-files.json'
    ignore_path = root / '.gitignore'
    data = json.loads(manifest_path.read_text(encoding='utf-8'))

    if args.sync or args.add:
        if args.sync:
            tracked = [
                name.decode('utf-8')
                for name in git('ls-files', '-z', root=root).split(b'\0')
                if name
            ]
            # Keep existing tracked entries that still exist on disk; always keep public-files.json and .gitignore.
            candidate_set = {
                name for name in tracked if (root / name).is_file()
            }
            candidate_set.add('public-files.json')
            candidate_set.add('.gitignore')
        else:
            candidate_set = set(data['files'])

        for raw in args.add:
            norm = normalize_relative_path(raw)
            if '\\' in raw:
                raise ValueError(f'Invalid relative path: {raw}')
            candidate_set.add(norm)

        paths = sorted(candidate_set)
        # Validate every candidate BEFORE mutating public-files.json or .gitignore (fail closed).
        # Temporarily ensure .gitignore exists as a regular file only if already present; otherwise validate others first.
        validate_paths(paths, root=root)
        write_manifest(manifest_path, data, paths)
        ignore_path.write_text(ignore_text(paths), encoding='utf-8', newline='\n')
    else:
        paths = data['files']
        validate_paths(paths, root=root)
        expected_ignore = ignore_text(paths)
        if args.write_ignore:
            ignore_path.write_text(expected_ignore, encoding='utf-8', newline='\n')
        elif ignore_path.read_text(encoding='utf-8') != expected_ignore:
            raise ValueError('Run python scripts/check-public-files.py --write-ignore after changing the inventory')

    if args.staged:
        staged = sorted(name.decode('utf-8') for name in git('ls-files', '-z', root=root).split(b'\0') if name)
        if staged != paths:
            raise ValueError(f'Index differs: missing={sorted(set(paths)-set(staged))}; extra={sorted(set(staged)-set(paths))}')
        unstaged = git('diff', '--name-only', '-z', root=root)
        if unstaged:
            raise ValueError('Tracked working files differ from the reviewed index')
    print(f'Public inventory verified: {len(paths)} files' + ('; index matches' if args.staged else ''))
    return 0


def main():
    return run_check()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f'Public inventory check failed: {error}', file=sys.stderr)
        sys.exit(1)
