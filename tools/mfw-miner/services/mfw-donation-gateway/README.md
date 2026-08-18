# MFW Donation Gateway

`mfw-donation-gateway` is the stable Stratum endpoint for the disclosed MFW
donation window. It is a gateway, not a miner. The user-selected pool or daemon
is untouched for the remaining mining time.

```text
MFW-Miner donation window
            |
            v
   MFW Donation Gateway
       |       |      |
      pool   P2Pool  solo coordinator
```

The gateway rewrites every supported Stratum authentication message to the
configured public Monero address. It also removes a client-supplied `url`, so it
cannot become an open redirect to arbitrary mining endpoints. Pool, P2Pool and
solo backends are selected server-side; changing the active backend closes
existing donation connections so miners reconnect to the new selection.

## Current scope

- TCP and certificate-verified TLS Stratum upstreams.
- XMRig `login` and standard `mining.authorize` credential rewriting.
- Primary backend plus explicit failover order.
- Loopback-only administrative API with bearer-token protection for writes.
- Strict Monero mainnet address and checksum validation.
- Bounded JSON lines and no source-IP or wallet logging.
- Local integration tests; the example configuration contacts no public pool.

The `solo` backend type currently means a Stratum-compatible solo coordinator.
A raw `monerod` exposes JSON-RPC, not Stratum. Implementing the coordinator that
allocates unique work and translates `get_block_template`/`submit_block` is a
separate component and remains required before MFW can select direct solo mode.

P2Pool also fixes its payout wallet on the P2Pool node; it ignores the wallet
sent by an attached miner. Therefore an MFW P2Pool backend must itself be
started with the same validated donation address. The gateway address rewrite
is authoritative for ordinary pools, while P2Pool and solo deployments require
an additional startup/status consistency check.

## Build and test

```sh
cargo test --manifest-path services/mfw-donation-gateway/Cargo.toml
cargo clippy --manifest-path services/mfw-donation-gateway/Cargo.toml --all-targets -- -D warnings
cargo run --manifest-path services/mfw-donation-gateway/Cargo.toml -- \
  --config services/mfw-donation-gateway/gateway.example.toml --check
```

## Backend switching

Enable the admin listener, place a strong random token in
`MFW_GATEWAY_ADMIN_TOKEN`, and keep the listener on loopback. Then:

```sh
curl -X POST \
  -H "Authorization: Bearer ${MFW_GATEWAY_ADMIN_TOKEN}" \
  http://127.0.0.1:18088/v1/backend/mfw-solo
```

The API changes in-memory routing only. Deployment configuration remains the
source of truth after restart.

## Safety and deployment gates

- Obtain explicit approval before directing a fleet at a third-party pool.
- Terminate public client TLS in front of this service; built-in TLS is for
  certificate-verified upstream connections.
- Run at least two regional gateway instances and use health-checked DNS.
- MFW-Miner must fail open: an unavailable donation gateway immediately returns
  work to the user's configured pool or daemon.
- Never store a Monero seed, private spend key or private view key here.
