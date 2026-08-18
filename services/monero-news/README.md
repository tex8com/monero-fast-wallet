# Monero news service

`monero-news` is the current TEX8 public-content backend. It fetches and caches
the public [official Monero blog](https://www.getmonero.org/blog/) and
normalised XMR/USD market data, then exposes a deliberately small,
wallet-independent client contract:

- `GET /healthz`
- `GET /v1/news?limit=10&category=network|wallet|ecosystem`
- `GET /v1/market/quote`
- `GET /v1/market/chart?timeframe=24H|7D|1M|1Y|Max`
- `GET /v1/ads/catalog?country=US&placement=news|community|catalog`
- `GET /v1/ads/catalog/US/news` (mobile-safe path form)

The mobile wallet normally consumes only TEX8 endpoints:

- `https://xmr.tex8.com/news/v1/news`
- `https://xmr.tex8.com/api/v1/market/quote`
- `https://xmr.tex8.com/api/v1/market/chart`

TEX8 normalises and caches provider data so provider changes do not require a
mobile release and app usage never directly exposes third-party API
integrations. The client keeps the last valid response locally for offline
startup and shows an explicit unavailable state if neither backend nor cache is
available.

The news response is a small catalog of at most ten entries. Every entry has a
title, summary, publication date, category, optional official article URL, and
an embedded 960 × 540 JPEG `imageDataUrl`. Embedding the normalized image keeps
the clients from contacting article hosts directly. If an official title image
cannot be loaded, the server generates a deterministic Monero-coloured fallback.

The service has no wallet, account, identifier, address, or notification data.
Future public product-catalog and common query-embedding snapshots use the same
versioned public-content boundary, but remain separate resources and caches.

## Local advertising backend

The advertising module is disabled unless all four local settings are present:

```sh
TEX8_AD_DATABASE=/absolute/path/advertising.sqlite3
TEX8_AD_ADMIN_TOKEN=a-random-secret-containing-at-least-32-bytes
TEX8_AD_SIGNING_KEY_HEX=64-hexadecimal-characters
TEX8_AD_SIGNING_KEY_ID=local-key-1
```

`TEX8_AD_POLICY_VERSION` is optional and defaults to `ads-local-v1`.

The local administration contract is:

- `POST /v1/admin/ads/campaigns`
- `GET /v1/admin/ads/campaigns`
- `POST /v1/admin/ads/campaigns/{campaign_id}/approve`
- `POST /v1/admin/ads/campaigns/{campaign_id}/withdraw`

Every administration request requires
`Authorization: Bearer $TEX8_AD_ADMIN_TOKEN`. Drafts are never returned by the
public feed. Approval increments a persistent catalog generation; withdrawal
of an approved campaign increments it again. Public catalogs are signed with
Ed25519, cached for 30 seconds, limited to explicit ISO 3166-1 alpha-2
countries and contain no wallet, account, interest, click or impression
identifier.

The first implementation accepts ordinary product, service and News
sponsorship campaigns only. Crypto exchange, investment, yield and gambling
campaigns fail closed. Campaigns may run for at most 30 days, media must come
from a reviewed TEX8 HTTPS host, remote HTML/scripts are rejected, and only an
explicit country plus placement may be sent to the public feed. There are
deliberately no impression or click collection endpoints. An optional campaign
embedding must use exactly `harrier-oss-v1-270m-community-v1`, contain exactly
640 finite dimensions and be normalized; the model and vector must be present
together.

The returned public key is diagnostic metadata, not a trust root. A released
client must pin the reviewed signing key (and use an audited rotation
procedure) before accepting a catalog. The local environment-variable key
loading is suitable for this test phase only; production activation requires
separate secret handling and an Nginx block for every `/v1/admin/` route.
