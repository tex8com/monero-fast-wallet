# Security Policy

## Product Status

TEX8 Monero Fast Wallet is under active development and has not been released
for production use. Only test environments and test funds are supported. No
current build is approved for Mainnet, public beta distribution, or custody of
real funds.

The public release status and high-level release gates are in
[`docs/SECURITY.md`](docs/SECURITY.md).

## Reporting A Vulnerability

Use GitHub's private vulnerability-reporting form:

<https://github.com/tex8com/monero-fast-wallet/security/advisories/new>

If private reporting is unavailable, contact a repository maintainer through an
already established private channel and ask for a private security channel. Do
not disclose an unpatched vulnerability in a public issue, discussion, pull
request, chat, or social-media post.

Include:

- the affected commit, component, platform, and environment;
- a minimal reproduction or proof of concept;
- the security impact and any known prerequisites;
- whether test or real funds, credentials, or infrastructure may be affected;
- a safe way to contact the reporter.

Never include a real seed, private spend key, private view key, wallet password,
scanner token, signing key, production credential, or unredacted wallet file.
Use synthetic canaries and test wallets only.

## Response Targets

These are response targets while the project is in development:

- acknowledge a private report within three business days;
- complete initial severity and reachability triage within seven calendar days;
- begin containment of a confirmed Critical issue within 24 hours;
- provide the reporter a status update at least every seven calendar days;
- coordinate publication only after a fix, migration guidance, and affected
  users or operators have had a reasonable opportunity to act.

If a report indicates active theft, signing-key compromise, exposed wallet
secrets, or a reversible parent/child secret relationship, use the private
reporting channel immediately and do not disclose details publicly.

## Scope

In scope:

- React Native mobile application and iOS/Android native modules;
- Tauri desktop application and Rust/C++ native bridge;
- Monero wallet-core integration and TEX8 patches;
- Fast Receive scanner, notification gateway, and service protocols;
- Cuprate integration that is changed or configured by this repository;
- build, update, signing, deployment, and dependency supply chain.

Third-party vulnerabilities that are unchanged upstream should also be
reported privately when they are reachable through TEX8. The maintainers will
coordinate with the upstream project where appropriate.

## Safe Harbor

Good-faith research is welcome when it:

- uses only test accounts, test funds, and systems the researcher owns or has
  explicit permission to test;
- avoids privacy invasion, service disruption, social engineering, persistence,
  and access to other users' data;
- stops immediately if sensitive data or spend authority is obtained;
- reports the issue privately and allows reasonable remediation time.

This policy does not authorize testing production infrastructure, other users,
or third-party services without their explicit permission.
