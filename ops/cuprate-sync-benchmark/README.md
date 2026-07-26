# WireGuard Cuprate Sync Benchmark Node

This deploys a separate, user-owned **Stagenet** node for wallet-sync
experiments. It is deliberately isolated from production:

- restricted RPC and gRPC on the existing WireGuard address `private-node-ip`, on
  dedicated ports `48089` and `48091`
- independent binary, source checkout, logs and data under
  `/srv/monero-fast-wallet/cuprate-sync-benchmark`
- no changes to `/opt/cuprate`, `/etc/cuprate`, systemd, firewall or the
  production chain database
- gRPC hard caps: 16 MiB message/chunk/window, 512 blocks, four queued chunks

Deploy from the product repository:

```sh
ops/cuprate-sync-benchmark/deploy-vpn-test-node.sh
```

After ports `48089/tcp` and `48091/tcp` are allowed from the benchmark Mac
(`private-node-ip0`), access the node directly. Do not use an SSH proxy:

```sh
curl -fsS http://private-node-ip:48089/get_info
```

After it has caught up, configure the native testbench profile C:

```sh
export TESTBENCH_SYNC_RPC_C=private-node-ip:48089
export TESTBENCH_SYNC_GRPC_C=private-node-ip:48091
```

Monitor without modifying the node:

```sh
ssh private-ssh-host 'tail -f /srv/monero-fast-wallet/cuprate-sync-benchmark/logs/cuprated.stdout.log'
ssh private-ssh-host 'curl -fsS http://127.0.0.1:48089/get_info'
```

Stop and remove only this test node:

```sh
ssh private-ssh-host 'kill "$(cat /srv/monero-fast-wallet/cuprate-sync-benchmark/cuprated.pid)"'
```
