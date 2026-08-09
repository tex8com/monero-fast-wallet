#!/usr/bin/env bash
set -euo pipefail

# Provision only deployment-local Firebase credentials.  This script never
# prints the service-account JSON or the FCM bearer token, and it deliberately
# keeps both outside the repository and staged release material.

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'Run this provisioning script with sudo.' >&2
  exit 1
fi

source_file="${1:-/srv/monero-fast-wallet/tex8-runtime-secrets/monero-wallet/firebase-service-account.json}"
target_dir='/etc/monero-fast-wallet'
target_file="$target_dir/firebase-service-account.json"
provider_env="$target_dir/notification-gateway-provider.env"
service_group='monero-notification-gateway'

[[ -f "$source_file" && ! -L "$source_file" ]] || {
  echo 'Firebase service-account source is missing or unsafe.' >&2
  exit 1
}
getent group "$service_group" >/dev/null || {
  echo 'The notification-gateway service group is missing.' >&2
  exit 1
}

install -d -o root -g "$service_group" -m 0750 "$target_dir"
# The gateway rejects group-readable credential files.  The service account is
# therefore readable only by the unprivileged gateway account; root retains
# access independently.  Keep the non-secret environment file group-readable
# so systemd can load it as the service user.
install -o "$service_group" -g "$service_group" -m 0600 "$source_file" "$target_file"

temporary="$(mktemp "$target_dir/.notification-gateway-provider.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
printf '%s\n' \
  'NOTIFICATION_GATEWAY_FCM_PROJECT_ID=monero-d3f05' \
  "NOTIFICATION_GATEWAY_FCM_SERVICE_ACCOUNT_FILE=$target_file" \
  > "$temporary"
install -o root -g "$service_group" -m 0640 "$temporary" "$provider_env"
rm -f "$temporary"
trap - EXIT

systemctl restart notification-gateway.service
systemctl is-active --quiet notification-gateway.service
echo 'Firebase push provider provisioned for notification-gateway.'
