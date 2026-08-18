# XMRig gegen MFW-Miner: Hardwarebilanz

Stand: 2026-08-16

Alle aufgeführten Läufe sind `rx/0` Fast, vollständig offline, ohne Pool,
Share-Submit, Donation, MSR-Schreiben oder Dienststopp. Jeder gewertete Lauf
bestand den fest erwarteten RandomX-Hash. Die Differenz ist
`MFW / XMRig - 1`.

## Ergebnis

| Hardware | Konfiguration | XMRig | MFW-Miner | Differenz | Entscheidung |
|---|---|---:|---:|---:|---|
| Apple M4 | 10 Threads, 100K, A-B-B-A | **4.117,60 H/s** | **4.120,55 H/s** | **+0,0716 %** | technisch Gleichstand; MFW knapp vorn |
| Apple M1 MacBook Air | 8 Threads, 100K, A-B-B-A | **1.012,30 H/s** | **1.012,65 H/s** | **+0,0346 %** | Gleichstand |
| Intel Xeon E3-1585L v5 | 7 Threads, 250K, A-B-B-A | **2.368,85 H/s** | **2.357,35 H/s** | **-0,4855 %** | XMRig bleibt vorn |
| AMD EPYC 9634 KVM | 12 Threads, 250K, älterer A-B-B-A | **5.166,60 H/s** | **5.157,65 H/s** | **-0,1732 %** | nur provisorisch; XMRig-Kontrollstreuung 3,20 % |

Die Apple-Differenzen sind kleiner als ein Promille und deshalb keine
belastbare Aussage, dass MFW insgesamt schneller als XMRig ist. Der wichtige
Fortschritt ist: MFW erreicht dort nun Parität, und der M4-JIT enthält erstmals
eine gemessene, pro Chip ausgewählte Optimierung.

## Einzelwerte und Streuung

| Hardware/Rolle | Einzelwerte in H/s | Mittel | Range/Mittel |
|---|---|---:|---:|
| M4 XMRig | 4.119,1 / 4.116,1 | 4.117,60 | 0,0729 % |
| M4 MFW | 4.123,2 / 4.117,9 | 4.120,55 | 0,1286 % |
| M1 XMRig | 1.014,9 / 1.009,7 | 1.012,30 | 0,5137 % |
| M1 MFW | 1.013,3 / 1.012,0 | 1.012,65 | 0,1284 % |
| Xeon XMRig | 2.390,3 / 2.347,4 | 2.368,85 | 1,8110 % |
| Xeon MFW | 2.357,4 / 2.357,3 | 2.357,35 | 0,0042 % |
| EPYC XMRig, provisorisch | 5.249,2 / 5.084,0 | 5.166,60 | 3,1975 % |
| EPYC MFW, provisorisch | 5.151,9 / 5.163,4 | 5.157,65 | 0,2230 % |

## Architekturentscheidungen

### Apple M4 und M1

Der Korpus-Profiler identifizierte `CBRANCH` als heißeste exakt zuordenbare
AArch64-JIT-Instruktion: 72,509 % der gemappten M4- und 51,962 % der
gemappten M1-Samples.

Der getestete Kandidat ersetzt nur `TST xDst, mask` durch das bitgleiche
`TST wDst, mask`. Instruktionszahl, Codegröße, alle folgenden Adressen und der
Rücksprung bleiben identisch.

- M4, 4 Threads, zwei Gegenblöcke: Referenz 2.679,175 H/s, Kandidat
  2.686,925 H/s, zusammen **+0,2893 %**. Beide Reihenfolgen waren positiv.
- M1, 4 Threads: Referenz 781,50 H/s, Kandidat 779,75 H/s,
  **-0,2239 %**. Der Kandidat wird auf M1 nicht verwendet.
- Der Produktionsmodus `MFW_A64_CBRANCH_MODE=2` erkennt Apple M4 zur Laufzeit,
  wählt dort die 32-Bit-Form und fällt auf M1 sowie unbekannten AArch64-CPUs
  zur unveränderten 64-Bit-Form zurück.
- Dieselbe automatische Logik bestand auf M4 und M1 jeweils RandomX v1/v2
  mit 64 Programmen. Auf M4 waren 4.031/4.031 CBRANCHes die 32-Bit-Form, auf
  M1 4.031/4.031 die 64-Bit-Referenzform.

Die maximale gemessene M1-Topologie verwendet 8 Threads: 1.012,9 H/s im
kalten MFW-Screen gegenüber 781,5 H/s mit 4 Threads, also rund 29,6 % mehr
Gesamtleistung.

### Intel Skylake-S

Der `ISWAP_R`-Kandidat (`XCHG` gegen drei `MOV`) bestand alle Hashes. Im
stabileren warmen Gegenblock lag Mode 0 bei 2.373,60 H/s und Mode 1 bei
2.371,65 H/s, also **-0,0822 %**. Er bleibt aus. Der direkte XMRig/MFW-Block
zeigt MFW noch **0,4855 %** hinter XMRig.

### EPYC 9634

Der neue Versuch vom 2026-08-16 wird vollständig ausgeschlossen. Er begann
bei 96-98 % Idle, aber die produktive VM sprang während/nach dem Block auf
Load 12,87-13,39 und 16-26 % Idle. XMRig lag bei 2.732,4/2.691,0 H/s; MFW bei
3.245,5/2.677,8 H/s. Die MFW-Streuung von 19,17 % macht den Rohmittelwert
unbrauchbar. Alle 38 vorher aktiven Container blieben aktiv; es wurde kein
Dienst gestoppt. Bis zu einem isolierten Wartungsfenster bleibt daher der
ältere, ebenfalls nur provisorische 5,17-kH/s-Block in der Tabelle.

## Binär- und Referenzgrenze

- Apple: XMRig-6.26.0-JIT mit identischer Apple-QoS-Bauweise und Toolchain auf
  beiden Seiten. XMRig-SHA vor der lokalen dylib-Anpassung:
  `3c36c5c7c07aaa530323583d707b441dd8e967742c36061b9b016e7645b3b08f`.
- M4 gemessener erzwungener Kandidat:
  `8368e43d8c5d1c1819e474dbe27b9dbac2b496b43bf7cfbe0d3c5ea0c11acaa9`.
- Automatischer, profiler-freier Produktionsbuild:
  `0c3919c39e46be5cbb86a222e22969ed12e4dfed11e3981342d98ea31449c17d`.
- Xeon XMRig/MFW:
  `c584bbe4fc53640a2bb76b7211b7587f2a7885b8b9a8c9b7ebf1ae0fbd2bfabf` /
  `2dcd27b0d71186695402c7ebf05d6f37dcef955ecea9e05b47a85a880c66925b`.
- EPYC XMRig/MFW:
  `b20f39fc00d242e706b6c30367ad811c676e0575050a4ec2f30104b696944b49` /
  `eeb406ce25378dd8bc5ea2e636b162271f037d7cd44e1399a5479fe65f08f2c3`.

## Rohbelege

- M4 CBRANCH:
  `benchmark-results/m4-a64-cbranch-w32-abba-20260816/` und
  `benchmark-results/m4-a64-cbranch-w32-baab-20260816/`.
- M4 final:
  `benchmark-results/m4-final-xmrig-vs-mfw-w32-10t-20260816/`.
- M1 CBRANCH und final:
  `benchmark-results/m1-a64-cbranch-w32-abba-20260816/` und
  `benchmark-results/m1-final-xmrig-vs-mfw-8t-20260816/`.
- Xeon:
  `benchmark-results/hosts/fork-new-skylake-final-20260816/`.
- EPYC ausgeschlossener neuer Block:
  `benchmark-results/hosts/tex8-epyc9634-final-20260816/`.
- Automatische M4/M1-Korpusbelege:
  `benchmark-results/jit-corpus/a64-cbranch-auto-*-natural-v1-v2-64.*`.

Jedes dieser Ergebnisverzeichnisse enthält ein lokal erfolgreich geprüftes
SHA-256-Manifest. Am Ende lief auf keinem Host ein Minerprozess; auf TEX8
liefen weiterhin alle 38 zuvor aktiven Container.
