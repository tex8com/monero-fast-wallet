#!/usr/bin/env python3
"""Run the exact RPC height handlers with an isolated public-data backend."""
from pathlib import Path
import os
import subprocess
import tempfile

node = Path(__file__).resolve().parent.parent
rpc = node / 'binaries/cuprated/src/rpc'


def function(path, declaration):
    source = path.read_text()
    start = source.index(declaration)
    end = source.index('\n}\n', start) + len('\n}\n')
    return source[start:end]


functions = {
    'MFW_GET_VERSION_FUNCTION': function(rpc / 'handlers/json_rpc.rs', 'async fn get_version('),
    'MFW_CHAIN_HEIGHT_FUNCTION': function(rpc / 'service/blockchain.rs', 'pub async fn chain_height('),
    'MFW_TOP_HEIGHT_FUNCTION': function(rpc / 'handlers/helper.rs', 'pub(crate) async fn top_height('),
}

with tempfile.TemporaryDirectory(prefix='mfw-get-version-height-') as directory:
    root = Path(directory)
    environment = dict(os.environ)
    for name, source in functions.items():
        path = root / (name.lower() + '.rs')
        path.write_text(source)
        environment[name] = str(path)
    binary = root / 'height-tests'
    subprocess.run(
        ['rustc', '--edition=2021', '--test', '-O',
         str(node / 'scripts/fixtures/get-version-height.rs'), '-o', str(binary)],
        cwd=node, env=environment, check=True,
    )
    subprocess.run([str(binary)], cwd=root, env=environment, check=True)
