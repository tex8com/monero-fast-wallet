# Third-Party Forks

This directory holds pinned source used by product builds.

## Monero Fork

Target path:

```text
third_party/monero
```

Current local source:

```text
$HOME/Documents/Projects/monero-gui/monero
```

Current observed branch/commit:

```text
branch: fast-crypto
commit: af614f45b8610bd418f21a089a598b4683d497c8
```

The local checkout currently has uncommitted wallet/gRPC work, including the
mobile-facing `libwallet_api` gRPC endpoint methods, so it is not yet a clean
release pin. Commit those fork changes first, then import or submodule that
exact commit under `third_party/monero`.
