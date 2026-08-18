# Monero Fast Wallet project page deployment

The project page is built and tested on Server 1. Server 2 pulls a hash-verified,
immutable page archive and activates it only after verification. No GitHub
Actions or CI deployment is used.

## Privacy-minimised statistics

`download_gateway.py` stores only daily aggregate counters and HyperLogLog
registers. It never stores an IP address, user agent, referrer, URL query, or
per-visitor hash. Raw IP and a coarse browser class exist only while the request
is processed. Static page and download locations disable Nginx access logging.

The two local databases remain separate. `download-metrics-report.sh` reads
only aggregate rows over SSH, merges counters, and unions the anonymous HLL
registers. Country is `ZZ` when no local GeoLite2 database is installed or when
the request arrives over Tor.

The public meanings are intentionally narrow:

- `page_view` is one non-bot browser page load;
- `download_start` is one accepted gateway request, not proof of a completed
  download or installation;
- `unique_estimates` are approximate daily counts, not user records.

## Publishing a release artifact

Publishing is manual and fail-closed. First publish the signed artifact and its
checksum as an immutable GitHub Release when a public mirror is wanted. Then,
on Server 1, run:

```text
sudo mfw-download-publish ARTIFACT PRODUCT PLATFORM PACKAGE VERSION GITHUB_URL
```

Use `-` instead of `GITHUB_URL` when no GitHub fallback exists. The command
computes SHA-256, installs the file under its immutable hash, and atomically
activates the manifest entry. Server 2 downloads the same file, checks byte
length and SHA-256, and only then activates its local manifest. Until an entry
is enabled, the website keeps that download visibly unreleased.
