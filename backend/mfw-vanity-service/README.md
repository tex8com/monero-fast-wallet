# MFW Vanity Service

Rust-Dienst für Website, variable Quotes, Monero-Zahlungen und die SQLite-Auftragsqueue.
Er bindet ausschließlich an `127.0.0.1:8098`; öffentlich wird nur der Tor Hidden
Service aus `torrc.example` freigegeben.

## Ablauf

1. `POST /api/v1/quotes` validiert eine normale Monero-Mainnet-Adresse und 1–100
   unterschiedliche Präfixe.
2. Der Server berechnet den unveränderlichen Preis aus der konfigurierten
   Preistabelle und erzeugt eine zufällige 8-Byte-Payment-ID.
3. `monero-wallet-rpc` erzeugt daraus eine eindeutige integrierte Zahlungsadresse.
   Der Server prüft kryptografisch, dass Adresse, Payment-ID und Zahlungsschlüssel
   wirklich zusammengehören.
4. Der View-only-Zahlungsmonitor erkennt Zahlungen. Erst wenn der volle Betrag
   entsperrt ist und die geforderte Zahl an Bestätigungen besitzt, werden die
   Suchgruppen atomar eingereiht.
5. Bis zu drei gleich lange Alternativen bilden eine Suchgruppe. Beim ersten
   Treffer werden alle Geschwister sofort aus dem aktiven GPU-Pool entfernt.
6. Fertige und abgelaufene Gruppen geben ihre Slots sofort frei; ihre Historie
   bleibt in SQLite erhalten.
7. Abgelaufene oder verspätete Zahlungen starten keinen Job automatisch.

`GET /api/v1/orders/{id}` liefert den aktuellen Status nur mit dem beim Erstellen
ausgegebenen Bearer-Token. Die UUID allein ist keine Zugriffsberechtigung.

## Sicherheitsgrenzen

- Der private Spend-Key der Service-Zahlungsadresse liegt **nicht** auf dem Worker.
- Der private View-Key wird ausschließlich aus einer Datei mit Modus `0600`
  gelesen. Er wird weder aus einer Umgebungsvariable übernommen noch in SQLite
  gespeichert.
- `monero-wallet-rpc` muss ebenfalls ausschließlich auf Loopback laufen. Der
  Dienst verweigert jede entfernte Wallet-RPC-URL.
- Die SQLite-Datei wird auf Unix automatisch auf `0600` gesetzt.
- Kunden senden nur ihre öffentliche Hauptadresse und die Präfixe. Seeds,
  private Wallet-Schlüssel und Wallet-Dateien werden nie akzeptiert.
- Der vorhandene CUDA-Prototyp erzeugt vollständige private Spend-Keys und ist
  deshalb **nicht** an diese Queue angeschlossen. Der Produktions-Runner muss
  zuerst auf Split-Key umgestellt werden: Eingabe sind öffentliche Punkte,
  Ausgabe ist ausschließlich ein Key-Offset. Erst danach darf er Jobs claimen.

## Konfiguration

Erforderlich:

```text
MFW_VANITY_PAYMENT_ADDRESS=<95-character mainnet primary address>
MFW_VANITY_PRIVATE_VIEW_KEY_FILE=/run/secrets/mfw-vanity-view-key
MFW_VANITY_WALLET_PASSWORD_FILE=/run/secrets/mfw-vanity-wallet-password
MFW_VANITY_PAYMENT_RESTORE_HEIGHT=<wallet creation height>
```

Optional:

```text
MFW_VANITY_BIND=127.0.0.1:8098
MFW_VANITY_DB_PATH=./mfw-vanity.sqlite3
MFW_VANITY_WALLET_RPC_URL=http://127.0.0.1:18083/json_rpc
MFW_VANITY_WALLET_FILENAME=mfw-vanity-payments-view-only
MFW_VANITY_QUOTE_TTL_SECONDS=1800
MFW_VANITY_REQUIRED_CONFIRMATIONS=10
MFW_VANITY_PAYMENT_POLL_SECONDS=15
MFW_VANITY_WORKER_AUTH_FILE=/run/secrets/mfw-vanity-worker-auth
MFW_VANITY_NOTIFICATION_GATEWAY_URL=http://127.0.0.1:8097
MFW_VANITY_NOTIFICATION_AUTH_FILE=/run/secrets/mfw-vanity-notification-auth
```

## Preise und Parallelrabatt

Die vollständige Präfixlänge zählt inklusive der festen `4`:

| Länge | Preis |
|---:|---:|
| 2–6 | 0,001 XMR |
| 7 | 0,002 XMR |
| 8 | 0,01 XMR |
| 9 | 0,30 XMR |
| 10 | 1 XMR |

Bis zu drei gleich lange Alternativen bilden eine Suchgruppe und kosten zusammen
den Preis einer Suche. Eine vierte gleich lange Alternative beginnt eine neue
bezahlte Gruppe. Insgesamt sind maximal 100 Präfixe pro Auftrag und 2.000 aktive
Präfix-Slots im GPU-Pool erlaubt.

Präfixe mit Länge 10 laufen höchstens 60 Tage. Ein Treffer ist nicht garantiert;
nach Suchstart ist die Rechengebühr nicht erstattbar. Diese Bedingung wird in
Quote, Website, API und Job-Datensatz ausgewiesen.

## API-Beispiel

```json
{
  "version": 1,
  "kind": "monero",
  "network": "mainnet",
  "public_address": "4...",
  "prefixes": ["4MFW", "4Fast"],
  "notification": {
    "installation_id": "opaque-installation-id",
    "platform": "android"
  }
}
```

Die Antwort enthält einmalig `status_token` und
`mfw://vanity/order/<order-id>`. Mobile und Tauri speichern das Token nur im
geschützten Speicher. Push-Nachrichten enthalten ausschließlich Order-ID und
diesen Status-Link, niemals Wallet-Adresse, Betrag oder Schlüsselmaterial.

Start und Prüfung:

```sh
cargo test --manifest-path backend/mfw-vanity-service/Cargo.toml
cargo run --release --manifest-path backend/mfw-vanity-service/Cargo.toml
```
