# Monero Fast Wallet

**Eine schnelle, selbstverwaltete Monero-Wallet für iOS, Android und Desktop.**

Monero Fast Wallet verbindet den offiziellen Monero-Wallet-Core mit einem
optimierten Cuprate-Datenpfad, nativer CPU-/Metal-Beschleunigung und optionalen,
datensparsamen Empfangsbenachrichtigungen. Seed und Spend Key bleiben unter der
Kontrolle des Nutzers.

> **Entwicklungsstatus:** Der Quellcode ist weit fortgeschritten, aber noch
> **nicht für eine öffentliche Mainnet-Veröffentlichung freigegeben**. Signierte
> Release-Artefakte, physische Plattform- und Ledger-Abnahmen, unabhängige
> Sicherheitsprüfung sowie mehrere Betriebs- und Wiederherstellungstests sind
> noch offene Release-Gates. Details stehen in der
> [Release-Gate-Matrix](docs/RELEASE_GATE_MATRIX.md) und im
> [Security Audit](docs/SECURITY_AUDIT_2026-07-24.md).

[Funktionen](#funktionen) ·
[Vorteile](#die-wichtigsten-vorteile) ·
[Benchmarks](#performance-und-benchmarks) ·
[Privatsphäre](#zwei-klare-privatsphäre-modi) ·
[Plattformstatus](#plattformstatus) ·
[Repository](#monorepo-aufbau) ·
[Entwicklung](#lokal-entwickeln-und-testen)

---

## Was ist Monero Fast Wallet?

Die Anwendung ist keine Oberfläche über `monero-wallet-cli` oder
`monero-wallet-rpc`. Mobile und Desktop sprechen über kleine native Bridges
direkt mit unserem kompatiblen Fork von Moneros `libwallet_api` / `wallet2`.

```text
React Native (iOS / Android)        React + Tauri 2 (Desktop)
              \                         /
               \                       /
                native Wallet-Bridge
                         |
                   Monero wallet2
                         |
          +--------------+---------------+
          |                              |
   Original Monero RPC          optimiertes Cuprate gRPC
                                         |
                                  optional ScanPack
```

Das Ergebnis soll sich wie eine einfache Alltags-Wallet bedienen lassen, ohne
Moneros Adress-, Transaktions- oder Konsensregeln zu verändern.

## Die wichtigsten Vorteile

| Vorteil | Was Nutzer davon haben |
| --- | --- |
| **Deutlich schnellerer Restore und Sync** | Im streng vergleichbaren Mainnet-R3-Lauf war der optimierte Walletpfad **2,69× schneller** als die unveränderte Monero-Wallet. Der akzeptierte ScanPack-D4-Median lag im Testkontext bei rund **6,97×** der ursprünglichen Sync-Rate. |
| **Hardware wird automatisch sinnvoll genutzt** | CPU, AVX2, AVX-512 IFMA und Apple Metal werden nach Plattform und Batchgröße gewählt. Kleine Metal-Batches bleiben bewusst auf der CPU, weil ein GPU-Start dort langsamer wäre. |
| **Selbstverwahrung als Standard** | Seed, Spend Key, Haupt-View-Key und Walletdateien bleiben lokal beziehungsweise beim Ledger. Der normale Walletmodus lädt keinen privaten View Key zu TEX8 hoch. |
| **Normale Monero-Kompatibilität** | Die Wallet kann den schnellen Cuprate-gRPC-Pfad, einen normalen Monero-Daemon oder einen eigenen kompatiblen Node verwenden. Adressen, Transaktionen und Konsens bleiben Standard-Monero. |
| **Schnelle, aber optionale Empfangssignale** | Fast Receive nutzt eine getrennte Empfangsidentität. Der Server kann nicht ausgeben und versendet nur ein opakes Signal; Betrag und Transaktionsdetails werden lokal verifiziert. |
| **Mobile und Desktop aus einem Produkt-Repo** | React Native für iOS/Android und Tauri 2 für macOS/Windows/Linux teilen Walletregeln, native Core-Verträge, Services, Tests und Release-Dokumentation. |
| **Nachprüfbare Optimierungen** | CPU-, Metal-, Vulkan-, CUDA-, Transport- und Mainnet-Sync-Testbenches sowie **1.678 textbasierte Rohartefakte** liegen im Repository. Erfolgreiche und verworfene Versuche sind dokumentiert. |
| **Ledger vorgesehen** | USB/HID- und mobile BLE-Transportpfade sind im Quellcode vorhanden. Seed und Signaturautorität bleiben auf dem Gerät; die vollständige physische Release-Abnahme ist noch offen. |

## Funktionen

### Wallet und Zahlungen

- Wallet erstellen oder aus Monero-Recovery-Wörtern wiederherstellen
- native Recovery-Eingabe, damit Wörter nicht durch React- oder Tauri-State
  laufen
- mehrere Software-, View-only-, Ledger- und Fast-Wallets verwalten
- mehrere Empfangsadressen und Subadressen erzeugen
- lokale, Core-bestätigte Adresse als QR-Code anzeigen
- Kontostand, Syncstatus, Aktivität und strukturierte Transaktionsdetails
- zweistufiges Senden: Transaktion vorbereiten und prüfen, danach ausdrücklich
  bestätigen und übertragen
- lokales Adressbuch, Donation-Eintrag bei Konfiguration und drei zuletzt
  verwendete Empfänger
- Restore-Datum mit gemeinsamem, bewusst konservativem Restore-Height-Modell
- Umschalten zwischen Mainnet, Stagenet und unterstützten Testkonfigurationen

### Schutz auf dem Gerät

- app-weite Sperre statt zusätzlicher, verwirrender Passwörter je Wallet
- Face ID / Touch ID / Gerätecode auf iOS
- starke Biometrie / Geräte-PIN auf Android
- Touch ID oder App-Passwort auf macOS
- Windows Hello beziehungsweise App-Passwort auf Windows
- Fingerprint via `fprintd` plus Recovery-Passwort auf Linux
- Argon2id für den nativen App-Passwortpfad
- Plattform-Credential-Stores für geschützte lokale Metadaten
- iOS Keychain und Android-Keystore-gestützte AES-GCM-Speicherung für
  Daemon-Zugangsdaten
- native, einmalige und an Empfänger, Betrag, Gebühr, Wallet sowie Ablaufzeit
  gebundene Sendebestätigung
- Schutz gegen Screenshots, Task-Switcher-Vorschauen und sensible Release-Logs

Die Implementierung dieser Schutzpfade ist vorhanden und vertraglich getestet.
Die vollständige physische Abnahme auf jeder Plattform ist noch ein
Release-Gate.

### Node und Synchronisation

- **Optimiert:** Cuprate gRPC mit parallelem Hash-Vorlauf, Block-Streaming,
  Range-Reads und Drift-/Chain-Split-Diagnostik
- **Kompatibel:** ursprünglicher Monero-Daemon-RPC-Pfad
- **Flexibel:** eigener Node und getrennte Profile je Netzwerk
- spekulatives Block-Prefetching und gzip-kompatibler Bin-RPC-Pfad
- persistenter Cuprate-ScanPack-Cache für schnelle historische Blockbereiche
- kontrollierte gRPC-Queues, HTTP/2-Fenster und optional getrennte TCP-Lanes
- Core-bestätigter Syncstatus: gleiche Höhen allein werden noch nicht als
  vollständig synchronisiert ausgegeben
- Reorg-, Fallback- und Diagnosepfade, ohne Monero-Konsensregeln anzupassen

### Ledger Nano

- offizieller Monero-`device_ledger`-Pfad im nativen Wallet-Core
- USB/HID-Unterstützung
- Ledger Nano X BLE-Transporte für iOS und Android im nativen Layer
- Gerätebestätigung für Adresse und Signatur vorgesehen
- lokale Read-only-Synchronisation nach einem ausdrücklich genehmigten
  View-Key-Export
- getrennte Fast-Wallet-Empfangsidentität auch für Ledger-Flows

> Der Quellpfad ist implementiert, aber eine Funktion gilt erst nach
> wiederholbarer Prüfung von Erstellen, Öffnen, Reconnect, Adressanzeige und
> Signatur auf physischen Geräten als release-akzeptiert.

### Fast Receive und Benachrichtigungen

Fast Receive ist ein ausdrücklich optionaler Komfortmodus:

1. Die App erzeugt eine **separate** Empfangs-Wallet mit eigenem View- und
   Spend-Key.
2. Nur Adresse, privater View Key dieser isolierten Identität, Netzwerk und
   Restore-Höhe gehen nach Zustimmung an den Scanner.
3. Der Scanner liest bestätigte ScanPack-Daten nur lesend oder verwendet den
   Cuprate-gRPC-Fallback.
4. Bei einem Treffer entsteht nur eine gehashte, opake Ereignis-ID.
5. Die App erhält „Aktivität erkannt“ und ermittelt Betrag, Transaktion und
   Spendbarkeit erneut mit ihrem lokalen Wallet-Core.

Der Server erhält **nie** Seed, privaten Spend Key oder Haupt-Wallet-View-Key.
Watch-Datensätze besitzen zufällige, nur gehasht gespeicherte
Verwaltungs-Capabilities. Die Datenbank ist mit XChaCha20-Poly1305
verschlüsselt, atomar geschrieben, versioniert sicherbar und
schlüsselrotierbar. Raten-, Verbindungs-, Größen- und Mengenlimits sind
vorhanden.

Benachrichtigungspfade:

| Plattform | Pfad |
| --- | --- |
| macOS | APNs; geschlossene Entwicklungs-App und Klickstart wurden beobachtet |
| Windows | unprivilegierter WSS-Benutzeragent → lokale Windows-Benachrichtigung |
| Linux | unprivilegierter WSS-Benutzeragent → DBus-Benachrichtigung |
| iOS / Android | gemeinsamer anonymer Push-Subscription-Vertrag; physische Provider-Abnahme noch offen |

Alle Push-Nachrichten bleiben generisch. Walletname, Adresse, Betrag,
Transaktions-ID, Blockhöhe, Seed und Schlüssel sind im Payload verboten.

### Community, News und Assistant

- optionale Suche nach Monero-Enthusiasten in einer groben Region
- exakte Koordinaten werden sofort auf einen fünfstelligen Geohash reduziert
  und weder gespeichert noch hochgeladen
- pseudonyme Profile, 30-Minuten-Präsenz, gegenseitige Kontaktfreigabe, Chat,
  Blockieren, Melden, Drosselung und Identitätslöschung
- Community-Datenbank verschlüsselt at rest; der aktuelle Chat ist
  **nicht Ende-zu-Ende-verschlüsselt**
- eigener Community-Dienst ohne Wallet-API oder Walletdaten
- Monero-News über einen getrennten TEX8-Cache der offiziellen
  Monero-Quellen; keine Wallet-, Account- oder Identifikationsdaten
- lokaler, statusbewusster Tex8-Assistant-Einstieg ohne automatischen
  Remote-Modellaufruf

Die Live-Community-Route hat beim dokumentierten Audit den vollständigen
11/11-Vertragstest bestanden. Der News-Endpunkt war bei derselben Prüfung
nicht erreichbar und muss bis zu einer neuen Live-Abnahme als „nicht
verfügbar“ mit Retry dargestellt werden.

### Bewusst noch nicht als Funktion angeboten

Diese Ideen stehen in der Roadmap, dürfen aber nicht als fertige Features
verstanden werden:

- Telefonbuch- oder Telefonnummern-basierte Zahlungen
- Trust- und Reputation-System
- Marketplace / Handel
- Escrow oder Monero-Multisig-Handelsfluss

## Zwei klare Privatsphäre-Modi

| | Privacy only | Privacy + comfort / Fast Receive |
| --- | --- | --- |
| Seed | nur lokal / Ledger | nur lokal / Ledger |
| privater Spend Key | nur lokal / Ledger | nur lokal / Ledger |
| Haupt-Wallet-View-Key | nur lokal | nur lokal |
| separater Fast-View-Key | nicht vorhanden | nach Zustimmung beim Scanner |
| Server kann ausgeben | nein | nein |
| Empfangssignal bei geschlossener App | nein | ja, generisch und opak |
| endgültige Zahlungsprüfung | lokaler Wallet-Core | lokaler Wallet-Core |
| stärkstes Datenschutzmodell | **ja** | bewusster Komfort-Trade-off |

Ein privater View Key kann grundsätzlich mehr eingehende Zahlungsmetadaten
sichtbar machen. Die Open-Source-Implementierung verwirft Details und speichert
nur opake Ereignisse; das ist jedoch eine softwarebasierte Vertrauensgrenze.
Wer dieses Vertrauen nicht möchte, nutzt den normalen lokalen Walletmodus.

Mehr dazu:
[Privacy Model](docs/PRIVACY_MODEL.md) ·
[Threat Model](docs/THREAT_MODEL.md) ·
[Security Policy](SECURITY.md)

## Performance und Benchmarks

### Was genau gemessen wird

Die Krypto-Testbenches messen Moneros vollständige Wallet-Key-Derivation:

```text
D = 8 × a × R

a = privater View-Scalar der Wallet
R = öffentlicher Transaktionsschlüssel
```

`Ableitungen/s` ist ein **Krypto-Kernelwert**. Er ist weder Blöcke/s noch eine
Wallet-Syncdauer. Für Nutzergeschwindigkeit sind deshalb die getrennten
Mainnet-End-to-End-Läufe weiter unten entscheidend.

Für die Desktop-/CUDA-Normalisierung wird die archivierte,
workload-identische Single-Thread-Ref10-Serie verwendet:

```text
Original Monero Ref10: 27.030,166 Ableitungen/s = 1,00×
```

Ein normalisierter Faktor enthält neben Algorithmusverbesserungen auch
Parallelität und Hardwareunterschiede. Nur direkte A/B-Zeilen auf derselben
Maschine isolieren den eigentlichen Softwaregewinn.

### Krypto-Leistung nach Plattform

| Plattform / Pfad | Belastbarer Wert | Faktor zur angegebenen Ref10-Basis | Produktstatus |
| --- | ---: | ---: | --- |
| Original Monero Ref10, 1 Thread | 27.030,166/s | **1,00×** | gemeinsame Desktop-/CUDA-Normalisierung |
| Apple M4 CPU, 10 Worker | 262.888,292/s | **9,73×** normalisiert | akzeptierter CPU-Kernel |
| EPYC 9634 AVX-512 IFMA, 12 Worker | 343.589,844/s | **12,71×** normalisiert | akzeptierter CPU-Kernel mit AVX2-Fallback |
| EPYC Hosted Scanner, 16er-Batch | 520.437,272/s | **19,25×** normalisiert | langer Produkt-Integrationslauf |
| EPYC Hosted Scanner, kurzer Smoke-Peak | 526.300,493/s | **19,47×** normalisiert | nur Spitzenwert, kein Ersatz für den langen Lauf |
| Apple M4 Metal M17, echte Produktgrenze | 459.493,923/s | **17,00×** normalisiert | paketierte Metallib, CPU-Fallback |
| Apple M4 Metal M16, Kernel only | 521.626,293/s | **19,30×** normalisiert | isolierter Kernel, nicht Produktgrenze |
| Pixel 8 Pro CPU, 9 Worker, Gerät 1 | 77.962,845/s | **7,826×** zur lokalen Ref10-Basis von 9.961,612/s | ausgewählter Mobilpfad |
| Pixel 8 Pro CPU, 9 Worker, Gerät 2 | 75.586,545/s | **9,079×** zur lokalen Ref10-Basis von 8.325,397/s | ausgewählter Mobilpfad |
| Pixel 8 Pro Vulkan, optimiert | 20.693,944/s | **2,486×** zur lokalen Ref10-Basis | korrekt, aber nicht aktiviert |
| RTX 3090 CUDA C6, formaler Median | 10.948.124,475/s | **405,03×** | validierter Forschungstestbench |
| RTX 3090 CUDA C6, Dauerlauf | 10.790.157,075/s | **399,19×** | validierter Forschungstestbench |
| RTX 3090 CUDA, bester Einzellauf | 11.532.473,446/s | **426,65×** | kurzer Spitzenwert |
| RTX 5090 CUDA C7, formaler Median | 26.818.054,526/s | **992,15×** | validierter Forschungstestbench |
| RTX 5090 CUDA C7, Dauerlauf | 26.877.688,327/s | **994,36×** | stärkster belastbarer CUDA-Wert |
| RTX 5090 CUDA, bester Einzellauf | 27.323.459,974/s | **1.010,85×** | kurzer Spitzenwert |

Die spätere historische Ref10-Serie mit größerem Korpus ergab auf demselben M4
16.294,622/s. Gegen diese andere Serie wären die M17-Raten rechnerisch
28,20×. Dieser Wert bleibt Kontext und wird nicht mit der workload-identischen
27.030,166/s-Normalisierung vermischt.

### Direkte Optimierungsgewinne

Diese Faktoren stammen aus gleichen oder unmittelbar gepaarten A/B-Läufen und
zeigen, was die jeweilige Änderung selbst gebracht hat:

| Optimierung | Vorher | Nachher | Verbesserung |
| --- | ---: | ---: | ---: |
| M4: Prepared Scalar + Pairing + Batch-Kompression + Workspace-Reuse | 233.023,743/s | 262.888,292/s | **1,128×** / **+12,816 %** |
| EPYC: Stable AVX2 → AVX-512 IFMA | 269.406,083/s | 343.589,844/s | **1,275×** / **+27,536 %** |
| Hosted Scanner: Per-Item → 16er-Batch | 447.343,589/s | 520.437,272/s | **1,163×** / **+16,339 %** |
| Metal M17 Produktpfad → CPU-Produktpfad bei 8.192 Punkten | 229.459,565/s | 459.493,923/s | **2,003×** / **+100,251 %** |
| Metal M12 → M16 Kernel | 518.611,644/s | 521.626,293/s | **1,006×** / **+0,581 %** |
| Pixel Vulkan: erster M12 → selektives SPIR-V `-O` | 8.522,704/s | 20.677,429/s | **2,426×** |
| CUDA RTX 3090: C5 → C6 bei 131.072 Punkten | 10.331.329/s | 10.948.124/s | **1,060×** / **+5,97 %** |
| RTX 3090 → RTX 5090, beste Einzelläufe | 11.532.473/s | 27.323.460/s | **2,369×** |
| RTX 3090 → RTX 5090, Dauerläufe | 10.790.157/s | 26.877.688/s | **2,491×** |

**Einordnung des Screenshots:** `526.300,493 / 343.589,844` ergibt
rechnerisch **1,532× beziehungsweise +53,2 %**. Die Prozentrechnung ist
korrekt, aber die beiden Werte stammen nicht aus derselben A/B-Serie:
343.589,844/s war ein historischer AVX-512-Lauf, 526.300,493/s ein kurzer
Smoke-Test des späteren Scanner-Batchpfads. Als belastbarer direkter
Softwarevergleich gilt deshalb 447.343,589 → 520.437,272/s, also **1,163×
beziehungsweise +16,339 %**.

### Warum nicht jede GPU automatisch schneller ist

- Metal gewinnt im gemessenen Produktpfad erst ab **2.048 Punkten**. Bei 1.024
  Punkten war Metal **27,315 % langsamer** als die CPU. Der Dispatcher nutzt
  deshalb darunter CPU und darüber Metal; Fehler fallen immer auf CPU zurück.
- Auf dem Pixel war die optimierte Vulkan-GPU trotz korrekter Ergebnisse
  **3,65× langsamer** als der 9-Worker-CPU-Pfad.
- Gleichzeitige Pixel-CPU+GPU-Ausführung lag im Median **3,75 % unter**
  CPU-only und erhöhte den thermischen Status. Sie wurde verworfen.
- Der RTX-5090-Dauerlauf erreichte **100 % GPU-Auslastung** im Median und
  Mittel. Der Speichercontroller lag bei 0 %, die Leistung bei durchschnittlich
  507,87 W und maximal 540,40 W von 550 W, die Temperatur maximal bei 63 °C.
  Der Kernel war Compute-, Register- und Power-limitiert, nicht
  speicherbandbreitenlimitiert.
- CUDA ist derzeit ein validierter Benchmark-Backend, **noch kein
  Produktionspfad der Wallet**.

### Echte Mainnet-Synchronisation

Getestet wurde ein Restore ab Höhe 3.577.876 über die reale
Panama↔Deutschland-Strecke. Ein Lauf zählt nur, wenn Wallet und Node sauber auf
derselben Kette enden.

| Pfad | Syncdauer | Blöcke/s | Faktor zur Originaldauer | Vergleichsqualität |
| --- | ---: | ---: | ---: | --- |
| Original Monero Wallet, R3 | 1.007,483 s | 146,06 | **1,00×** | gültige Referenz |
| Monero Fast Wallet gRPC, R3 | 375,166 s | 392,25 | **2,69×** | strenger, gleicher Restore-Vertrag |
| ScanPack C0, Median aus 3 Läufen | 173,760 s | 848,01 | **≈5,80×** Kontext | anderer Live-Tip; kein strenger R3-A/B |
| ScanPack D4, 32-MiB-Fenster, Median aus 3 Läufen | 144,452 s | 1.020,734 | **≈6,97×** Kontext | akzeptierter D4-Median, Live-Tip bewegte sich |
| ScanPack D5.3, 4 physische TCP-Lanes | 139,169 s | 1.059,633 | **≈7,24×** Kontext | schnellster Einzellauf, experimentell |

Weitere gemessene Teilpfade:

| Teilpfad | Ergebnis | Einordnung |
| --- | ---: | --- |
| paralleler Fast-Hash-Vorlauf | 246.240,61 statt 17.287,09 Hashes/s | **14,24×**, aber nur eine Syncphase |
| ScanPack-Rohtransport mit CUBIC | 34,99 MiB/s | echter Payloadtransport, keine Walletarbeit |
| ScanPack-Rohtransport mit gRPC-spezifischem BBR | 64,59 MiB/s Median | **1,846× / +84,6 %** gegen CUBIC; keine Wallet-Syncrate |
| Wallet-Krypto: Rust 10 Worker gegen 1 Worker | 4,92× Rust-Batchzeit | der vorhandene C++-Pool war bereits praktisch gleich schnell |

Die Produktmessung mit 7,45 Millionen Ableitungen zeigte außerdem, dass der
vorhandene C++-Pool die CPU bereits fast so gut nutzte wie der neue
10-Worker-Rust-Batch: 32.819 ms gegenüber 32.877 ms Key-Derivation-Zeit. Der
Batch reduzierte die FFI-Aufrufe zwar von rund 7,45 Millionen auf 596, brachte
aber keinen messbaren Phasengewinn und wurde deshalb nicht zum Default.

### Ist die Hardwarebeschleunigung in der echten Wallet schneller als im Testbench?

**Nicht pauschal. Die Vermutung ist nur teilweise richtig.**

Der private View-Scalar `a` ist für eine Wallet konstant und kann einmal je
Wallet und verarbeitetem Blockfenster vorbereitet werden. Jede Transaktion
enthält aber einen eigenen öffentlichen Transaktionsschlüssel `R`; bei
Subadress- oder Mehrziel-Transaktionen können zusätzliche Schlüssel vorkommen.
Für jeden unterschiedlichen Schlüssel muss weiterhin `D = 8 × a × R`
berechnet werden.

Was sich in der Praxis wiederverwenden oder amortisieren lässt:

- vorbereitete Scalar-Darstellung
- einmaliges Dekodieren eines Blockfensters
- Sammeln und Deduplizieren identischer Transaktionsschlüssel
- eine Ableitung für mehrere Outputs derselben Transaktion
- persistente Worker-Pools, Workspaces und größere Hardware-Batches
- gemeinsamer Blockabruf für mehrere Hosted Watches am selben Cursor

Was weiterhin pro Transaktionsschlüssel anfällt:

- Punktdekodierung beziehungsweise vorbereitete Punktdaten
- elliptische Skalarmultiplikation
- Multiplikation mit dem Cofactor 8
- Kompression und anschließende Output-/View-Tag-Prüfung

Darum ist ein reiner Krypto-Testbench normalerweise die **Obergrenze des
Kernels**. Eine echte Wallet hat zusätzlich Netzwerk, Parsing, Datenbank,
Queues, FFI, Transaktionscache und Chain-Commit. Große Restore-Fenster oder
viele gebündelte Hosted Watches können relativ stärker von Batching
profitieren als ein naiver Per-Item-Pfad; der End-to-End-Faktor bleibt wegen
der übrigen Arbeit aber gewöhnlich kleiner als der Krypto-Faktor.

Moneros offizielle Implementierung dekodiert `R`, multipliziert es mit dem
View-Scalar, multipliziert das Ergebnis mit 8 und komprimiert es wieder:
[`generate_key_derivation`](https://github.com/monero-project/monero/blob/master/src/crypto/crypto.cpp).
Der Wallet-Core erzeugt die primäre und gegebenenfalls zusätzliche Ableitung
für die Transaktionsschlüssel, bevor er die Outputs prüft. Eine ausführliche
Herleitung enthält
[Zero to Monero, Kapitel 4](https://www.getmonero.org/library/Zero-to-Monero-2-0-0.pdf).

### Reproduzierbarkeit und vollständige Resultate

- [Testbench-Index](docs/WALLET_ACCELERATION_TESTBENCH_INDEX.md)
- [CPU: M4 und EPYC](docs/WALLET_CRYPTO_CPU_TESTBENCH_RESULTS.md)
- [M4 CPU: finaler Batchpfad](tools/wallet-derivation-cpu-testbench/M4_CPU_RESULTS_20260725.md)
- [Apple Metal](docs/WALLET_CRYPTO_METAL_TESTBENCH_RESULTS.md)
- [Metal-Produktintegration](docs/DESKTOP_METAL_BACKEND_PACKAGING_2026-07-25.md)
- [Pixel 8 Pro CPU und Vulkan](tools/wallet-mobile-acceleration-testbench/PIXEL_8_PRO_RESULTS.md)
- [RTX 3090 und RTX 5090 CUDA](tools/wallet-cuda-testbench/RESULTS-2026-07-25.md)
- [Hosted Scanner auf EPYC](docs/HOSTED_VIEW_KEY_SCANPACK_EPYC_2026-07-25.md)
- [Mainnet-Sync und ScanPack](docs/WALLET_SYNC_BENCHMARK_RESULTS.md)
- [Rohartefakte](docs/benchmark-evidence/2026-07-25)

Alle akzeptierten Krypto-Läufe prüfen ihre Ausgaben bytegenau gegen eine
Referenz, validieren den Fehlerpfad für ungültige Punkte und verwenden keine
echten Wallet-Schlüssel. CUDA C7/C11 bestand die Checksummenprüfung; die
RTX-5090-C7-Läufe bestanden zusätzlich CUDA `memcheck` und `initcheck` ohne
Fehler.

## Plattformstatus

„Implementiert“ bedeutet vorhandenen Quellcode und fokussierte Tests, nicht
automatisch ein freigegebenes Endnutzer-Artefakt.

| Plattform | Aktueller Stand | Vor Release noch erforderlich |
| --- | --- | --- |
| iOS | React-Native-App, nativer Monero-Core-Buildpfad, native Recovery-Eingabe, App-Schutz, BLE-Transport und Push-Vertrag vorhanden | physische Wallet-, Ledger-, APNs-, Lifecycle-, Accessibility- und Store-Abnahme |
| Android | React-Native-App, JNI/Core, USB/HID, BLE, Keystore, native Recovery-Eingabe und Release-Buildpfad vorhanden | physische Wallet-, Ledger-, FCM-, Geräte-, Accessibility- und Play-Abnahme |
| macOS | Tauri-2-App mit lokal gelinktem Core; Create/Open/Seed/Subadresse getestet; Metal-Backend paketiert | exakte App signieren, notarifizieren, stapeln sowie Wallet-, Ledger- und Push-Abnahme wiederholen |
| Windows | UI, Rust-Host, Schutz- und Notification-Agent-Verträge vorhanden | nativen Core als DLL bauen/laden; danach vollständige Wallet-, Ledger-, Push- und Installer-Abnahme |
| Linux | ARM64-AppImage mit Core lokal assembliert; DBus-Agent-Vertrag vorhanden | Clean-User-, Real-Node-, Ledger-, Notification- und Paketabnahme |
| Services | Community beim Audit live; Scanner, Gateway, News und Cuprate als getrennte Komponenten vorhanden | aktuelle Live-Routen, Backups, Rotation, Restore, Last, Reorg und Monitoring wiederholbar abnehmen |

Der genaue, auditierbare Stand steht in
[Platform Integration Status](docs/PLATFORM_INTEGRATION_STATUS.md) und
[Desktop/Mobile Parity Matrix](docs/DESKTOP_PARITY_MATRIX.md).

## Sicherheit

Wichtige unverhandelbare Grenzen:

- keine Seeds oder privaten Spend Keys auf Servern
- keine Wallet-Schlüssel oder Walletdateien in React Native / React
- keine generische Shell-, Dateisystem- oder Credential-Store-Berechtigung für
  den Desktop-Renderer
- keine Transaktionsdetails in Push-Payloads
- kein Haupt-Wallet-View-Key für Fast Receive
- keine exakten Koordinaten im Community-Dienst
- TLS mit normaler Zertifikatsprüfung für Scanner, Push, News und Community
- lokale Walletverifikation bleibt immer autoritativ
- Monero-Transaktionsformat, Adressen, Spend-Regeln und Konsens bleiben
  unverändert

Die Sicherheitsprüfung fand historische Critical-/High-/Medium-Befunde. Die
zentralen Quellcode-Mitigations sind implementiert, aber operative und
physische Abnahmen sowie eine unabhängige Prüfung stehen noch aus. Deshalb ist
der aktuelle Stand ausdrücklich **MAINNET NO-GO**.

Dokumente:

- [SECURITY.md](SECURITY.md)
- [Threat Model](docs/THREAT_MODEL.md)
- [Security Audit](docs/SECURITY_AUDIT_2026-07-24.md)
- [Secure Release Checklist](docs/SECURE_RELEASE_CHECKLIST.md)
- [Incident Response](docs/SECURITY_INCIDENT_RESPONSE.md)

## Monorepo-Aufbau

Dieses Repository ist das Produkt- und Integrations-Monorepo:

```text
apps/
  mobile/                         React Native für iOS und Android
  desktop/                        React + Tauri 2 für Desktop

native/
  monero-bridge/                  C++ WalletEngine, iOS- und Android-Bridges
  desktop-bridge/                 kleine Rust ↔ C++ C-ABI

packages/
  wallet-shared/                  gemeinsame Wallet- und Syncregeln

services/
  notify-scanner/                 optionaler Hosted-View-Key-Scanner
  notification-gateway/          opake WSS-/Push-Zustellung
  enthusiast-discovery/          getrennte Community-API
  monero-news/                    Cache offizieller Monero-News

node/
  cuprate/                        integrierter Cuprate-Quellstand

third_party/
  monero-patches/                 geordnete Monero-Produktpatches
  cuprate-patches/                geordnete Cuprate-Produktpatches
  curve25519-dalek-wallet-cpu/    reproduzierbare CPU-Patches
  monero-experimental-patches/    getrennte Forschungsstände

tools/
  wallet-original-crypto-testbench/
  wallet-crypto-testbench/
  wallet-derivation-cpu-testbench/
  wallet-metal-testbench/
  wallet-metal-product-testbench/
  wallet-mobile-acceleration-testbench/
  wallet-cuda-testbench/
  wallet-testbench/

ops/
  cuprate-sync-benchmark/
  notify-scanner/

docs/
  Produkt-, Architektur-, Sicherheits-, Release- und Benchmarkdokumente
```

Monero und Cuprate behalten zusätzlich ihre separat aktualisierbaren Forks:

| Projekt | Remote | dokumentierter Produktstand |
| --- | --- | --- |
| Produkt | `tex8com/monero-fast-wallet` | dieser Branch / Commit |
| Monero Core CPU | `tex8com/monero` | `382b8c06641c9e905a98dc4ac77c17f746aceb8c` |
| Monero Core CPU + Metal | `tex8com/monero` | `cdcfa8151322a3fdd9306af97ab0c54092ac1e37` |
| Monero CUDA-Forschung | `tex8com/monero` | `024224eb5cde9c8a243a152e3927399550479cd2` |
| Cuprate Produktion | `tex8com/cuprate` | `cd1ec57ab44301b93a21e9b504b9d913b88fc871` |

Die **21 Monero-Produktpatches** und **41 Cuprate-Patches** liegen geordnet im
Produkt-Repo. Die Patch-Reproduktion prüft den erwarteten finalen Quellbaum,
bevor ein Core gebaut wird. Generierte Dependencies, Walletdateien, Secrets,
Logs und Build-Ausgaben gehören nicht in Git.

Mehr dazu:
[Sources](docs/SOURCES.md) ·
[Repository Strategy](docs/REPOSITORY_STRATEGY.md) ·
[Local Consolidation Record](docs/LOCAL_WORKTREE_CLEANUP_2026-07-26.md)

## Lokal entwickeln und testen

### Voraussetzungen

- Node.js **22.11 oder neuer**
- npm passend zum jeweiligen Lockfile
- Rust aus [rust-toolchain.toml](rust-toolchain.toml)
- Xcode für iOS/macOS
- Android SDK/NDK und Java für Android
- native Monero-Abhängigkeiten gemäß den Buildskripten
- CUDA Toolkit nur für den CUDA-Forschungstestbench

### Mobile

```bash
cd apps/mobile
npm ci
npm run lint
npm test -- --runInBand
```

Buildpfade:

```bash
npm run ios:build-simulator-core
npm run android:build
```

### Desktop

```bash
cd apps/desktop
npm ci
npm run build
npm run test:parity-contract
npm run test:platform-contract
npm run test:wallet-contract
npm run test:push-contract
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Für den macOS-Entwicklungspfad mit lokal vorbereitetem Monero-Core:

```bash
npm run dev:wallet
```

### Services

Jeder Rust-Service besitzt sein eigenes `Cargo.toml` und Lockfile. Beispiel:

```bash
cargo test --locked --manifest-path services/notify-scanner/Cargo.toml
cargo test --locked --manifest-path services/notification-gateway/Cargo.toml
cargo test --locked --manifest-path services/enthusiast-discovery/Cargo.toml
cargo test --locked --manifest-path services/monero-news/Cargo.toml
```

Keine echte Wallet, kein Seed und kein produktiver Schlüssel darf in einem
Testbench, Log oder Issue verwendet werden.

### Zuletzt dokumentierte breite Prüfungen

| Bereich | Ergebnis |
| --- | --- |
| Mobile | 28 Jest-Suites / 131 Tests bestanden; Lint ohne Fehler |
| Desktop Renderer und Plattformverträge | Build und 42 Verträge bestanden |
| Desktop Rust | 30 Tests bestanden; 1 realer Credential-Store-Test bewusst ignoriert |
| Community live | 11/11 Vertragsprüfungen bestanden |
| Native Bridge | ASan- und UBSan-Smoke-/Hostile-Input-Prüfungen bestanden |
| Supply Chain | npm-Audits ohne bekannte Schwachstellen; Rust-Ausnahmen explizit und zeitlich begrenzt |
| Benchmarks | akzeptierte CPU-, Metal-, Vulkan- und CUDA-Ausgaben bytegleich validiert |

Diese Zahlen beschreiben den dokumentierten Auditstand, nicht automatisch den
aktuellen Zustand einer später veränderten Arbeitskopie.

## Dokumentation

- [Roadmap](docs/ROADMAP.md)
- [Architektur](docs/ARCHITECTURE.md)
- [Native Wallet Bridge](docs/NATIVE_WALLET_BRIDGE.md)
- [Mobile Wallet Core Plan](docs/MOBILE_WALLET_CORE_IMPLEMENTATION_PLAN.md)
- [Desktop App Plan](docs/DESKTOP_APP_PLAN.md)
- [Desktop/Mobile Parity](docs/DESKTOP_PARITY_MATRIX.md)
- [Backend Testing](docs/BACKEND_TESTING.md)
- [Release Gates](docs/RELEASE_GATE_MATRIX.md)
- [Benchmark Index](docs/WALLET_ACCELERATION_TESTBENCH_INDEX.md)

## Projektprinzipien

1. **Selbstverwahrung zuerst.**
2. **Einfache Bedienung ist ein Sicherheitsmerkmal.**
3. **Keine erfundenen Wallet-, Community- oder Servicedaten.**
4. **Schnelle Pfade müssen korrekt, reproduzierbar und rückfallfähig sein.**
5. **Ein Benchmark ist nur so gut wie seine klar benannte Messgrenze.**
6. **Serverhinweise ersetzen nie die lokale Walletverifikation.**
7. **Kompatibilität mit Monero ist wichtiger als eine proprietäre Abkürzung.**

---

**Repository:** <https://github.com/tex8com/monero-fast-wallet><br>
**Monero-Fork:** <https://github.com/tex8com/monero><br>
**Cuprate-Fork:** <https://github.com/tex8com/cuprate>
