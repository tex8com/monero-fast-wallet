#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi
for command in curl flock install sha256sum wc; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing command: $command" >&2; exit 1; }
done

primary_origin="${MFW_MIRROR_ORIGIN:-https://xmr.tex8.com}"
[[ "$primary_origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "Invalid mirror origin." >&2; exit 1; }
artifact_root="/var/www/mfw-downloads"
manifest_path="$artifact_root/releases.json"
lock_path="/run/lock/mfw-download-mirror.lock"
install -d -o root -g root -m 0755 "$artifact_root"
exec 9>"$lock_path"
flock -n 9 || exit 0

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
incoming_manifest="$work_dir/releases.json"
curl -fsS --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 30 --max-filesize 131072 \
  "$primary_origin/mfw-download-mirror/releases.json" -o "$incoming_manifest"
/usr/local/libexec/mfw-download-gateway validate-manifest --manifest "$incoming_manifest"
/usr/local/libexec/mfw-download-gateway mirror-plan --manifest "$incoming_manifest" >"$work_dir/plan"

while IFS=$'\t' read -r sha256 filename expected_size; do
  [[ -n "$sha256" ]] || continue
  destination_dir="$artifact_root/$sha256"
  destination="$destination_dir/$filename"
  if [[ -f "$destination" ]] && [[ "$(wc -c <"$destination")" == "$expected_size" ]] && [[ "$(sha256sum "$destination" | awk '{print $1}')" == "$sha256" ]]; then
    continue
  fi
  install -d -o root -g root -m 0755 "$destination_dir"
  temporary="$work_dir/$filename"
  curl -fsS --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 900 --max-filesize 2147483648 \
    "$primary_origin/mfw-download-mirror/releases/$sha256/$filename" -o "$temporary"
  [[ "$(wc -c <"$temporary")" == "$expected_size" ]] || { echo "Artifact size mismatch." >&2; exit 1; }
  [[ "$(sha256sum "$temporary" | awk '{print $1}')" == "$sha256" ]] || { echo "Artifact SHA-256 mismatch." >&2; exit 1; }
  install -o root -g root -m 0644 "$temporary" "${destination}.next"
  mv -Tf "${destination}.next" "$destination"
done <"$work_dir/plan"

install -o root -g root -m 0644 "$incoming_manifest" "${manifest_path}.next"
mv -Tf "${manifest_path}.next" "$manifest_path"
curl -fsS http://127.0.0.1:8097/v1/mfw-site/releases >/dev/null
