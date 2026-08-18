# Monero Fast Wallet CLI

The internal `monero-fast-wallet-community` companion exposes the Community V1
automation surface as JSON commands. Product builds package it beside
`monero-fast-wallet-cli`; the user-facing entry point is:

```sh
monero-fast-wallet-cli community --state-dir /private/path identity create
```

The Monero process resolves the companion only beside its own executable. It
never searches `PATH`. The standalone binary is useful for development:

```sh
cargo run --locked --manifest-path wallets/cli/Cargo.toml -- \
  --state-dir /private/path identity create
```

## Three quick testbenches

The complete CLI check is intentionally split into three scripts under
`wallets/cli/testbench/`:

| Script | Scope | Safety boundary |
| --- | --- | --- |
| `01-ledger-nano-readonly.sh` | Connected Ledger Nano and a dedicated test wallet | Read-only: status, balance and history; it cannot send or relay. |
| `02-spend-regtest.sh` | Full wallet payment and history parity | Starts a private offline Regtest chain; no public network or real funds. |
| `03-system-smoke.sh` | Product CLI, Fast Wallet lifecycle and Worker safety paths | Local-only; no node calls and no funds. |

Run the local smoke test after each new CLI build:

```sh
./wallets/cli/testbench/03-system-smoke.sh /path/to/monero-fast-wallet-cli
```

The Ledger script requires an unlocked Nano, a dedicated test wallet and the
explicit `MFW_LEDGER_NANO_CONFIRM=YES` guard. The Regtest script requires the
CLI pair directory plus a local `monerod` binary.

## Command groups

- `identity`: create, inspect and permanently delete the pseudonymous account.
- `profile`, `post`, `listing`: the roadmap-facing create/show/update/republish/
  withdraw commands. `content` also exposes the shared list, report, outcome
  and appeal lifecycle for all three typed JSON drafts.
- `contacts`: request, list, accept, decline, resolve, block and report an exact
  selected chat message.
- `notifications`: register, list and remove opaque APNs/FCM installations.
- `catalog`: install a signed immutable catalog, inspect its active generation
  and search it locally with a 640-dimensional Harrier query embedding.
- `query`: submit the optional privacy-filtered common-query contribution.
- `matrix`: provision, log in, sync, open/join a direct room, send/read encrypted
  messages, manage recovery and log out through `community-matrix-core`.
- `admin`: issue an explicitly loopback-only internal acceptance-test request.

Every successful command prints one JSON value to stdout. Failures print a JSON
object to stderr and return a non-zero exit status.

### Listing and local-search example

```sh
state="$(mktemp -d)"
chmod 700 "$state"

monero-fast-wallet-cli community --state-dir "$state" identity create
monero-fast-wallet-cli community --state-dir "$state" \
  listing create --file listing.json
monero-fast-wallet-cli community --state-dir "$state" listing list
monero-fast-wallet-cli community --state-dir "$state" \
  catalog install \
  --scope products-v1 \
  --verifying-key-hex "$CATALOG_VERIFYING_KEY_HEX" \
  --manifest catalog-manifest.json \
  --payload catalog.json
monero-fast-wallet-cli community --state-dir "$state" \
  catalog search \
  --scope products-v1 \
  --verifying-key-hex "$CATALOG_VERIFYING_KEY_HEX" \
  --embedding-file query-vector.json
```

Catalog search is local. The query vector and ranking inputs are not submitted
to the Community service.

## Credential and network boundaries

- Public origins require HTTPS. Plain HTTP requires
  `--allow-loopback-http` and is accepted only for loopback tests.
- Redirects are disabled and request/response sizes and timeouts are bounded.
- On Unix, state directories are mode `0700`; account, token, Matrix-session,
  store-passphrase and recovery files must be regular non-symlink files with
  mode `0600`.
- Internal administration accepts only a loopback origin and an explicit
  private bearer-token file.
- The CLI stores its pseudonymous API credential in this protected filesystem
  state so disposable CI identities can be automated. Mobile and Desktop keep
  the corresponding production credentials in their native secure stores.

## Full testbench

Run the complete local acceptance flow:

```sh
cargo test --locked --manifest-path wallets/cli/Cargo.toml \
  --test full_testbench -- --nocapture
```

It starts the real in-process Enthusiast V1 HTTP router and real SQLite-backed
domain stores, executes the compiled CLI as subprocesses, and covers:

1. three independent pseudonymous identities and fail-closed deletion;
2. profile, post, service-listing and product-listing create/read/revise/
   withdraw contracts plus service-listing screening, moderation and publish;
3. signed catalog install, signature rejection and local semantic search;
4. APNs and FCM notification registration/list/removal (registration only);
5. contact request, decline, accept, resolution and block;
6. exact-message report, account suspension, outcome, appeal and reversal;
7. public-content report, hide, owner outcome, appeal and reinstatement;
8. the three-independent-identity common-query threshold and signed-catalog
   delta input;
9. withdrawal, identity deletion and Matrix-account lifecycle cleanup.

To prove the packaged Monero dispatch as well, point the same suite at the real
product executable:

```sh
MFW_COMMUNITY_CLI_LAUNCHER=/path/to/monero-fast-wallet-cli \
cargo test --locked --manifest-path wallets/cli/Cargo.toml \
  --test full_testbench -- --nocapture
```

The deterministic suite uses a recording Matrix provisioning/lifecycle service
so CI requires no private Synapse administrator token. It does **not** claim a
live two-client Matrix E2EE, APNs, FCM or physical notification acceptance.
Those remain separate, explicit live/device gates.

### Explicit live Matrix gate

The separate live runner creates two disposable identities, provisions two
Matrix accounts, opens and explicitly joins an encrypted direct room, verifies
a decrypted message and recovery setup, then logs out and deletes both
identities. It refuses to run without an exact mutation gate:

```sh
cargo build --locked --release --manifest-path wallets/cli/Cargo.toml
MFW_LIVE_COMMUNITY_MATRIX_TEST=RUN_DISPOSABLE_COMMUNITY_MATRIX_E2E \
MFW_COMMUNITY_CLI_BIN="$PWD/wallets/cli/target/release/monero-fast-wallet-community" \
./wallets/cli/test-live-matrix.sh
```

GitHub Actions exposes the same gate only as the manually selected
`run_live_community_matrix` workflow-dispatch input. Normal pushes and pull
requests remain deterministic and do not mutate the live service. The script
uses an exit trap for cleanup and never prints passwords, Matrix sessions or
Community API access tokens.
