# Umsetzungsplan: stabile Wallet-Synchronisierung und vollständige Diagnose

Status: **Fehlerursache verifiziert, Kernfix auf dem Pixel bestanden; der jüngste UI-Build ist fertig, sein Wiederholungstest wartet nur auf die erneute ADB-Verbindung.**

## Verifizierungsstand vom 8. Oktober 2026

- `curl` gegen `http://xmr.tex8.com:18089`: `get_info`, `get_height` und `get_block_count` liefern HTTP 200 und einen synchronisierten Mainnet-Tip.
- Die unabhängige Cuprate-Testbench bestätigt RPC, Pool, Transaktionsabfrage, Key-Image-Abfrage und den gRPC-Blockstream. Der gRPC-Smoke-Test empfing 11 Blöcke und endete mit `grpc_status=0`.
- Das wiederkehrende ADB-Fehlermerkmal `16194673465541041915` wurde gegen die tatsächlich installierte native Android-Bibliothek aufgelöst. Der exakte Text lautet `networkSync.rescanFreshWallet: wallet is not initialized`.
- Damit ist bewiesen: Der erfolgreiche Node-Abruf ist nicht die Ursache. Erst der anschließende lokale Fresh-Wallet-Reset schlägt fehl.
- Der fehlerhafte Daemon-Weg `rescanBlockchain()` wurde durch `resetBlockchainCacheForSharedSync()` ersetzt. Der Reset prüft danach Restore-Height, lokalen Cache-Stand und beide Sync-Cursor.
- Lokale Rebase-, Scan- und Checkpoint-Fehler werden jetzt als `local-wallet` klassifiziert und behalten den gesunden öffentlichen Transport.
- Jede Iteration und jeder Rebase protokolliert eine korrelierbare `iterationId`, Fehlerdomäne, Cursor vor/nach dem Reset und die Transportentscheidung.
- Der isolierte physische Pixel-Test bestand in 15,045 Sekunden: vollständige Synchronisierung in 12,4 Sekunden, `transportStarts=1`, `consecutiveFailures=0`, Rebase exakt auf `Tip - 1`, kein Transport-Discard und kein alter `wallet is not initialized`-Fehler.
- 72 Core-/Coordinator-Vertragstests und 76 React-Native-Status-/Wallet-Tests bestehen; ESLint ist fehlerfrei.
- Die erneute Desktop-Prüfung besteht mit 22 Wallet-Sync- und 80 Paritäts-Vertragstests. Ein veralteter Test erwartete noch den allgemeinen Text `Checking spend outputs`; er prüft jetzt die bewusst konkretere Ledger-Anweisung, ohne das Laufzeitverhalten zu ändern.
- Der nachfolgende UI-Build kompiliert vollständig. Die Installation des separaten Testpakets konnte nicht beginnen, weil der Pixel während des Builds die ADB-Verbindung verlor; die Produkt-App wurde dabei nicht verändert.

## 1. Beobachteter Fehler

Der Screenshot zeigt `Retrying node connection` bei 99,6 % und 15.516 verbleibenden Blöcken. Die ADB-Diagnose beweist jedoch:

- Ein Blockpaket mit 256 Blöcken wurde erfolgreich geladen.
- Danach tritt immer derselbe Fehler auf: Fingerprint `16194673465541041915`, Länge 56.
- Die App klassifiziert ihn pauschal als `node-unreachable`.
- Anschließend verwirft sie den Transport und verbindet sich neu.
- `transportStarts` steigt fortlaufend von 15 bis mindestens 34.
- Bei den Wiederholungen kommen die Blöcke in 0 ms aus dem lokalen `replay-cache`. Der Node ist dabei nicht die Fehlerquelle.
- Der Cursor bleibt bei Block 3.761.394 hängen, obwohl bereits bis 3.765.594 geladen wurde.

**Ergebnis:** Der Node bricht nicht ständig ab. Nach einem erfolgreichen Download entsteht ein lokaler Fehler. Die App beschuldigt fälschlich den Node, verwirft eine funktionierende Verbindung und läuft in eine Reconnect-Endlosschleife.

## 2. Warum sich Blöcke beziehungsweise „Slots“ ändern

Es gibt drei Werte, die derzeit vermischt wirken:

1. **Verbleibende Blöcke:** Zielhöhe minus niedrigster bestätigter Wallet-Cursor. Der Wert darf langsam steigen, wenn ein neuer Block entsteht, aber niemals ohne erklärten Grund tausende Blöcke zurückspringen.
2. **Batch-Größe:** Anzahl der pro Anfrage geladenen Blöcke. Sie darf sich dynamisch an Latenz, Paketgröße und Fehler anpassen.
3. **Worker-Slots:** Parallele lokale Scan-Arbeiter. Sie dürfen sich entsprechend Gerätelast und Warteschlange ändern.

Die aktuelle Reconnect-Schleife setzt Transportzustand und Berechnungsgrundlagen wiederholt neu. Dadurch können Werte springen oder scheinbar wechseln. Künftig muss jede Änderung mit `vorher`, `nachher` und einem eindeutigen Grund protokolliert werden. Eine dynamische Anpassung bleibt erlaubt; ein stilles oder zufälliges Umschalten nicht.

## 3. Fehler bei einer neuen Software-Wallet

Eine gerade neu erzeugte Wallet darf keine historische Vergangenheit durchsuchen. Erwartung: Start am authentifizierten aktuellen Chain-Tip mit höchstens einem Sicherheitsblock.

Die alten Logs zeigten:

- `refreshFromHeight = 3.760.882`
- aktuelles Ziel ungefähr `3.779.596`
- dadurch wurden rund 18.700 vermeintlich verbleibende Blöcke angezeigt.

Monero Core trägt diesen einen Monat alten Wert beim Erstellen als vorsichtigen Offline-Bootstrap ein. Der korrigierte Ablauf scannt ihn nicht privat: Das erste öffentliche Paket authentifiziert den echten Tip, danach wird die leere neue Wallet vor dem ersten privaten Scan exakt auf `Tip - 1` gesetzt. Solange dieser Tip noch unbekannt ist, zeigen Android und Desktop den provisorischen Monatswert nicht mehr als echte Wallet-Arbeit an. Ist bereits ein authentifizierter Tip vorhanden, überschreibt er den Core-Bootstrap sofort.

Der Code versucht zwar nach dem ersten authentifizierten Tip auf `Tip - 1` umzuschalten, verwendet dafür aber `rescanBlockchain()`. Dieser Weg benötigt einen synchronisierten Daemon. Beim Shared-Sync ist absichtlich kein Daemon an der Wallet angebunden. Deshalb wird der lokale Cache nicht zuverlässig neu aufgesetzt.

Im selben Core existiert bereits der dafür vorgesehene lokale Weg `resetBlockchainCacheForSharedSync()`. Die Ledger-Neuaufsetzung verwendet ihn bereits und dokumentiert ausdrücklich, warum `rescanBlockchain()` hier ungeeignet ist.

**Verifizierter gemeinsamer Ursprung:** Der fehlerhafte Fresh-Wallet-Reset löst direkt nach einem erfolgreich geladenen Paket `networkSync.rescanFreshWallet: wallet is not initialized` aus. Die grobe Fehlerklassifikation deutete diesen lokalen Fehler anschließend fälschlich als Node-Ausfall und startete den Transport neu.

## 4. Zielverhalten

- Neue Software-Wallet: Start bei aktuellem Tip minus maximal einem Sicherheitsblock.
- Restore-Wallet: Scan ab dem vom Benutzer gewählten Datum beziehungsweise Restore-Height.
- Ledger-Wallet: unverändertes, eigenes Restore-Verhalten.
- Ein lokaler Scan-, Cache- oder Wallet-Fehler darf niemals als Node-Ausfall klassifiziert werden.
- Eine funktionierende Verbindung darf nur bei einem belegten Transportfehler verworfen werden.
- Der Download-Cursor muss monoton vorwärts laufen. Rücksprünge sind nur mit einem expliziten, protokollierten Replay-Grund zulässig.
- Dynamische Batch-Größe und Worker-Slots bleiben erhalten, müssen aber messwertbasiert, begrenzt und nachvollziehbar sein.

## 5. Umfassendes, datenschutzsicheres Logging

### Gemeinsame Korrelation

Jeder Ablauf erhält:

- `syncSessionId`
- `iterationId`
- `transportId`
- `batchId`
- maskierte, nur innerhalb der Sitzung gültige `walletId`
- Wallet-Typ: neu, wiederhergestellt oder Ledger

Damit lässt sich ein Vorgang durch React Native, JNI, C++, Wallet Core und Transport lückenlos verfolgen.

### Exakte Phasen

Jede Phase protokolliert Start, Erfolg, Fehler und Dauer:

- Provider auswählen
- Transport öffnen
- Blockpaket anfordern
- Blockpaket empfangen
- Paket validieren
- Replay-Cache schreiben/lesen
- Fresh-Wallet auf Tip setzen
- lokalen Wallet-Cache zurücksetzen
- Paket an Wallet-Scanner übergeben
- Wallet scannen
- Cursor festschreiben
- Mempool prüfen
- Checkpoint speichern

Die derzeitige Sammelphase `fetching-blocks` ist zu grob: Im aktuellen Fehler ist der Fetch bereits erfolgreich, trotzdem wird anschließend genau diese Phase als fehlgeschlagen gemeldet.

### Pflichtfelder je Batch

- Cursor vor und nach dem Vorgang
- authentifizierte Zielhöhe
- verbleibende Blöcke
- Batch-Größe vorher und nachher
- Quelle: Netzwerk oder Replay-Cache
- Nutzdatenbytes und Netzwerkbytes
- Download-, Warte-, Validierungs- und Scanzeit
- aktive/konfigurierte Worker-Slots
- Warteschlangentiefe und Backpressure
- Grund jeder Slot- oder Batch-Änderung
- Anzahl Transportstarts und Reconnects

### Fehlerklassifikation am Entstehungsort

Keine nachträgliche Vermutung anhand eines Fehlertexts. Jeder Throw-Punkt liefert einen stabilen Code, zum Beispiel:

- `transport-connect-failed`
- `transport-read-timeout`
- `batch-validation-failed`
- `fresh-wallet-rebase-failed`
- `local-cache-reset-failed`
- `wallet-scan-failed`
- `checkpoint-failed`

Zusätzlich:

- `transportHealthy`
- `discardTransport`
- `discardReason`
- `sameFailureCount`
- `nextRetryAt`

Nur echte Transportfehler dürfen `discardTransport=true` setzen.

### Speicherung und Export

- Rotierende lokale JSONL-Dateien, maximal 10 MB insgesamt.
- Letzte Diagnoseereignisse zusätzlich in einem Ringpuffer sichern.
- Persistenz auch nach Absturz oder App-Neustart.
- Menüpunkt **Diagnosebericht exportieren**.
- Entwicklungsbuilds spiegeln die Ereignisse weiterhin in ADB.
- Keine Seeds, privaten Schlüssel, vollständigen Adressen, Beträge, Zugangsdaten oder vollständigen Node-URLs protokollieren.
- Freie Fehlermeldungen nur redigiert; bevorzugt stabile Fehlercodes und freigegebene Felder.

## 6. Umsetzungsreihenfolge

1. **Reproduktion festhalten:** aktuelles Fehlerszenario als automatisierten Regressionstest konservieren.
2. **Diagnose präzisieren:** Subphasen und Fehlercodes ergänzen, damit der exakte Throw-Punkt sichtbar wird.
3. **Fehlerdomänen trennen:** lokale Wallet-/Cache-/Scanfehler dürfen den Transport nicht mehr verwerfen.
4. **Fresh-Wallet korrigieren:** nach authentifiziertem Tip den lokalen Shared-Sync-Reset verwenden und das Ergebnis vor dem Scan validieren.
5. **Cursor-Regeln absichern:** monotone Übergänge und erklärtes Replay erzwingen.
6. **Dynamik transparent machen:** Batch-Größe und Worker-Slots anhand realer Messwerte anpassen und jede Änderung protokollieren.
7. **Diagnoseexport ergänzen:** denselben Bericht für Android und Desktop bereitstellen.

## 7. Abnahmekriterien

- Eine neue Software-Wallet zeigt höchstens einen verbleibenden historischen Block.
- Mindestens 100 aufeinanderfolgende erfolgreiche Batches ohne unnötigen Transport-Neustart.
- `transportStarts` bleibt während einer gesunden Synchronisierung konstant.
- Nach erfolgreichem Batch-Fetch führt ein absichtlich erzeugter lokaler Resetfehler nicht zu `node-unreachable`.
- Kein Cursor-Rücksprung ohne protokollierten Replay-Grund.
- Adaptive Batch-Größe darf wachsen und schrumpfen; sie wird nicht pauschal auf 64 gesetzt.
- Jeder Slot- oder Batch-Wechsel enthält Messwert und Grund.
- Ein absichtlich unterbrochener Node erzeugt einen eindeutig anderen Fehler als ein lokaler Wallet-Fehler.
- Diagnoseexport enthält die komplette Ereigniskette, aber keine geheimen oder personenbezogenen Wallet-Daten.
- Android und Desktop verwenden dieselben Status- und Fehlerbegriffe.

## Noch ausstehende Endabnahme

- Jüngsten, bereits gebauten Teststand nach erneuter ADB-Verbindung noch einmal auf dem Pixel ausführen.
- Separaten 100-Batch-Dauertest ohne Transport-Neustart durchführen.
- Erst danach Produkt-APK bauen und installieren; die aktuell installierte Produkt-App enthält noch den alten Fehler.

## Definition of Done

Der Fehler gilt erst als behoben, wenn eine neu erstellte Wallet am aktuellen Tip startet, der bestehende Testfall ohne Reconnect-Schleife bis 100 % synchronisiert und der exportierte Diagnosebericht zweifelsfrei zeigt, welcher Layer jeden Fehler ausgelöst und warum die App darauf reagiert hat.
