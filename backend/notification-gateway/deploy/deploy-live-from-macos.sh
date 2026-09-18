#!/usr/bin/env bash
set -euo pipefail

echo "Refusing live deployment: the v3 signed-Worker Gateway is source-tested but its app-integrity/provider-registration adapter and release assignment provisioning are not accepted yet." >&2
echo "The removed shared-scanner-token deployment must not be restored. Complete the Gateway release gates in docs/SECURITY.md first." >&2
exit 1
