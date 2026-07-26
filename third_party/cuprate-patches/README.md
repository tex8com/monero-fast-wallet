# Cuprate production fork patch series

This directory preserves the complete custom Cuprate production history used
by the wallet project without replacing the separately updateable
`tex8com/cuprate` fork.

```text
upstream remote: https://github.com/tex8com/cuprate.git
upstream base:   3147170485c82baec4b5a5f10bdac67316c5923d
production head: cd1ec57ab44301b93a21e9b504b9d913b88fc871
branch:          agent/wallet-scan-range-1b-production
patches:         41
```

The series includes wallet-compatible RPC, gRPC block streaming, range reads,
the persistent scan-pack cache and the final production scan-pack node. Apply
the numbered patches in lexical order to the recorded upstream base.

The product snapshot under `node/cuprate` may contain additional integration
work. Do not overwrite that snapshot blindly with this series; reconcile it
through Git and validate the combined node.
