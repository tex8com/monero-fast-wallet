# WAN Transport Protocol Benchmark

This is a standalone transport benchmark for the selected wallet transport:
gRPC over HTTP/2 over TLS/TCP. HTTP/3 over QUIC remains available only for an
explicit experiment; it is not a product dependency because UDP connectivity
and performance vary across networks. The benchmark does not access a wallet,
private key, blockchain database, or Cuprate RPC. Its job is to establish the
usable WAN transport ceiling before the same measurement is repeated with real
`getblocks.bin` chunks from a dedicated Cuprate instance.

Every stream sends the same deterministic 64 KiB application frames. Download
frames are sequence- and content-verified at the client. For upload, the server
returns the exact received byte/frame/error counters and the client rejects the
sample unless they exactly match its sent counters. Local send buffering can
therefore never be reported as a successful upload.

The WAN profile is deliberately matched on both sides:

| Setting | gRPC/HTTP2 |
| --- | ---: |
| Logical streams per physical connection | 1, 4, 16 |
| Physical connections | 1, 2, 4, 8, 16 |
| Initial per-stream receive credit | 4 MiB |
| Connection receive credit | 32 MiB |
| TCP socket buffer hint | 16 MiB |
| Trial duration / repetitions | 20 s / 3 |

At 178 ms RTT, 500–700 Mbit/s requires roughly 11–16 MiB of bandwidth-delay
product. The values above are intentionally above that range without allowing
unbounded application queues. They are **benchmark settings**, not proposed
phone defaults.

Run the public, three-sample gRPC matrix (15 connection/stream cells per
direction, 1–256 active streams):

```bash
cd tools/transport-protocol-bench
TRANSPORT_BENCH_DURATION=20s TRANSPORT_BENCH_REPETITIONS=3 ./run-public-matrix.sh
```

The actual wallet benchmark, including local block scan and cache commit,
remains `tools/wallet-testbench/run-sync-benchmark.sh`. No pool setting is
selected until that real-payload run confirms the same benefit.
