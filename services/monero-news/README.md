# Monero news service

`monero-news` fetches and caches the public [official Monero blog](https://www.getmonero.org/blog/), then exposes a deliberately small client contract:

- `GET /healthz`
- `GET /v1/news?limit=18&category=network|wallet|ecosystem`

The mobile wallet consumes only the TEX8 endpoint (`https://xmr.tex8.com/news/v1/news`), caches valid responses locally, and never fetches GitHub or scrapes sources itself.

The service has no wallet, account, identifier, address, or notification data.
