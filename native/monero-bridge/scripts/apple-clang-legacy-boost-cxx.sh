#!/usr/bin/env bash
# Boost 1.69's Darwin toolset still injects -fcoalesce-templates. Current
# Apple Clang rejects that removed compiler option. Keep the authenticated
# Monero/Boost sources immutable and filter only this known legacy argument.
set -euo pipefail

filtered_args=()
for argument in "$@"; do
  if [[ "${argument}" == "-fcoalesce-templates" ]]; then
    continue
  fi
  filtered_args+=("${argument}")
done

exec /usr/bin/clang++ "${filtered_args[@]}"
