#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

for command in curl find flock install sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing command: $command" >&2; exit 1; }
done

primary_origin="${MFW_MIRROR_ORIGIN:-https://xmr.tex8.com}"
[[ "$primary_origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || {
  echo "MFW_MIRROR_ORIGIN must be an HTTPS origin." >&2
  exit 1
}

release_root="${MFW_MIRROR_RELEASE_ROOT:-/var/www/monero-fast-wallet-releases}"
current_link="${MFW_MIRROR_CURRENT_LINK:-/var/www/monero-fast-wallet.current}"
[[ "$release_root" =~ ^/[A-Za-z0-9._/-]+$ && "$current_link" =~ ^/[A-Za-z0-9._/-]+$ && "$current_link" != "/" ]] || {
  echo "Invalid mirror destination." >&2
  exit 1
}
lock_path="/run/lock/mfw-project-page-mirror.lock"
install -d -o root -g root -m 0755 "$release_root"
exec 9>"$lock_path"
flock -n 9 || exit 0

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

curl -fsS --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 30 \
  "$primary_origin/mfw-mirror/current" -o "$work_dir/current"
[[ "$(wc -c <"$work_dir/current")" -le 192 ]] || { echo "Mirror manifest is too large." >&2; exit 1; }

mapfile -t manifest_lines <"$work_dir/current"
[[ "${#manifest_lines[@]}" -eq 2 ]] || { echo "Invalid mirror manifest." >&2; exit 1; }
[[ "${manifest_lines[0]}" =~ ^version=([0-9]{8}T[0-9]{6}Z)$ ]] || { echo "Invalid mirror version." >&2; exit 1; }
version="${BASH_REMATCH[1]}"
[[ "${manifest_lines[1]}" =~ ^sha256=([0-9a-f]{64})$ ]] || { echo "Invalid mirror SHA-256." >&2; exit 1; }
expected_sha256="${BASH_REMATCH[1]}"

active_dir="$(readlink -f "$current_link" 2>/dev/null || true)"
if [[ -n "$active_dir" && -f "$active_dir/.mfw-mirror-sha256" ]] && \
   [[ "$(<"$active_dir/.mfw-mirror-sha256")" == "$expected_sha256" ]]; then
  echo "Mirror already current: $version"
  exit 0
fi

archive="$work_dir/release.tar.gz"
curl -fsS --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 180 \
  --max-filesize 67108864 \
  "$primary_origin/mfw-mirror/releases/$expected_sha256.tar.gz" -o "$archive"
actual_sha256="$(sha256sum "$archive" | awk '{print $1}')"
[[ "$actual_sha256" == "$expected_sha256" ]] || { echo "Mirror SHA-256 mismatch." >&2; exit 1; }

tar -tzf "$archive" >"$work_dir/paths"
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$work_dir/paths" || grep -Evq '^\./[A-Za-z0-9._/-]*$' "$work_dir/paths"; then
  echo "Unsafe mirror archive path." >&2
  exit 1
fi
if tar -tvzf "$archive" | awk '$1 !~ /^[d-]/ { invalid=1 } END { exit(invalid ? 0 : 1) }'; then
  echo "Mirror archive contains an unsafe entry type." >&2
  exit 1
fi

extract_dir="$work_dir/extracted"
mkdir "$extract_dir"
tar --extract --gzip --file "$archive" --directory "$extract_dir" \
  --no-same-owner --no-same-permissions
if find "$extract_dir" ! -type f ! -type d -print -quit | grep -q .; then
  echo "Mirror archive contains a non-regular file." >&2
  exit 1
fi
[[ -f "$extract_dir/index.html" && -d "$extract_dir/assets" && -f "$extract_dir/monero-wallet-logo.svg" ]] || {
  echo "Mirror release is incomplete." >&2
  exit 1
}

release_dir="$release_root/${version}-${expected_sha256}"
if [[ ! -d "$release_dir" ]]; then
  release_stage="$(mktemp -d "$release_root/.mirror.XXXXXX")"
  cp -a "$extract_dir/." "$release_stage/"
  printf '%s\n' "$expected_sha256" >"$release_stage/.mfw-mirror-sha256"
  chown -R root:root "$release_stage"
  find "$release_stage" -type d -exec chmod 0755 {} +
  find "$release_stage" -type f -exec chmod 0644 {} +
  mv -T "$release_stage" "$release_dir"
fi

ln -sfn "$release_dir" "${current_link}.next"
mv -Tf "${current_link}.next" "$current_link"
echo "Mirror activated: $version ($(wc -c <"$archive") bytes, SHA-256 verified)"
