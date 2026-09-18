# WireGuard Cuprate Sync Benchmark Node

This deploys a separate, user-owned **Stagenet** node for wallet-sync
experiments. It is deliberately isolated from production:

- restricted RPC and gRPC on a deployer-supplied WireGuard address, on
  dedicated ports `48089` and `48091`
- independent binary, source checkout, logs and data under
  `/srv/mfw-cuprate-sync-benchmark`
- no changes to `/opt/cuprate`, `/etc/cuprate`, systemd, firewall or the
  production chain database
- gRPC hard caps: 16 MiB message/chunk/window, 512 blocks, four queued chunks

Deploy from the product repository:

```sh
ops/cuprate-sync-benchmark/deploy-vpn-test-node.sh
```

Set the host-specific bind address before deployment. The committed TOML binds
only to loopback; use a private local config for WireGuard access:

```sh
export CUPRATE_BENCHMARK_BIND_ADDRESS=<wireguard-node-ip>
curl -fsS http://<wireguard-node-ip>:48089/get_info
```

After it has caught up, configure the native testbench profile C:

```sh
export TESTBENCH_SYNC_RPC_C=<wireguard-node-ip>:48089
export TESTBENCH_SYNC_GRPC_C=<wireguard-node-ip>:48091
```

Monitor without modifying the node:

```sh
ssh <benchmark-host> 'tail -f /srv/mfw-cuprate-sync-benchmark/logs/cuprated.stdout.log'
ssh <benchmark-host> 'curl -fsS http://127.0.0.1:48089/get_info'
```

Stop and remove only this test node:

```sh
ssh <benchmark-host> 'kill "$(cat /srv/mfw-cuprate-sync-benchmark/cuprated.pid)"'
```
