# Monero Enthusiast moderation console

Loopback-only, server-rendered moderation UI for the private
`enthusiast-v1` operations API.

Security properties:

- Argon2id password verification; the password itself is never stored;
- short in-memory sessions, `HttpOnly`/`Secure`/`SameSite=Strict` cookie and
  per-session CSRF token;
- login throttling, no third-party assets, `no-store`, no referrer and a
  restrictive Content Security Policy;
- all report, appeal and decision text remains behind the authenticated
  console and never enters a push notification;
- plaintext upstream HTTP is accepted only for loopback. A remote upstream
  must use HTTPS.

Generate a verifier without putting the password in shell history:

```bash
read -s MODERATION_PASSWORD
printf '%s' "$MODERATION_PASSWORD" | argon2 "$(openssl rand -base64 16)" -id -e -m 16 -t 3 -p 1
unset MODERATION_PASSWORD
```

Run:

```bash
export ENTHUSIAST_V1_INTERNAL_TOKEN='at-least-32-random-bytes'
export ENTHUSIAST_MODERATOR_PASSWORD_HASH='$argon2id$...'
export ENTHUSIAST_V1_INTERNAL_ORIGIN='http://127.0.0.1:8091/'
cargo run --release
```

The listener is hard restricted to loopback. Open
`http://localhost:8092/` rather than the numeric `127.0.0.1` URL. The entry
route canonicalizes numeric loopback aliases before login so browsers retain
the `__Host-` `Secure` session cookie exactly once instead of repeatedly asking
for the password. Remote administration should use an authenticated SSH
tunnel, not a public reverse proxy.
