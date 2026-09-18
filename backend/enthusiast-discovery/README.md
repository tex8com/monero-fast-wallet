# Monero Enthusiast Discovery

Privacy-scoped community service for the mobile wallet. It intentionally has
no wallet API and accepts no wallet address, seed, private key, balance, or
exact coordinate.

This README documents the currently implemented V1 service. The planned V2
architecture for confirmed map selection, rich profiles, local semantic
search, private on-device personalization, and Matrix E2EE lives in
[`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).
V2 is a design record, not evidence that these features are already available.

The service stores only:

- a random anonymous identity and hashed bearer token,
- a user-selected alias and short bio,
- a five-character geohash while the user is visible,
- mutual contact requests, chat messages, blocks, and reports.

Profiles expire from nearby results after 30 minutes without a presence
refresh. Chat is permitted only after the recipient accepts a contact request.
The JSON database is encrypted with XChaCha20-Poly1305. HTTPS is still required
in deployment. Messages are encrypted at rest, but this first protocol is not
end-to-end encrypted; the UI and documentation must not claim otherwise.

## Run

```bash
export ENTHUSIAST_DISCOVERY_STORAGE_KEY="$(openssl rand -hex 32)"
export ENTHUSIAST_DISCOVERY_DB=/var/lib/enthusiast-discovery/community.json.enc
export ENTHUSIAST_DISCOVERY_BIND=127.0.0.1:8089
cargo run --release
```

The public reverse proxy should map `/community/` to this service without
exposing port `8089` directly.

## Production Layout

Deployment templates live in `deploy/`:

- `enthusiast-discovery.service` runs a release binary from
  `/usr/local/bin/enthusiast-discovery` as the unprivileged
  `monero-community` account and grants write access only to its state folder.
- `nginx-community.conf` strips the `/community/` prefix while proxying to the
  loopback listener, which matches the mobile base URL
  `https://xmr.tex8.com/community`.

The root-only environment file must contain a fresh 32-byte storage key and
must never enter Git:

```text
ENTHUSIAST_DISCOVERY_STORAGE_KEY=<64 lowercase hex characters>
```

Acceptance after a commit-based deployment:

```bash
curl -fsS http://127.0.0.1:8089/healthz
curl -fsS https://xmr.tex8.com/community/healthz
```

Back up the encrypted database and current binary before replacement. Rollback
means restoring both together, then restarting the unit; restoring only one can
leave an incompatible data format or key behind.

## Test

```bash
cargo test --release
bash scripts/run-community-testbench.sh full
```

The HTTP testbench starts a fresh local service with an encrypted temporary
database and performs the complete anonymous discovery flow against the real
HTTP server. For a live acceptance run, use
`TESTBENCH_ALLOW_COMMUNITY_LIVE=1` and pass the production URL explicitly:

```bash
TESTBENCH_ALLOW_COMMUNITY_LIVE=1 \
TESTBENCH_COMMUNITY_URL=https://xmr.tex8.com/community \
bash scripts/run-community-testbench.sh live
```

The runner creates temporary `TB-...` anonymous profiles and deletes all test
identities and related records before it succeeds. It never writes bearer
tokens to the console.
