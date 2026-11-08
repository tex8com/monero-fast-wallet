#!/usr/bin/env python3
"""Execute the production migration with isolated stores; no wallet/OS access."""
from pathlib import Path
import os
import subprocess
import tempfile

desktop = Path(__file__).resolve().parent.parent
host = (desktop / 'src-tauri/src/lib.rs').read_text()
start = host.index('fn migrate_and_prime_app_session_credentials(')
end = host.index('\n}\n', start) + len('\n}\n')
function = host[start:end]
fixture = desktop / 'scripts/fixtures/app-vault-migration.rs'

with tempfile.TemporaryDirectory(prefix='mfw-app-vault-migration-') as temporary:
    root = Path(temporary)
    production = root / 'migration.rs'
    production.write_text(function)
    environment = dict(os.environ, MFW_APP_VAULT_MIGRATION_FUNCTION=str(production))
    binary = root / 'migration-tests'
    subprocess.run(
        ['rustc', '--edition=2021', '--test', '-O', str(fixture), '-o', str(binary)],
        cwd=desktop, env=environment, check=True,
    )
    subprocess.run([str(binary)], cwd=root, env=environment, check=True)
