"""Build a portable Windows release from compiled native and viewer outputs."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
version = json.loads((root / 'viewer/package.json').read_text(encoding='utf-8'))['version']
releases = root / 'releases'
archive = releases / f'IsaacDoctor-{version}-windows-x64.zip'
checksum = archive.with_suffix('.zip.sha256')
if archive.exists() or checksum.exists():
    raise SystemExit(f'Release {version} already exists in releases/. Bump the version before packaging.')
required = ['isaacprof.dll', 'isaacprof-injector.exe', 'isaacprof-collector.exe', 'isaacprof-analyze.exe']
for name in required:
    if not (root / 'build/Release' / name).is_file():
        raise SystemExit(f'Missing native output: {name}. Run build.ps1 first.')
if not (root / 'viewer/dist/index.html').is_file():
    raise SystemExit('Missing viewer output. Run pnpm --dir viewer build first.')
releases.mkdir(exist_ok=True)
# Only the ZIP and checksum survive packaging. Temporary PyInstaller output
# stays in build/ and is removed when this process exits, including on failure.
staging = tempfile.TemporaryDirectory(prefix='release-package-', dir=root / 'build')
output = pathlib.Path(staging.name)
subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--console', '--hidden-import', 'viewer-server', '--paths', str(root / 'tools'),
                '--icon', str(root / 'viewer/public/isaac-doctor.ico'),
                '--name', 'IsaacDoctor', '--distpath', str(output),
                '--workpath', str(output / 'work'), '--specpath', str(output / 'spec'),
                str(root / 'tools/release-launcher.py')], cwd=root, check=True)
package = output / 'IsaacDoctor'
(package / 'bin').mkdir()
for name in required:
    shutil.copy2(root / 'build/Release' / name, package / 'bin' / name)
shutil.copytree(root / 'viewer/dist', package / 'viewer/dist')
shutil.copytree(root / 'docs/licenses', package / 'docs/licenses')
for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
    shutil.copy2(root / name, package / name)
# The bundled interpreter is unmodified; preserve its complete license notices.
shutil.copy2(pathlib.Path(sys.base_prefix) / 'LICENSE.txt', package / 'PYTHON-LICENSE.txt')
(package / 'README.txt').write_text(
    'Isaac Doctor ' + version + '\n\n'
    '1. Extract the complete ZIP to a writable folder.\n'
    '2. Double-click IsaacDoctor.exe and keep its window open. Chrome or Edge is recommended.\n'
    '3. Start Isaac separately through REPENTOGONLauncher, as usual.\n'
    '4. In the browser, Connect game, then Record.\n'
    '5. Connect captures folder to IsaacDoctor/bin/captures for automatic opening.\n\n'
    'No Python, Node.js, Visual Studio or build step is needed.\n'
    'Stop local server stops recording and closes the controller. Loaded analysis remains\n'
    'in the browser; refresh requires launching IsaacDoctor.exe again. Closing only the\n'
    'browser tab leaves the controller running. Closing the EXE window stops recording\n'
    'and closes the controller. It never launches or closes the game.\n'
    'The injected DLL stays loaded until the game exits; restart the game via its launcher\n'
    'before changing to another profiler version.\n\n'
    'Recordings can be large. Leave free disk space in this extracted folder.\n'
    'The full TypeScript CLI is available from the source repository; the bundled native\n'
    'isaacprof-analyze.exe provides aggregate-only analysis.\n', encoding='utf-8')
temporary_archive = output / archive.name
with zipfile.ZipFile(temporary_archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for file in sorted(package.rglob('*')):
        if file.is_file():
            z.write(file, file.relative_to(output))
with temporary_archive.open('rb') as handle:
    digest = hashlib.file_digest(handle, 'sha256').hexdigest()
temporary_checksum = output / checksum.name
temporary_checksum.write_text(digest + '  ' + archive.name + '\n', encoding='ascii')
# Publish complete files only. Existing versioned artifacts are never replaced.
temporary_archive.rename(archive)
temporary_checksum.rename(checksum)
staging.cleanup()
print(f'Release ZIP: {archive} ({archive.stat().st_size:,} bytes)')
