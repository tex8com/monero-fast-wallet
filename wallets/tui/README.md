# Monero Fast Wallet TUI

Fullscreen, mouse-capable terminal UI for `fast-wallet-cli`.

When `fast-wallet-cli` is started **without parameters** on an interactive
terminal, this TUI opens. Any other arguments, piped stdin, or `--classic`
dispatch to the authenticated C++ product binary `monero-fast-wallet-cli`.

The TUI is a thin adapter. Balance, addresses, history, refresh and spend
review stay in the Monero wallet core; this crate never implements a second
ledger.

## Start

```sh
# Interactive TTY, no arguments → TUI
./fast-wallet-cli

# Force TUI
./fast-wallet-cli --tui

# Classic readline CLI
./fast-wallet-cli --classic
./monero-fast-wallet-cli
```

Point the TUI at a product CLI when it is not a sibling of the launcher:

```sh
export MFW_PRODUCT_CLI=/path/to/monero-fast-wallet-cli
./fast-wallet-cli
```

## Tests

```sh
cargo test --locked --manifest-path wallets/tui/Cargo.toml
```

Live create/open/balance against a real product CLI (offline, no funds):

```sh
MFW_TUI_LIVE_CLI=/path/to/monero-fast-wallet-cli \
  cargo test --locked --manifest-path wallets/tui/Cargo.toml \
  --test live_product_cli -- --ignored --nocapture
```
