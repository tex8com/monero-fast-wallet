#!/usr/bin/env bash
set -euo pipefail

required_gate="RUN_DISPOSABLE_COMMUNITY_MATRIX_E2E"
if [[ "${MFW_LIVE_COMMUNITY_MATRIX_TEST:-}" != "$required_gate" ]]; then
  echo "Refusing to mutate the live Community service without MFW_LIVE_COMMUNITY_MATRIX_TEST=$required_gate" >&2
  exit 64
fi

cli="${MFW_COMMUNITY_CLI_BIN:-}"
api_origin="${MFW_COMMUNITY_API_ORIGIN:-https://xmr.tex8.com}"
if [[ -z "$cli" || ! -x "$cli" ]]; then
  echo "MFW_COMMUNITY_CLI_BIN must name an executable monero-fast-wallet-community" >&2
  exit 64
fi
command -v jq >/dev/null || { echo "jq is required" >&2; exit 69; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 69; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 69; }

test_root="$(mktemp -d "${TMPDIR:-/tmp}/mfw-community-live.XXXXXX")"
chmod 700 "$test_root"
alice_state="$test_root/alice"
bob_state="$test_root/bob"
alice_password="$test_root/alice-password"
bob_password="$test_root/bob-password"
alice_store_password="$test_root/alice-store-password"
bob_store_password="$test_root/bob-store-password"
alice_recovery="$test_root/alice-recovery"
alice_created=false
bob_created=false

write_secret() {
  local path="$1"
  umask 077
  openssl rand -hex 32 >"$path"
  chmod 600 "$path"
}

community() {
  local state="$1"
  shift
  python3 -c '
import subprocess
import sys
try:
    result = subprocess.run(sys.argv[1:], timeout=120)
except subprocess.TimeoutExpired:
    print("Community CLI operation exceeded 120 seconds", file=sys.stderr)
    raise SystemExit(124)
raise SystemExit(result.returncode)
' "$cli" --api-origin "$api_origin" --state-dir "$state" "$@"
}

cleanup() {
  set +e
  if [[ -f "$alice_state/matrix-session.json" && -n "${alice_homeserver:-}" ]]; then
    community "$alice_state" matrix logout \
      --homeserver "$alice_homeserver" \
      --store-passphrase-file "$alice_store_password" >/dev/null 2>&1
  fi
  if [[ -f "$bob_state/matrix-session.json" && -n "${bob_homeserver:-}" ]]; then
    community "$bob_state" matrix logout \
      --homeserver "$bob_homeserver" \
      --store-passphrase-file "$bob_store_password" >/dev/null 2>&1
  fi
  if [[ "$alice_created" == true && -f "$alice_state/account.json" ]]; then
    community "$alice_state" identity delete \
      --confirm "DELETE MY COMMUNITY PROFILE" >/dev/null 2>&1
  fi
  if [[ "$bob_created" == true && -f "$bob_state/account.json" ]]; then
    community "$bob_state" identity delete \
      --confirm "DELETE MY COMMUNITY PROFILE" >/dev/null 2>&1
  fi
  if [[ "$test_root" == "${TMPDIR:-/tmp}/mfw-community-live."* && -d "$test_root" ]]; then
    rm -rf -- "$test_root"
  fi
}
trap cleanup EXIT HUP INT TERM

write_secret "$alice_password"
write_secret "$bob_password"
write_secret "$alice_store_password"
write_secret "$bob_store_password"

echo "[1/10] Creating two disposable pseudonymous identities"
alice_identity="$(community "$alice_state" identity create | jq -er '.identityId')"
alice_created=true
bob_identity="$(community "$bob_state" identity create | jq -er '.identityId')"
bob_created=true
[[ "$alice_identity" != "$bob_identity" ]]

echo "[2/10] Verifying account status"
[[ "$(community "$alice_state" status | jq -er '.identityId')" == "$alice_identity" ]]
[[ "$(community "$bob_state" status | jq -er '.identityId')" == "$bob_identity" ]]

echo "[3/10] Provisioning independent Matrix accounts"
alice_matrix="$(community "$alice_state" matrix provision --password-file "$alice_password")"
bob_matrix="$(community "$bob_state" matrix provision --password-file "$bob_password")"
alice_user="$(jq -er '.matrixUserId' <<<"$alice_matrix")"
bob_user="$(jq -er '.matrixUserId' <<<"$bob_matrix")"
alice_homeserver="$(jq -er '.homeserver' <<<"$alice_matrix")"
bob_homeserver="$(jq -er '.homeserver' <<<"$bob_matrix")"
[[ "$alice_user" != "$bob_user" ]]
[[ "$alice_homeserver" == "$bob_homeserver" ]]

echo "[4/10] Logging in with separate encrypted local Matrix stores"
community "$alice_state" matrix login \
  --homeserver "$alice_homeserver" --user-id "$alice_user" \
  --password-file "$alice_password" \
  --store-passphrase-file "$alice_store_password" >/dev/null
community "$bob_state" matrix login \
  --homeserver "$bob_homeserver" --user-id "$bob_user" \
  --password-file "$bob_password" \
  --store-passphrase-file "$bob_store_password" >/dev/null

echo "[5/10] Creating an encrypted direct room"
room_id="$(community "$alice_state" matrix open "$bob_user" \
  --homeserver "$alice_homeserver" \
  --store-passphrase-file "$alice_store_password" | jq -er '.roomId')"

echo "[6/10] Receiving and explicitly accepting the invitation"
echo "  [6a] Recipient sync"
community "$bob_state" matrix sync \
  --homeserver "$bob_homeserver" \
  --store-passphrase-file "$bob_store_password" >/dev/null
echo "  [6b] Explicit invitation acceptance"
join_result="$(community "$bob_state" matrix join "$room_id" \
  --homeserver "$bob_homeserver" \
  --store-passphrase-file "$bob_store_password")"
[[ "$(jq -er '.joined' <<<"$join_result")" == true ]]
echo "  [6c] Sender membership sync"
community "$alice_state" matrix sync \
  --homeserver "$alice_homeserver" \
  --store-passphrase-file "$alice_store_password" >/dev/null

echo "[7/10] Sending a unique encrypted message"
marker="mfw-live-e2ee-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 8)"
event_id="$(community "$alice_state" matrix send "$room_id" --body "$marker" \
  --homeserver "$alice_homeserver" \
  --store-passphrase-file "$alice_store_password" | jq -er '.eventId')"
[[ "$event_id" == \$* ]]

echo "[8/10] Syncing the recipient and verifying decrypted message content"
echo "  [8a] Recipient message sync"
community "$bob_state" matrix sync \
  --homeserver "$bob_homeserver" \
  --store-passphrase-file "$bob_store_password" >/dev/null
echo "  [8b] Decrypted message page"
messages="$(community "$bob_state" matrix messages "$room_id" --limit 20 \
  --homeserver "$bob_homeserver" \
  --store-passphrase-file "$bob_store_password")"
jq -e --arg marker "$marker" \
  '.messages | any(.body == $marker and .sentByMe == false)' <<<"$messages" >/dev/null

echo "[9/10] Enabling and checking encrypted key recovery"
community "$alice_state" matrix enable-recovery \
  --recovery-output "$alice_recovery" \
  --homeserver "$alice_homeserver" \
  --store-passphrase-file "$alice_store_password" >/dev/null
[[ -s "$alice_recovery" ]]
[[ "$(stat -f '%Lp' "$alice_recovery" 2>/dev/null || stat -c '%a' "$alice_recovery")" == 600 ]]
community "$alice_state" matrix recovery-status \
  --homeserver "$alice_homeserver" \
  --store-passphrase-file "$alice_store_password" >/dev/null

echo "[10/10] Logging out and deleting both identities"
community "$alice_state" matrix logout \
  --homeserver "$alice_homeserver" \
  --store-passphrase-file "$alice_store_password" >/dev/null
community "$bob_state" matrix logout \
  --homeserver "$bob_homeserver" \
  --store-passphrase-file "$bob_store_password" >/dev/null
community "$alice_state" identity delete \
  --confirm "DELETE MY COMMUNITY PROFILE" >/dev/null
alice_created=false
community "$bob_state" identity delete \
  --confirm "DELETE MY COMMUNITY PROFILE" >/dev/null
bob_created=false

echo "Live Community Matrix E2EE acceptance passed; disposable identities were deleted."
