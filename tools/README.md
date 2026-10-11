# Development and runtime tools

Most users should run `IsaacDoctor.exe` from the portable release. These scripts support the source build, recording controller and controlled tests.

| File | Purpose |
| --- | --- |
| `release-launcher.py` | Visible portable EXE window that owns a monitored controller process and opens the browser |
| `viewer-server.py` | Loopback server for built UI assets and authenticated recording commands; bundled as the portable launcher's controller |
| `package-release.py` | Package compiled native outputs, built UI, bundled runtime and notices into a ZIP and checksum; invoked by `package-release.ps1` |
| `release-requirements.txt` | Pinned Python packaging dependencies, installed into an isolated build environment |
| `capture.py` | Binary capture decoder and validation helpers used by controlled tests |

For ordinary recording, use the release UI or the root recording scripts. For headless trace analysis, use [the CLI](../docs/CLI.md).
