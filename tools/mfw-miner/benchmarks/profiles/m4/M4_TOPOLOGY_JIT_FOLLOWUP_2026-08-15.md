# Apple M4: Topologie- und JIT-Folgetest

Stand: 2026-08-15, laufende Untersuchung

## Ziel und Sicherheitsrahmen

Dieser Block trennt drei M4-Betriebsprofile:

1. vier Worker mit `QOS_CLASS_USER_INTERACTIVE` als P-Core-Bias;
2. sechs Worker mit Prozess-QoS-Clamp `background` als E-Core-Bias;
3. zehn Worker mit unverändertem Scheduling als gemischtes Vollchipprofil.

Jeder Miner-Lauf ist ein Offline-`rx/0`-Benchmark in Fast Mode. Die macOS-
Sandbox sperrt sämtlichen Netzwerkzugriff; es werden keine Pool- oder
Daemon-Endpunkte verwendet. XMRig 6.26.0, Commit
`b2ca72480c58d197e18c885d9fc1a0c8d517e60a`, ist die verpflichtende
Referenz. Ein Ergebnis ohne passende XMRig-Kontrolle ist nur explorativ.

macOS stellt unprivilegiert keine harte P-/E-Core-Pinnung bereit. Der Darwin-
Header beschreibt `THREAD_AFFINITY_POLICY` lediglich als experimentellen
Hinweis, Threads nach Möglichkeit in einem gemeinsamen L2-Cache zu platzieren.
QoS ist reproduzierbar kontrollierbar, die konkrete Coreklasse jedoch nicht
beweisbar. Deshalb heißen die Profile bewusst **P-biased**, **E-biased** und
**mixed**, nicht P-/E-isoliert.

Die beobachteten Thread-Prioritäten bestätigen die Policy-Ebene:

- User-Interactive: `PRI 31`, vier Worker bei praktisch 100% CPU;
- `taskpolicy -c background`: `PRI 4`, `NI 5` im passiven Kontrollprozess.

Das belegt die QoS-Konfiguration, aber nicht den jeweils ausgeführten Kern.

## Korrigierter test-only AArch64-JIT-Kandidat

Der bisherige `MFW_A64_GROUP_E_MODE=2` sollte den ursprünglichen Startoffset
des generierten VM-Codes bewahren. Statische Objektanalyse zeigte einen
Off-by-one-Instruktionsfehler:

- der korrigierte BIF-Maskenprolog benötigt `mov+dup` statt eines einzelnen
  `movi`: **+1 Instruktion**;
- vier BIF ersetzen acht AND/ORR im heißen Loop: **-4 Instruktionen**;
- vier Prolog-NOPs ergaben daher netto **+1 Instruktion / +4 Byte** bis zum
  VM-Code, statt den Offset zu bewahren.

Der getestete Korrekturkandidat verwendete drei nur einmal ausgeführte
Prolog-NOPs. Mode 0 und damit der Standard-/generische ARM-Fallback blieben
unverändert. Die statisch verifizierten Symbole des Testartefakts waren:

| Objekt | Mainloop-Start | VM-Code-Start |
|---|---:|---:|
| XMRig-Form, Mode 0 | `0xbc` | `0x170` |
| BIF plus drei Prolog-NOPs, Mode 2 | `0xcc` | `0x170` |

Der Kandidat bleibt test-only und standardmäßig deaktiviert. Durch dynamisch
erzeugte `FDIV`-Instruktionen können spätere Adressen innerhalb eines Programms
weiterhin auseinanderlaufen; die Tabelle belegt nur den identischen initialen
VM-Code-Start.

Nach dem negativen kalten A-B-B-A-Block wurde die Drei-NOP-Variante als
Performancekandidat verworfen. Sie bleibt ausschließlich als reproduzierbarer,
standardmäßig deaktivierter und klar `rejected-on-M4` markierter Testmodus im
Baum. Die bekannte falsche Vier-NOP-Form wird nicht wiederhergestellt. Die
unten angegebenen unveränderlichen Binär-Hashes identifizieren exakt die
getesteten Drei-NOP-Artefakte.

Binärartefakte:

- Default-QoS-Kandidat: SHA-256
  `168016c46e9ce1d3d0e478ce845f663e3a83d99442dd697ec61bf0e5d7823274`;
- User-Interactive-Kandidat: SHA-256
  `9ebe64c0c9b3ea0a948b8390805ceda2cfda144f63aef7fd32e8730f39cfe9b7`;
- XMRig-UI-Referenz: SHA-256
  `3c36c5c7c07aaa530323583d707b441dd8e967742c36061b9b016e7645b3b08f`.

## Kalter 4-Worker-P-biased-Block

Vor dem Opening-Run lagen mehr als 30 Minuten seit dem vorherigen heißen
Minerblock und über 20 Minuten seit dem kurzen Kandidatenbuild. Wiederkehrende
Spitzen von Spotlight und WLAN-Treiber hielten das Gate zunächst geschlossen;
kein fremder Prozess wurde beendet. Der XMRig-Opening-Run bestand das definierte
kalte Band klar mit 2.590,5 H/s.

Reihenfolge: A-B-B-A, 45 Sekunden passive Pause zwischen den Läufen, 100K.

| Lauf | Variante | H/s | Hash | Exit |
|---|---|---:|---|---:|
| A1 | XMRig 6.26.0 UI/P-biased | 2.590,5 | `BC4EF98B60B98579` | 0 |
| B1 | MFW Mode 2, korrigierter VM-Start, UI/P-biased | 2.545,6 | `BC4EF98B60B98579` | 0 |
| B2 | MFW Mode 2, korrigierter VM-Start, UI/P-biased | 2.525,3 | `BC4EF98B60B98579` | 0 |
| A2 | XMRig 6.26.0 UI/P-biased | 2.553,9 | `BC4EF98B60B98579` | 0 |

| Kennzahl | Wert |
|---|---:|
| XMRig-Mittel | 2.572,20 H/s |
| MFW-Kandidatenmittel | 2.535,45 H/s |
| Kandidat relativ | **-1,4287%** |
| gepaarte geometrische Schätzung | **-1,4270%** |
| Kontrolldrift A1 zu A2 | -1,4129% |

Der korrigierte Kandidat ist in diesem kalten Block langsamer und wird nicht
promotet.

## B-A-A-B-Gegenordnung: wegen Parallel-CPU-Last ausgeschlossen

Nach mehr als einer Stunde passiver Pause begann die Gegenordnung kalt. Die
ersten drei Läufe waren:

| Lauf | Variante | H/s | Hash | Status |
|---|---|---:|---|---|
| B3 | MFW Mode 2, korrigierter VM-Start, UI/P-biased | 2.626,8 | `BC4EF98B60B98579` | korrekt |
| A3 | XMRig 6.26.0 UI/P-biased | 2.537,2 | `BC4EF98B60B98579` | korrekt |
| A4 | XMRig 6.26.0 UI/P-biased | 2.180,7 | `BC4EF98B60B98579` | Performance ausgeschlossen |

A4 verlor gegenüber A3 14,05%. Zeitgleich lief aus einer parallelen Aufgabe
ein `find` über `/Volumes/4TB` mit ungefähr 38-55% CPU; unmittelbar danach war
zusätzlich ein Java-Prozess mit über vier belegten Kernen sichtbar. Load 1 lag
bei 3,87. Der B4-Lauf wurde deshalb nicht mehr gestartet: Er hätte den bereits
ungültigen Block nur weiter aufgeheizt.

Die Gegenordnung belegt keinen Performancegewinn. Für die Entscheidung bleibt
der vollständige kalte A-B-B-A-Block maßgeblich. Mit -1,43% ist der
Drei-NOP-Kandidat verworfen; es erfolgt keine weitere blinde Wiederholung.

## Offene Gates

- matched XMRig/MFW-Blöcke für sechs E-biased und zehn mixed Worker;
- ein neuer, unabhängiger AArch64-JIT-Kandidat erst nach vollständig beendetem
  Fremdbuild und langem Cooldown; Mode 2 erhält keine weitere M4-Validierung;
- keine Performanceaussage aus einem Block mit deutlicher thermischer oder
  externer Lastdrift.

Rohdaten liegen unter
`benchmark-results/m4-topology-jit-exact-vmstart-20260815/`.

## Neuer Einzelkandidat: Front-end-Load-Scheduling

Nach der Mode-2-Entscheidung wurde genau ein unabhängiger M4-spezifischer
Hotpath-Kandidat vorbereitet. `MFW_A64_FE_LOAD_SCHEDULE=1` zieht die vier
voneinander unabhängigen 128-Bit-Scratchpad-Loads (`q17`, `q19`, `q21`,
`q23`) vor die vier Integer-zu-Float-Konvertierungsketten. Die Hypothese ist,
dass der M4 dadurch mehrere Load-Misses bzw. Load-use-Latenzen besser
überlappen kann. Der Defaultwert ist `0`; der unveränderte Pfad behält die
upstream-artige Load/Conversion-Verzahnung. Der Kandidat ändert weder x86-Code
noch den generischen ARM-Defaultpfad.

Statische Objektprüfung vor dem ersten Lauf:

| Objekt | Mainloop-Start | VM-Code-Start | VM-Code-Ende |
|---|---:|---:|---:|
| Default, Schedule 0 | `0xbc` | `0x170` | `0x62d0` |
| Test, Schedule 1 | `0xbc` | `0x170` | `0x62d0` |

Das Testartefakt wurde mit `MFW_A64_GROUP_E_MODE=0`,
`MFW_A64_DATASET_PREFETCH=1`, `MFW_APPLE_WORKER_QOS=1` und
`MFW_A64_FE_LOAD_SCHEDULE=1` gebaut. SHA-256:
`45024bd8202cff3d96632fc67b0adc0e2df18c7efdd7e3b7e10cee42b1569cc9`.
Die gematchte XMRig-6.26.0-UI-Referenz bleibt
`3c36c5c7c07aaa530323583d707b441dd8e967742c36061b9b016e7645b3b08f`.

Der Build endete gegen 20:30 EST. Unmittelbar danach lag Load 1 bei 4,16;
deshalb blieb das Cooldown-Gate geschlossen. Ein Benchmark beginnt erst nach
langer passiver Abkühlung, mehreren ruhigen Fremdlast-Samples und einem
XMRig-Opening-Run im kalten Leistungsband. Die Resultate und die
Promote/Reject-Entscheidung werden hier ergänzt.

### Erster Blockversuch: durch neuen Gradle-Lauf ausgeschlossen

Nach wiederholten Unterbrechungen durch Android-NDK-Build, Spotlight,
Apple-Neural-Engine-Dienst und einen Git-Transfer bestand das Gate um 21:45
EST: Load 1 fiel auf 1,17 und drei Folgesamples zeigten 97,65-98,89% Idle.
Der Opening-Run bestätigte mit 2.689,8 H/s das kalte Leistungsband.

| Lauf | Variante | H/s | Hash | Status |
|---|---|---:|---|---|
| A1 | XMRig 6.26.0 UI, vier Worker | 2.689,8 | `BC4EF98B60B98579` | gültiger kalter Opening-Run |
| B1 | MFW FE-Load-Schedule UI, vier Worker | 2.373,8 | `BC4EF98B60B98579` | Performance ausgeschlossen |

B1 lief von 21:47:48 bis 21:48:34 EST. Ungefähr um 21:48:17, also mitten im
Benchmark, startete ein neuer Gradle-Dependency-/Verification-Lauf aus dem
Mobile-Repository. Sein Gradle-Daemon hatte unmittelbar nach B1 bereits etwa
40 Sekunden Laufzeit, 206 Threads und 15-35% CPU; parallel erreichte
`mds_stores` 31% CPU. Damit ist der starke B1-Einbruch nicht dem Kandidaten
zurechenbar. B2 wurde nicht gestartet. Dieser unvollständige A-B-Versuch ist
weder A-B-B-A noch eine Performanceaussage und darf nicht promotet werden.

Rohdaten dieses ausgeschlossenen Versuchs liegen unter
`benchmark-results/m4-fe-load-schedule-20260815/`. Ein neuer Block erfordert
das Ende der Fremdlast und einen vollständigen erneuten Cooldown.

Der Block wurde danach bewusst beendet, ohne B2 oder weitere Minerlast zu
starten. Damit bleibt der FE-Load-Schedule-Kandidat **unentschieden**, wird
nicht promotet und bleibt standardmäßig deaktiviert. Ein vollständiger
A-B-B-A- plus B-A-A-B-Nachweis ist auf ein späteres, nachweislich ruhiges
Fenster vertagt.
