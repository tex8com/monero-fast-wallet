#!/usr/bin/env bash
set -euo pipefail

primary_target="${MFW_PRIMARY_SSH_TARGET:-private-ssh-host}"
secondary_target="${MFW_SECONDARY_SSH_TARGET:?Set MFW_SECONDARY_SSH_TARGET}"
secondary_identity="${MFW_SECONDARY_SSH_IDENTITY:-$HOME/.ssh/id_ed25519_mfw_secondary}"
gateway="/usr/local/libexec/mfw-download-gateway"
database="/var/lib/mfw-download-gateway/metrics.sqlite3"

for command in python3 ssh; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing command: $command" >&2; exit 1; }
done
[[ -f "$secondary_identity" ]] || { echo "Server 2 SSH identity is unavailable." >&2; exit 1; }

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
ssh -o BatchMode=yes "$primary_target" "sudo -n python3 '$gateway' report --database '$database' --include-registers" >"$work_dir/server1.json"
ssh -o BatchMode=yes -i "$secondary_identity" "$secondary_target" "sudo -n python3 '$gateway' report --database '$database' --include-registers" >"$work_dir/server2.json"

python3 - "$work_dir/server1.json" "$work_dir/server2.json" <<'PY'
import base64
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone

documents = [json.load(open(path, encoding="utf-8")) for path in sys.argv[1:]]
counters = defaultdict(int)
registers = {}
for document in documents:
    for row in document["counters"]:
        key = tuple(row[name] for name in ("day", "event", "product", "platform", "version", "package", "country"))
        counters[key] += int(row["count"])
    for row in document["unique_estimates"]:
        key = tuple(row[name] for name in ("day", "event", "product", "platform", "version", "package"))
        decoded = base64.b64decode(row["registers"], validate=True)
        current = registers.get(key, bytes(len(decoded)))
        registers[key] = bytes(max(left, right) for left, right in zip(current, decoded))

def estimate(values):
    import math
    count = float(len(values))
    alpha = 0.7213 / (1.0 + 1.079 / count)
    result = alpha * count * count / sum(2.0 ** (-value) for value in values)
    zeroes = values.count(0)
    if result <= 2.5 * count and zeroes:
        result = count * math.log(count / zeroes)
    return max(0, round(result))

counter_rows = []
for key, count in sorted(counters.items()):
    row = dict(zip(("day", "event", "product", "platform", "version", "package", "country"), key))
    row["count"] = count
    counter_rows.append(row)
unique_rows = []
for key, values in sorted(registers.items()):
    row = dict(zip(("day", "event", "product", "platform", "version", "package"), key))
    row["estimate"] = estimate(values)
    unique_rows.append(row)
print(json.dumps({
    "schema": 1,
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "servers_combined": 2,
    "counters": counter_rows,
    "unique_estimates": unique_rows,
}, indent=2, sort_keys=True))
PY
