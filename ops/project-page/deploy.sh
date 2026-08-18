#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0 /path/to/staging" >&2
  exit 1
fi

SOURCE_DIR="${1:-}"
if [[ -z "$SOURCE_DIR" || ! -f "$SOURCE_DIR/website/dist/index.html" || ! -f "$SOURCE_DIR/ops/project-page/install-download-gateway.sh" ]]; then
  echo "Usage: sudo $0 /path/to/repository-staging" >&2
  exit 1
fi

for command in curl docker install nginx sha256sum systemctl tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing command: $command" >&2; exit 1; }
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_root="/var/www/monero-fast-wallet-releases"
release_dir="$release_root/$timestamp"
current_link="/var/www/monero-fast-wallet.current"
mirror_root="/var/www/monero-fast-wallet-mirror"
mirror_release_root="$mirror_root/releases"
snippet_path="/etc/nginx/snippets/mfw-project-page.conf"
static_site_path="/etc/nginx/snippets/mfw-static-site.conf"
download_snippet_path="/etc/nginx/snippets/mfw-download-gateway.conf"
rate_path="/etc/nginx/conf.d/mfw-project-page-rate-limit.conf"
legacy_rate_path="/etc/nginx/conf.d/notify-scanner-rate-limit.conf"
backup_root="/root/monero-fast-wallet-page-backups/$timestamp"
previous_target="$(readlink "$current_link" 2>/dev/null || true)"

mkdir -p "$backup_root" "$release_root" "$mirror_release_root"
[[ -f "$snippet_path" ]] && cp -a "$snippet_path" "$backup_root/mfw-project-page.conf"
[[ -f "$static_site_path" ]] && cp -a "$static_site_path" "$backup_root/mfw-static-site.conf"
[[ -f "$download_snippet_path" ]] && cp -a "$download_snippet_path" "$backup_root/mfw-download-gateway.conf"
[[ -f "$rate_path" ]] && cp -a "$rate_path" "$backup_root/mfw-project-page-rate-limit.conf"
[[ -f "$legacy_rate_path" ]] && cp -a "$legacy_rate_path" "$backup_root/legacy-notify-scanner-rate-limit.conf"

install -d -o root -g root -m 0755 "$release_dir"
cp -a "$SOURCE_DIR/website/dist/." "$release_dir/"
chown -R root:root "$release_dir"
find "$release_dir" -type d -exec chmod 0755 {} +
find "$release_dir" -type f -exec chmod 0644 {} +

bash "$SOURCE_DIR/ops/project-page/install-download-gateway.sh" "$SOURCE_DIR"
install -o root -g root -m 0755 "$SOURCE_DIR/ops/project-page/publish-download.sh" /usr/local/sbin/mfw-download-publish
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
  if [[ -f "$backup_root/mfw-project-page.conf" ]]; then
    cp -a "$backup_root/mfw-project-page.conf" "$snippet_path"
  fi
  if [[ -f "$backup_root/mfw-static-site.conf" ]]; then
    cp -a "$backup_root/mfw-static-site.conf" "$static_site_path"
  else
    rm -f "$static_site_path"
  fi
  if [[ -f "$backup_root/mfw-download-gateway.conf" ]]; then
    cp -a "$backup_root/mfw-download-gateway.conf" "$download_snippet_path"
  else
    rm -f "$download_snippet_path"
  fi
  if [[ -f "$backup_root/mfw-project-page-rate-limit.conf" ]]; then
    cp -a "$backup_root/mfw-project-page-rate-limit.conf" "$rate_path"
  else
    rm -f "$rate_path"
  fi
  if [[ -f "$backup_root/legacy-notify-scanner-rate-limit.conf" ]]; then
    cp -a "$backup_root/legacy-notify-scanner-rate-limit.conf" "$legacy_rate_path"
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
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/developers/ -o "$validation_dir/developers.html" || { rollback; exit 1; }
grep -q 'MFW Registry Developer API' "$validation_dir/developers.html" || { rollback; exit 1; }
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/de/developers/ -o "$validation_dir/de-developers.html" || { rollback; exit 1; }
grep -q 'MFW Registry Entwickler-API' "$validation_dir/de-developers.html" || { rollback; exit 1; }
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/privacy/ -o "$validation_dir/privacy.html" || { rollback; exit 1; }
grep -q 'Privacy – Monero Fast Wallet' "$validation_dir/privacy.html" || { rollback; exit 1; }
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/de/datenschutz/ -o "$validation_dir/datenschutz.html" || { rollback; exit 1; }
grep -q 'Datenschutz – Monero Fast Wallet' "$validation_dir/datenschutz.html" || { rollback; exit 1; }
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
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/mfw-registration-tracking.json -o "$validation_dir/mfw-registration-tracking.json" || { rollback; exit 1; }
grep -q '"canonicalName": "tex8.mfw"' "$validation_dir/mfw-registration-tracking.json" || { rollback; exit 1; }
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/healthz >/dev/null || { rollback; exit 1; }
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/v1/mfw-site/healthz >/dev/null || { rollback; exit 1; }
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/v1/mfw-site/releases -o "$validation_dir/releases.json" || { rollback; exit 1; }
grep -q '"schema":1' "$validation_dir/releases.json" || { rollback; exit 1; }
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/v1/mfw/names/tex8.mfw -o "$validation_dir/tex8-mfw.json" || { rollback; exit 1; }
grep -q '"canonicalName":"tex8.mfw"' "$validation_dir/tex8-mfw.json" || { rollback; exit 1; }
curl -fsS --resolve xmr.tex8.com:443:127.0.0.1 https://xmr.tex8.com/v1/mfw/name-suggestions/tex -o "$validation_dir/tex-mfw-suggestions.json" || { rollback; exit 1; }
grep -q '"names":\["tex8.mfw"\]' "$validation_dir/tex-mfw-suggestions.json" || { rollback; exit 1; }

# Publish only the already validated static release. The hash-named archive is
# immutable and the manifest is switched last, so mirrors never see a partial
# deployment.
mirror_archive_temp="$(mktemp "$mirror_root/.release.XXXXXX.tar.gz")"
tar -C "$release_dir" -czf "$mirror_archive_temp" .
mirror_sha256="$(sha256sum "$mirror_archive_temp" | awk '{print $1}')"
[[ "$mirror_sha256" =~ ^[0-9a-f]{64}$ ]] || { rm -f "$mirror_archive_temp"; rollback; exit 1; }
mirror_archive="$mirror_release_root/$mirror_sha256.tar.gz"
if [[ -f "$mirror_archive" ]]; then
  existing_sha256="$(sha256sum "$mirror_archive" | awk '{print $1}')"
  [[ "$existing_sha256" == "$mirror_sha256" ]] || { rm -f "$mirror_archive_temp"; rollback; exit 1; }
  rm -f "$mirror_archive_temp"
else
  install -o root -g root -m 0644 "$mirror_archive_temp" "${mirror_archive}.next"
  mv -Tf "${mirror_archive}.next" "$mirror_archive"
  rm -f "$mirror_archive_temp"
fi

mirror_manifest_temp="$(mktemp "$mirror_root/.current.XXXXXX")"
printf 'version=%s\nsha256=%s\n' "$timestamp" "$mirror_sha256" >"$mirror_manifest_temp"
install -o root -g root -m 0644 "$mirror_manifest_temp" "${mirror_root}/current.next"
mv -Tf "${mirror_root}/current.next" "${mirror_root}/current"
rm -f "$mirror_manifest_temp"

echo "Monero Fast Wallet project page deployed. Release: $release_dir"
echo "Backup: $backup_root"
echo "Mirror archive: $mirror_archive"
