#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0 /path/to/staging" >&2
  exit 1
fi

SOURCE_DIR="${1:-}"
if [[ -z "$SOURCE_DIR" || ! -f "$SOURCE_DIR/website/dist/index.html" ]]; then
  echo "Usage: sudo $0 /path/to/repository-staging" >&2
  exit 1
fi

for command in curl docker install nginx systemctl; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing command: $command" >&2; exit 1; }
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_root="/var/www/monero-fast-wallet-releases"
release_dir="$release_root/$timestamp"
current_link="/var/www/monero-fast-wallet.current"
snippet_path="/etc/nginx/snippets/notify-scanner-tex8-location.conf"
rate_path="/etc/nginx/conf.d/notify-scanner-rate-limit.conf"
legacy_rate_path="/etc/nginx/conf.d/mfw-project-page-rate-limit.conf"
backup_root="/root/monero-fast-wallet-page-backups/$timestamp"
previous_target="$(readlink "$current_link" 2>/dev/null || true)"

mkdir -p "$backup_root" "$release_root"
[[ -f "$snippet_path" ]] && cp -a "$snippet_path" "$backup_root/notify-scanner-tex8-location.conf"
[[ -f "$rate_path" ]] && cp -a "$rate_path" "$backup_root/mfw-project-page-rate-limit.conf"
[[ -f "$legacy_rate_path" ]] && cp -a "$legacy_rate_path" "$backup_root/legacy-mfw-project-page-rate-limit.conf"

install -d -o root -g root -m 0755 "$release_dir"
cp -a "$SOURCE_DIR/website/dist/." "$release_dir/"
chown -R root:root "$release_dir"
find "$release_dir" -type d -exec chmod 0755 {} +
find "$release_dir" -type f -exec chmod 0644 {} +

install -o root -g root -m 0644 "$SOURCE_DIR/ops/project-page/nginx-location.conf" "$snippet_path"
install -o root -g root -m 0644 "$SOURCE_DIR/ops/project-page/nginx-rate-limit.conf" "$rate_path"
rm -f "$legacy_rate_path"

admin_token="$(docker inspect tex8_platform_service --format '{{range .Config.Env}}{{println .}}{{end}}' | awk -F= '$1 == "ADMIN_API_TOKEN" {sub(/^[^=]*=/, ""); print; exit}')"
if [[ -z "$admin_token" ]]; then
  echo "Platform admin token is unavailable." >&2
  exit 1
fi

curl -fsS \
  -H "X-Admin-Token: $admin_token" \
  -H 'Content-Type: application/json' \
  --data-binary "@$SOURCE_DIR/ops/project-page/platform-config.json" \
  http://127.0.0.1:4010/api/v1/admin/platform-config >/dev/null

knowledge_b64="$(base64 <"$SOURCE_DIR/ops/project-page/assistant-knowledge.txt" | tr -d '\n')"
prompt_b64="$(base64 <"$SOURCE_DIR/ops/project-page/assistant-system-prompt.txt" | tr -d '\n')"
docker exec \
  -e MFW_KNOWLEDGE_B64="$knowledge_b64" \
  -e MFW_PROMPT_B64="$prompt_b64" \
  tex8_mongodb sh -lc '
    mongosh --quiet \
      --username "$MONGO_INITDB_ROOT_USERNAME" \
      --password "$MONGO_INITDB_ROOT_PASSWORD" \
      --authenticationDatabase admin \
      tex8_auth \
      --eval '\''
        const updatedAt = NumberLong(Math.floor(Date.now() / 1000));
        const knowledge = Buffer.from(process.env.MFW_KNOWLEDGE_B64, "base64").toString("utf8");
        const systemPrompt = Buffer.from(process.env.MFW_PROMPT_B64, "base64").toString("utf8");
        db.shop_knowledge.updateOne(
          {_id: "monero-fast-wallet"},
          {$set: {knowledge, updated_at: updatedAt}},
          {upsert: true}
        );
        db.shop_system_prompts.updateOne(
          {_id: "monero-fast-wallet"},
          {$set: {system_prompt: systemPrompt, updated_at: updatedAt}},
          {upsert: true}
        );
      '\'' >/dev/null
  '

ln -sfn "$release_dir" "${current_link}.next"
mv -Tf "${current_link}.next" "$current_link"

rollback() {
  echo "Project page validation failed; restoring Nginx configuration." >&2
  if [[ -f "$backup_root/notify-scanner-tex8-location.conf" ]]; then
    cp -a "$backup_root/notify-scanner-tex8-location.conf" "$snippet_path"
  fi
  if [[ -f "$backup_root/mfw-project-page-rate-limit.conf" ]]; then
    cp -a "$backup_root/mfw-project-page-rate-limit.conf" "$rate_path"
  else
    rm -f "$rate_path"
  fi
  if [[ -f "$backup_root/legacy-mfw-project-page-rate-limit.conf" ]]; then
    cp -a "$backup_root/legacy-mfw-project-page-rate-limit.conf" "$legacy_rate_path"
  else
    rm -f "$legacy_rate_path"
  fi
  if [[ -n "$previous_target" ]]; then
    ln -sfn "$previous_target" "${current_link}.next"
    mv -Tf "${current_link}.next" "$current_link"
  else
    rm -f "$current_link"
  fi
  nginx -t && systemctl reload nginx || true
}

if ! nginx -t; then
  rollback
  exit 1
fi
systemctl reload nginx
sleep 1

validation_dir="$(mktemp -d)"
trap 'rm -rf "$validation_dir"' EXIT
if ! curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/ -o "$validation_dir/root.html" || ! grep -q 'id="root"' "$validation_dir/root.html"; then
  rollback
  exit 1
fi
grep -q 'lang="en"' "$validation_dir/root.html" || { rollback; exit 1; }
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/de/ -o "$validation_dir/de.html" || { rollback; exit 1; }
grep -q 'lang="de-DE" dir="ltr"' "$validation_dir/de.html" || { rollback; exit 1; }
for locale_contract in \
  'es:es-ES:ltr' 'pt-br:pt-BR:ltr' 'ru:ru-RU:ltr' 'vi:vi-VN:ltr' \
  'id:id-ID:ltr' 'uk:uk-UA:ltr' 'tr:tr-TR:ltr' 'hi:hi-IN:ltr' \
  'ur:ur-PK:rtl' 'fr:fr-FR:ltr' 'fil:fil-PH:ltr' 'ja:ja-JP:ltr' \
  'ko:ko-KR:ltr' 'ar:ar:rtl' 'zh-cn:zh-CN:ltr' 'zh-tw:zh-TW:ltr'; do
  IFS=: read -r route language direction <<<"$locale_contract"
  curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 "https://xmr.tex8.com/$route/" -o "$validation_dir/$route.html" || { rollback; exit 1; }
  grep -q "lang=\"$language\" dir=\"$direction\"" "$validation_dir/$route.html" || { rollback; exit 1; }
done
legacy_english_redirect="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/en/)"
[[ "$legacy_english_redirect" == "301 https://xmr.tex8.com/" ]] || { rollback; exit 1; }
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/monero-wallet-logo.svg -o "$validation_dir/monero-wallet-logo.svg" || { rollback; exit 1; }
grep -q '<svg' "$validation_dir/monero-wallet-logo.svg" || { rollback; exit 1; }
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/healthz >/dev/null || { rollback; exit 1; }

echo "Monero Fast Wallet project page deployed. Release: $release_dir"
echo "Backup: $backup_root"
