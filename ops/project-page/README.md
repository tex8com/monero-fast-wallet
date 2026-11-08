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
length and SHA-256, and only then activates its local manifest. The website uses
the gateway only when its pinned version, hash, size, and package match the
catalog. A complete release in `website/src/content.js` enables the GitHub
fallback even without a catalog entry, so publish the GitHub artifact first.

## Linux ARM64 1.0.116 preparation

The prepared release is `v1.0.116-linux-arm64-alpha.1`, with
`Monero-Fast-Wallet-1.0.116-linux-arm64.AppImage`, tested on Ubuntu 24.04 ARM64.
The native DEB contains the same verified application and is also ARM64-only.
No x86_64 or RPM package is approved. The website and release tests pin the
final AppImage from source `aa0c982c8785cbd903a0b143dd754d05591e839a`:

- SHA-256: `ca8b1aa2ec13c09ba95b2b5d8c039467d1326d62d8e27b075b1362198242bd5e`
- Size: `407452168` bytes

Native DEB (`Monero-Fast-Wallet-1.0.116-linux-arm64.deb`):

- SHA-256: `87e91340ba0debfb365061bf3100fa150648d1d48a1951f311dc0a6fa49cdfb0`
- Size: `341026476` bytes

After the final package passes the required checks and publication is approved,
publish the GitHub release with checksums and compliance files, then run on
Server 1:

```text
sudo mfw-download-publish /PATH/Monero-Fast-Wallet-1.0.116-linux-arm64.AppImage mfw linux appimage 1.0.116 https://github.com/tex8com/monero-fast-wallet/releases/download/v1.0.116-linux-arm64-alpha.1/Monero-Fast-Wallet-1.0.116-linux-arm64.AppImage
```

Verify the primary and secondary catalogs and their immutable asset hashes.
Finally atomically activate only the prepared static website and its mirror
manifest. Do not run the full installer for this download-link update.
Keep the Android, macOS, and Windows entries intact.
