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
remote: https://github.com/tex8com/monero.git
commit: e7fe4ff6f0a0fef58ca031d2a75c168a42242b42
```

This is the current clean release pin for the forked wallet core. It contains
the mobile-facing `libwallet_api` gRPC endpoint methods and the wallet-core
changes used by the native bridge.

Current RandomX submodule pin used by that Monero commit:

```text
remote: https://github.com/tex8com/RandomX.git
branch: tex8/mobile-jit-toggle
commit: ba354fde486d721502aeebf265b6005342b08128
```

The product repo currently records the fork pin here instead of vendoring the
full source tree. To materialize the pinned checkout locally:

```sh
git clone https://github.com/tex8com/monero.git third_party/monero
cd third_party/monero
git checkout e7fe4ff6f0a0fef58ca031d2a75c168a42242b42
git submodule sync --recursive
git submodule update --init --recursive
```

If this directory is converted to a Git submodule later, keep the submodule
checked out at the same commit before treating a build as reproducible.
