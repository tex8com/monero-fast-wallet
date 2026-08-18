#!/usr/bin/env bash
# Opens as one visible, interactive Mac Terminal operation. The only manual
# input is the remote server's sudo password when the server asks for it.
set -euo pipefail
cd "$(dirname "$0")/.."
NOTIFICATION_GATEWAY_PROBE_INSTALLATION_ID=mwp_linux_e2e_20260719_a1b2c3d4 \
WNS_SECRETS_FILE=secrets/wns-server.env \
bash backend/notification-gateway/deploy/deploy-live-from-macos.sh
printf '\nDeployment finished. You may close this window.\n'
