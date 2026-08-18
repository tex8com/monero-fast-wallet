# RandomX-Engine-Patchkandidaten für Apple M4 und EPYC 9634

Stand: 2026-08-15  
Status: Source-Analyse, keine Engine-Änderung und kein Benchmarklauf

## Ergebnis in Kurzform

Für den Apple M4 ist der erste Patch kein Experiment, sondern ein notwendiger
Upstream-Backport: XMRigs eingebetteter ARM64-JIT enthält weder die seltene
`ISUB_R`-Korrektur noch die bereits mit ungefähr 0,9 Prozent auf einem M1 Pro
belegte Group-E-`BIF`-Optimierung aus RandomX 2.0.1. Danach sind ein
M4-spezifischer JIT-Prefetch-Selector und die 128-Byte-AES-Prefetch-Kadenz die
besten kleinen Steady-State-Experimente. NEON-Blake2b ist realer fehlender
Code, aber wegen des kleinen Nicht-JIT-Anteils nur nach Profiling zu bauen. Ein
mehrfach interleavender ARM64-Dataset-Initializer kann den Seed-Wechsel
verkürzen, erhöht aber nicht automatisch H/s.

Für den EPYC 9634 ist zuerst die falsche Zen-4-Erkennung in XMRig 6.26.0 zu
reparieren. Family 19h/Model 11h wird aktuell als Zen 3 behandelt. Danach sind
eine AVX-512VL-Group-E-Codeform und ein gemessener AES-NI/VAES-512-Selector die
beiden ernsthaften Steady-State-Kandidaten. NUMA-lokale Dataset-Initialisierung
und ein Verbot des stillen Remote-Dataset-Fallbacks sind für Bare-Metal-EPYC
wichtig, können auf dem aktuellen TEX8-KVM-Gast mit einem virtuellen
NUMA-Knoten aber nicht belegt werden.

Keiner der folgenden Erwartungswerte ist ein Ergebnis. Jeder Performancepatch
bleibt eine Hypothese, bis ein korrekter, thermisch und topologisch kontrollierter
ABBA/BAAB-Lauf ihn bestätigt.

## Untersuchte Provenienz

- XMRig `v6.26.0`, Commit
  `b2ca72480c58d197e18c885d9fc1a0c8d517e60a`, sauberer lokaler Source-Clone
  unter `tools/xmrig-cpu-testbench/.work/m4/xmrig-v6.26.0`.
- RandomX-Upstream `v2.0.1`, Commit
  `aaafe716b4f8855186c5069b9212863686732a1e`, sowie der lokale aktuelle
  Upstream-Stand `7c761cf007c758056dcb6eb438a32f780f81bdbd`.
- Bisherige Ergebnisse und verworfene Varianten aus
  `docs/XMRIG_M4_OPTIMIZATION_2026-08-15.md`,
  `docs/XMRIG_CPU_OPTIMIZATION_2026-07-29.md` und
  `tools/xmrig-cpu-testbench/README.md`.
- Aktueller TEX8-Hostbefund aus
  `MFW-Miner/benchmarks/hosts/community-tex8-2026-08-15.md`.

## Apple M4: priorisierte Engine-Patches

### M4-1 — RandomX-2.0.1-ARM64-Backport als unteilbares P0-Gate

**Exakte Stellen**

- `src/crypto/randomx/jit_compiler_a64.cpp`:
  `JitCompilerA64::h_ISUB_R` und `JitCompilerA64::h_FDIV_M`.
- `src/crypto/randomx/jit_compiler_a64_static.S`:
  `randomx_program_aarch64`, insbesondere Group-E-Maske und die vier
  Group-E-Konvertierungen im Hauptloop.
- Conformance-Test entsprechend Upstream `src/tests/tests.cpp`, speziell
  `ISUB_R`, wenn `src == dst` und `imm == 0x80000000`.

**Patchform**

1. Backport von RandomX-Commit
   [`0dea273`](https://github.com/tevador/RandomX/commit/0dea2735241523a424dab3f46dc1741f039b37b9):
   `0x80000000` nicht als negiertes 32-Bit-Immediate behandeln, sondern den
   Wert explizit bilden und addieren.
2. Backport von RandomX-Commit
   [`9fbab826`](https://github.com/tevador/RandomX/commit/9fbab826dac40449308c62725b777d0136c99575):
   Group-E-Maske von `0x00ffffffffffffff` auf
   `0x00ffffffffc00000` ändern und `AND` plus `ORR` jeweils durch ein `BIF`
   ersetzen.

**Erwartete Wirkung**

- Die `ISUB_R`-Änderung ist ein Korrektheitsfix, kein Speedpatch. Ohne ihn
  kann der ARM-JIT extrem selten einen falschen Hash erzeugen.
- Der Upstream-Autor meldet für die Group-E-Codeform ungefähr **+0,9 % auf
  einem Apple M1 Pro**. Das ist die einzige hier vorhandene primär belegte
  ARM-Performancezahl; M4 muss separat gemessen werden.

**Risiken und Gate**

- Falsch gepatchte Maske verändert Hashes. Beide Änderungen gemeinsam gegen
  RandomX-Tests, den neuen `ISUB_R`-Randfall und XMRigs offiziellen
  `250K`-Hash `7D6054757BB08A63` prüfen.
- Erst dieser korrekte Stand wird MFW-Baseline. Alte ARM-Ergebnisse bleiben
  historisch, dürfen aber nicht gegen spätere Kandidaten gemischt werden.

### M4-2 — Laufzeitselektor für A64-Dataset- und Cache-Prefetch

**Exakte Stellen**

- `src/crypto/randomx/jit_compiler_a64_static.S`:
  `randomx_program_aarch64_vm_instructions_end`, derzeit festes
  `prfm pldl2strm, [x20]` für den nächsten Datasetzugriff.
- Dieselbe Datei: `randomx_calc_dataset_item_aarch64_prefetch`, derzeit festes
  `prfm pldl2strm, [x11]` für den RandomX-Cachezugriff beim Dataset-Aufbau.
- `src/crypto/randomx/jit_compiler_a64.cpp`:
  `JitCompilerA64::generateProgram` und
  `JitCompilerA64::generateSuperscalarHash`, die die statischen Templates
  kopieren und architekturspezifisch patchen können.
- `src/crypto/randomx/randomx.h` / `randomx.cpp`: getrennte interne Auswahl
  für Dataset- und Cache-Prefetch; nicht den x86-Scratchpad-Schalter
  zweckentfremden.

**Patchform**

Die PRFM-Instruktion beim Kopieren des JIT-Templates einmalig auf eine kleine,
explizite Menge patchen: `PLDL1KEEP`, `PLDL2KEEP`, bestehendes `PLDL2STRM` oder
kein Hint. Dataset und 256-MiB-RandomX-Cache erhalten getrennte Auswahlwerte.
Der Release-Default bleibt zunächst Upstream `PLDL2STRM`; automatische Auswahl
kommt erst nach reproduzierbarer Hostkalibrierung.

**Erwartete Wirkung**

Das betrifft direkt den dominanten JIT-/Speicherpfad. Ein kleiner positiver
Effekt ist plausibel, aber **0 % ist ebenso plausibel**, weil Apple-Hardware
Hints ignorieren oder bereits optimal umsetzen kann. Ein Zielkorridor von
0 bis ungefähr 2 % ist ein Screening-Rahmen, keine Prognose.

**Risiken und Gate**

- `KEEP` kann den kleinen gemeinsamen Cache mit Daten verschmutzen; `STRM`
  kann eine bald wiederverwendete Linie zu früh verdrängen.
- M4 hat 128-Byte-Cachelines, ein RandomX-Dataset-Item aber 64 Byte. Counter
  und H/s müssen deshalb zeigen, ob der zweite halbe Cacheline-Zugriff hilft
  oder stört.
- Nur ein Parameter pro ABBA-Block, 60-Minuten-Finalist und identische
  P-/E-Threadzahl. `USER_INTERACTIVE` darf nicht als versteckter Bestandteil
  des Produktpatches dienen.

Diese Untersuchung wiederholt **nicht** den abgelehnten Zen-3-x86-Test
`0003`: Dort wurden x86-`NTA`/`T0`/off verglichen. Hier geht es um zwei feste
AArch64-`PLDL2STRM`-Stellen, eine 128-Byte-Cacheline und eine andere
Cachehierarchie.

### M4-3 — 128-Byte-bewusste AES-Scratchpad-Prefetch-Kadenz

**Exakte Stellen**

- `src/crypto/randomx/aes_hash.cpp`:
  `hashAndFillAes1Rx4<0, 2>` im Hard-AES-Zweig. Der Loop verarbeitet 128 Byte,
  gibt aber `rx_prefetch_t0(prefetchPtr)` und zusätzlich
  `rx_prefetch_t0(prefetchPtr + 64)` aus.
- `src/crypto/randomx/intrin_portable.h` im `__aarch64__`-Abschnitt:
  `rx_prefetch_nta` und `rx_prefetch_t0` sind derzeit beide identisch als
  `prfm pldl1strm` implementiert.

**Patchform**

- AArch64-`T0` und Streaming semantisch trennen, zum Beispiel
  `PLDL1KEEP` versus `PLDL1STRM`, statt zwei gleich benannte Wrapper mit
  identischem Opcode zu behalten.
- Auf 128-Byte-Cacheline-Hosts zunächst nur einen Hint pro 128-Byte-Iteration
  ausgeben; 64-Byte-Hosts behalten zwei Hints. Cacheline-Größe beim Workerstart
  ermitteln und einmal einen Funktions-/Loopvariant wählen, niemals im Hotloop
  abfragen.
- Den bestehenden Abstand von 7168 Byte im ersten Experiment unverändert
  lassen. Erst wenn die Kadenz gewinnt, darf ein kleiner getrennter
  Distanztest folgen.

**Erwartete Wirkung**

Der Patch spart auf M4 einen vermutlich redundanten Hint und korrigiert die
irreführende T0-Semantik. Da das vorhandene Zen-3-Profil nur ungefähr 3,6 %
AES-Anteil zeigte, ist der gesamte H/s-Gewinn wahrscheinlich klein; **0 bis
etwa 0,5 %** ist ein vernünftiger Entscheidungsrahmen, nicht garantiert.

**Risiken und Gate**

- Apple kann beide 64-Byte-Adressen trotz 128-Byte-Linie intern sinnvoll
  behandeln; das Entfernen kann neutral oder negativ sein.
- Nicht gleichzeitig Unroll, Distanz und Hint ändern. Der generische
  Zen-3-Distanz-/Unroll-Sweep `0002`/`0006` war Rauschen und wird nicht
  wiederholt.
- ARM AES ist bereits hardwarebeschleunigt (`vaeseq_u8` plus `vaesmcq_u8`);
  ein bloßes Umbenennen zu „NEON AES“ ist kein neuer Optimierungspfad.

### M4-4 — NEON-Blake2b-Kompression mit sauberer Dispatch-Grenze

**Exakte Stellen**

- Neuer BSD-kompatibler AArch64-Pfad neben
  `src/crypto/randomx/blake2/blake2b_sse41.c` und
  `src/crypto/randomx/blake2/avx2/blake2b_avx2.c`, beispielsweise
  `src/crypto/randomx/blake2/neon/blake2b_neon.c`.
- `src/crypto/randomx/blake2/blake2.h`: Deklaration der NEON-Kompression.
- `src/crypto/rx/Rx.cpp`, `Rx::init`: AArch64-Dispatch von
  `rx_blake2b_compress_integer` auf den neuen Pfad.
- `cmake/randomx.cmake`: AArch64-spezifische Übersetzungseinheit; keine
  globalen `-mcpu=apple-m4`-Flags.

**Patchform**

Die zwölf Blake2b-Runden mit `uint64x2_t`-Paaren, NEON-Add/XOR und
`vsriq_n_u64`/`vshlq_n_u64`-Rotationen implementieren. Der Dispatcher wählt
einmalig beim Start. Scalar- und NEON-Pfad müssen bitidentisch sein; der neue
Code darf keine XMRig-GPL-Datei kopieren.

**Erwartete Wirkung**

XMRig wählt auf x86 SSE4.1/AVX2, lässt ARM aber im skalaren
`rx_blake2b_compress_integer`-Pfad. Das ist eine echte SIMD-Lücke. Der
Steady-State-Gesamtgewinn bleibt wegen des dominanten JIT-Anteils voraussichtlich
unter 1 %; zuerst muss ein M4-Profil überhaupt einen relevanten Blake2-Anteil
zeigen. Größer kann der Einfluss bei Cache-/Seed-Aufbau als bei laufender
Hashrate sein.

**Risiken und Gate**

- Lane-Shuffles und 64-Bit-Rotationen können Apples starken Scalar-Core
  neutralisieren. Bei weniger als 0,3 % reproduzierbarem Gesamtgewinn wird der
  Pfad nicht als M4-Default promoted.
- Alle Blake2b-Known-Answer-Tests, RandomX-Tests und der 250K-Endhash sind
  Pflicht. Eingabelängen und Final-Block-Fälle separat testen.

### M4-5 — Zwei Items interleavender ARM64-Dataset-Initializer

**Exakte Stellen**

- `src/crypto/randomx/jit_compiler_a64.cpp`:
  `JitCompilerA64::generateSuperscalarHash`.
- `src/crypto/randomx/jit_compiler_a64_static.S`:
  `randomx_calc_dataset_item_aarch64`,
  `randomx_calc_dataset_item_aarch64_prefetch`, Mix und Store.
- `src/crypto/randomx/dataset.cpp`: `initDataset`/`initDatasetItem` als
  Fallback und Resteverarbeitung.
- XMRig-Adapter `src/crypto/rx/RxDataset.cpp`:
  `init_dataset_wrapper` für gerade Itemblöcke plus korrekten Rest.

**Patchform**

Zwei unabhängige Dataset-Items in AArch64-GPR-Registern interleaven, damit die
abhängigen Superscalar-Ketten mehr Instruction-Level-Parallelism erhalten.
NEON ist hier nicht automatisch geeignet: RandomX benötigt unter anderem
64-Bit-High-Multiply, das scalar mit `umulh` direkt verfügbar ist. Ein
NEON-Ansatz darf nur nach getrenntem Mikrobenchmark folgen. Der bestehende
Ein-Item-Pfad bleibt für Rest und unbekannte ARM64-CPUs erhalten.

**Erwartete Wirkung**

Möglich ist ein kürzerer Aufbau des ungefähr 2-GiB-Datasets und damit ein
schnellerer Seed-Wechsel. **Keine direkte Steady-State-H/s-Steigerung** wird
behauptet. Der x86-AVX2-Fünf-Item-Pfad zeigt, dass parallele Initialisierung
grundsätzlich möglich ist; XMRig deaktiviert ihn auf Zen 4 aber bewusst, weil
mehr SIMD nicht automatisch schneller ist.

**Risiken und Gate**

- Sehr hoher Registerdruck, mehr JIT-Code und mögliche I-Cache-Nachteile.
- Dataset byteweise gegen den Referenzinitializer vergleichen, einschließlich
  ungerader Start-/Endbereiche und mehrerer Init-Threadzahlen.
- Nur weiterverfolgen, wenn Seed-Init-Zeit reproduzierbar sinkt, ohne den
  nachfolgenden Miningloop zu verlangsamen.

## EPYC 9634 / Zen 4: priorisierte Engine-Patches

AMD spezifiziert für den physischen EPYC 9634 84 Kerne, 168 Threads,
384 MiB L3, zwölf DDR5-Kanäle und bis zu 460,8 GB/s Socket-Bandbreite. Der
aktuelle TEX8-Gast sieht davon nur zwölf vCPUs, einen NUMA-Knoten und eine
widersprüchliche virtuelle Cachetopologie. Aussagen über CCDs, DIMM-Kanäle und
Bare-Metal-NUMA dürfen deshalb nicht aus TEX8-KVM-Messungen abgeleitet werden.

### E-1 — Genoa/Bergamo korrekt als Zen 4 erkennen

**Exakte Stellen**

- `src/backend/cpu/platform/BasicCpuInfo.cpp`:
  `BasicCpuInfo::BasicCpuInfo`, AMD-Family-19h-Switch.
- Betroffene Folgeentscheidungen:
  `src/crypto/randomx/jit_compiler_x86.cpp`,
  `JitCompilerX86::JitCompilerX86` (`initDatasetAVX2`), und
  `src/backend/cpu/platform/HwlocCpuInfo.cpp`, Cache-/Threadberechnung mit
  zusätzlichem L2 für `ARCH_ZEN4`/`ARCH_ZEN5`.

**Gefundener Fehler und Patchform**

XMRig 6.26.0 erkennt bei Family 19h nur Model `61h` und `75h` als Zen 4;
alle anderen Models werden pauschal Zen 3. AMD dokumentiert dagegen Family
19h Model `10h-1Fh` für EPYC 91xx-96xx und `A0h-AFh` für 97xx als Zen 4.
Der EPYC 9634 meldet Model 11h und wird damit falsch klassifiziert.

Die bekannte Zen-4-Modelmenge explizit ergänzen und einen CPUID-Test für
`19h/11h` hinzufügen. Keine pauschale Regel „Family 19h = Zen 4“, weil dieselbe
Family auch Zen-3-Models enthält.

**Erwartete Wirkung**

- Korrekte Architektur-/MSR-Telemetrie.
- Der auf Zen 4 laut Source langsamere AVX2-Dataset-Initializer wird im
  Auto-Modus nicht fälschlich als Zen-3-Pfad aktiviert.
- Hwloc kann seine für Zen 4 vorgesehene L2/L3-Threadkapazitätsrechnung
  verwenden. Das kann die automatisch gewählte Threadzahl ändern und dadurch
  H/s beeinflussen; der Effekt ist hosttopologieabhängig.

**Risiken und Gate**

- Falsche Modelranges können Zen 3 fehlklassifizieren und falsche MSRs wählen.
  Daher AMDs dokumentierte Ranges plus konkrete CPUID-Fixtures testen.
- Der KVM-Gast ist ein Erkennungstest, kein Cache-/MSR-Performancebeweis.
  Keine MSR-Schreibtests auf TEX8.

Primärquellen: [XMRig-6.26.0-Erkennungslogik](https://github.com/xmrig/xmrig/blob/b2ca72480c58d197e18c885d9fc1a0c8d517e60a/src/backend/cpu/platform/BasicCpuInfo.cpp),
[AMD PPR Family 19h Model 10h-1Fh](https://docs.amd.com/v/u/en-US/55901)
und [AMD EPYC Tuning Guide](https://docs.amd.com/api/khub/documents/f5vEE9HFY50eZwgTAuMMmA/content).

### E-2 — AVX-512VL-Group-E-Bitselect im x86-JIT-Hauptloop

**Exakte Stellen**

- `src/crypto/randomx/asm/program_loop_load.inc`: nach acht
  `cvtdq2pd` folgen für `xmm4..xmm7` derzeit vier `andpd` plus vier `orpd`.
- `src/crypto/randomx/asm/program_xmm_constants.inc`: Group-E-Mantissen- und
  Exponentenmasken.
- `src/crypto/randomx/jit_compiler_x86_static.S` und `.asm`: zusätzliches
  Zen-4-Template, nicht global den portablen Pfad überschreiben.
- `src/crypto/randomx/jit_compiler_x86.cpp`:
  `JitCompilerX86::JitCompilerX86` zur einmaligen Templateauswahl.
- `src/backend/cpu/interfaces/ICpuInfo.h` und CPU-Erkennung: AVX-512VL neben
  AVX-512F explizit erkennen, statt von `AVX512F` allein auf 128-Bit-EVEX zu
  schließen.

**Patchform**

Wie beim belegten ARM-`BIF`-Patch die Group-E-Maske auf
`0x00ffffffffc00000` verengen und pro Register `(converted & mask) | exponent`
mit einem 128-Bit-`VPTERNLOGQ` ausgeben. Der bestehende SSE-Pfad bleibt
Fallback. Die genaue Ternary-Immediate wird nicht per Hand angenommen, sondern
durch einen kleinen Exhaustiv-/Assembler-Test gegen die Referenzform bewiesen.

**Erwartete Wirkung**

Vier statt acht logische Instruktionen pro RandomX-Iteration treffen den
dominanten JIT-Pfad. **0 bis ungefähr 1 %** ist ein realistischer
Screening-Korridor; es gibt noch keinen EPYC-Messwert. Der ARM-Wert von 0,9 %
ist nur Motivation, nicht auf Zen 4 übertragbar.

**Risiken und Gate**

- EVEX-Decoding, Zen-4-Doppel-Pumping und längere Encodings können den
  Uop-Vorteil aufheben.
- Eine falsche Maske oder Ternary-Immediate verändert Konsenshashes.
- Zuerst generierten JIT-Code disassemblieren, dann RandomX-Known-Answer,
  250K-Endhash und lange Differentialtests. Nur auf CPUs mit OS-freigegebenem
  AVX-512F **und** AVX-512VL aktivieren.

Dies ist kein erneuter `-march=znver*`-, PGO-, JIT-Alignment- oder
Codeoffset-Test. Es ersetzt konkret vier Hotloop-Uops durch eine andere
ISA-Codeform.

### E-3 — Gemessener AES-NI/VAES-512-Selector für Zen 4

**Exakte Stellen**

- `src/crypto/randomx/aes_hash.cpp`:
  `hashAndFillAes1Rx4<softAes, unroll>`. Unter `XMRIG_VAES` wird
  `hashAndFillAes1Rx4_VAES512` aktuell ausschließlich bei `ARCH_ZEN5`
  aufgerufen.
- `src/crypto/randomx/aes_hash_vaes512.cpp`:
  vorhandener `hashAndFillAes1Rx4_VAES512`-Kernel.
- `src/crypto/rx/Rx.cpp`, `Rx::init`: einmalige Auswahl nach
  Capability-, Korrektheits- und Kalibrierungstest.

**Patchform**

Nicht Zen 4 blind freischalten. Stattdessen auf `VAES + AVX512F` beide
vorhandenen Hard-AES-Pfade mit realistischen 2-MiB-Scratchpads und der
tatsächlichen Workerzahl kurz interleaved kalibrieren. Vor der Zeitmessung
müssen beide Pfade identischen Hash- und Fill-State liefern. Auswahl plus
Host-/Binary-Fingerprint im Benchmark-Ledger speichern. Bei geringer Differenz
AES-NI als konservativen Default behalten.

**Erwartete Wirkung**

Der vorhandene Zen-3-Profiler sah ungefähr 3,6 % AES-Anteil; das ist eine harte
Amdahl-Obergrenze für den Gesamtgewinn dieses Teilpfads. Auf Zen 4 ist **0 bis
ungefähr 1 % insgesamt** plausibel, aber auch ein Verlust durch 512-Bit-
Ausführung. Die Auswahl beseitigt die unbelegte Annahme, dass der Pfad erst ab
Zen 5 sinnvoll ist.

**Risiken und Gate**

- AVX-512 kann Takt oder Energieeffizienz verschlechtern.
- Kalibrierung mit XMRigs bestehendem 10-KiB-Soft-AES-Test wäre unrealistisch;
  sie muss 2 MiB und parallele Worker abbilden.
- Das frühere Patch `0008` (VAES-256) bleibt verworfen: korrekt, aber auf Zen 3
  wegen `VPERM2I128` ungefähr 0,94 % langsamer. Der vorhandene VAES-512-Kernel
  hat eine andere Blend-Codeform; dennoch wird nichts ohne Messung promoted.

Primärquelle: [XMRig-6.26.0-AES-Dispatch](https://github.com/xmrig/xmrig/blob/b2ca72480c58d197e18c885d9fc1a0c8d517e60a/src/crypto/randomx/aes_hash.cpp).

### E-4 — NUMA-lokale Dataset-Initialisierung und -Replikation

**Exakte Stellen**

- `src/crypto/rx/RxDataset.cpp`:
  `init_dataset_wrapper` und `RxDataset::init`; die erzeugten Init-Threads
  setzen Priorität, aber keine Node-/CPU-Bindung.
- `src/crypto/rx/RxNUMAStorage.cpp`:
  `RxNUMAStoragePrivate::initDatasets` und `copyDataset`; der Copy-Thread kennt
  `nodeId`, bindet sich vor `RxDataset::setRaw` aber nicht an das Zielnode.
- `RxNUMAStorage.cpp::bindToNUMANode`: vorhandene Bindefunktion als
  Architekturhinweis, nicht als MFW-Codequelle.

**Patchform**

- Init-Threads über die CPUs des primären NUMA-Nodes verteilen und Speicher
  dort first-touch schreiben.
- Jeden Replikations-Thread vor `setRaw` an Zielnode und dessen CPU-Set binden;
  große Kopien in kontrollierten Chunks ausführen. Erst separat prüfen, ob
  libc-`memcpy` oder Non-Temporal-Copy schneller ist.
- In MFW den Node, Cpuset, Dataset-Node und Hugepage-Status pro Worker im Ledger
  festhalten.

**Erwartete Wirkung**

Kürzerer Dataset-Aufbau und Seed-Wechsel sowie weniger Inter-Socket-/NUMA-
Traffic beim Kopieren. Im stabilen, korrekt lokalen Miningloop ist **kein
direkter H/s-Gewinn** zu erwarten. Bei bisher remote initialisierten Seiten
kann die spätere Hashrate jedoch indirekt deutlich profitieren.

**Risiken und Gate**

- Parallele 2-GiB-Kopien können alle zwölf Speicherkanäle kurzzeitig sättigen
  und andere Dienste stören.
- Pro Node wird weiterhin ein vollständiges Dataset benötigt; Speicherbedarf
  und Hugepage-Verfügbarkeit vorab prüfen.
- Nur auf genehmigtem Bare Metal mit mindestens zwei echten NUMA-Nodes testen.
  TEX8-KVM mit einem Gastnode kann diesen Patch nicht validieren.

### E-5 — Kein stiller Fallback auf ein Remote-Dataset

**Exakte Stellen**

- `src/crypto/rx/RxNUMAStorage.cpp`:
  `RxNUMAStoragePrivate::dataset(uint32_t nodeId)` gibt bei fehlendem Node
  derzeit ohne Warnung `m_datasets.at(m_nodeset.front())` zurück.
- `src/backend/cpu/CpuWorker.cpp`:
  `CpuWorker<N>::allocateRandomX_VM` fordert `Rx::dataset(..., node())` an,
  kann den stillen Fallback aber nicht erkennen.
- MFW-Zielimplementierung: NUMA-Dataset-Registry und Worker-Scheduler müssen
  Dataset-Node und Worker-Node als geprüfte Invariante behandeln.

**Patchform**

Bei fehlender Dataset-Replik entweder den Worker auf einen Node mit lokalem
Dataset verschieben oder diesen Worker fail-closed deaktivieren. Ein explizit
konfigurierter „remote erlaubt“-Diagnosemodus darf existieren, aber kein
unsichtbarer Produktionsfallback. Die Auswahl muss im Status und Ledger
sichtbar sein.

**Erwartete Wirkung**

Auf einem gesunden Ein- oder Mehrnode-System 0 %. Nach partieller
Dataset-/Hugepage-Allokation kann dies eine große Regression verhindern und
die Speicherkanäle des ersten Nodes vor allen Remote-Workern schützen. Es ist
damit ein Performance-Robustheitsfix, kein garantierter Durchschnittsgewinn.

**Risiken und Gate**

- Fail-closed reduziert nach Allokationsfehlern die Workerzahl. Das ist besser
  als irreführende „volle“ Threadzahl mit massiver Remote-Latenz, muss aber
  prominent gemeldet werden.
- Tests: vollständige Allokation, fehlendes mittleres Node, nur ein Dataset,
  Speicherknappheit und Seedwechsel unter Worker-Neustart.

## Bewusst nicht erneut vorgeschlagen

| Frühere Variante | Befund | Konsequenz |
|---|---|---|
| PGO, LTO, Clang, generisches `-march=znver3`, pauschales `-mcpu=apple-m4` | kein belastbarer Gewinn; M4-`mcpu` thermisch nicht vergleichbar | keine Compilerflag-Kampagne vor Hotpath-Patch |
| x86-Dataset-Prefetch off/T0/NTA und Scratchpad T0/T1/NTA/W/MOV | Upstream NTA/T0 blieb auf Zen 3 am besten | auf EPYC nicht blind wiederholen; M4-Patch betrifft andere A64-Hints und 128-Byte-Linien |
| JIT-32B-Alignment, Codeoffset, Intel- statt AMD-JIT, BMI2 aus | neutral oder schlechter | keine Wiederholung ohne neuen Mikroarchitekturbeweis |
| Hard-AES-Unroll und generische Distanzsweeps | kein stabiler Gewinn | M4 testet zuerst nur die doppelte Hint-Kadenz einer 128-Byte-Linie |
| VAES-256 mit Lane-Permutationen | korrekt, auf Zen 3 etwa 0,94 % langsamer | nicht reaktivieren; nur vorhandenen anders aufgebauten VAES-512-Pfad messen |
| manuelle Affinität, QoS, duale CCD-Prozesse/Datasets | neutral oder schlechter; M4 `USER_INTERACTIVE` keine Produktsystematik | NUMA-Lokalität als Invariante implementieren, keine Benchmark-Schedulertricks |
| Metal | RandomX-Hotpath ist CPU-/JIT-/Latenzdominiert; gemeinsames thermisches Budget | kein Engine-Patchkandidat in dieser Stufe |

## Empfohlene Implementierungs- und Messreihenfolge

1. **M4-1** auf der BSD-lizenzierten RandomX-Basis übernehmen und alle
   Korrektheitsgates bestehen.
2. M4 mit Symbol-/Scope-Profiling neu baselinen. Danach **M4-2**, **M4-3** und
   nur bei messbarem Blake2-Anteil **M4-4** jeweils einzeln ABBA/BAAB testen.
   **M4-5** separat als Seed-Init-Metrik behandeln.
3. Für EPYC zuerst **E-1** als Hardwareerkennungsfix. Die KVM-Instanz darf
   Capability-/Correctness-Tests liefern, aber keine NUMA-/Channel-Claims.
4. Auf genehmigtem, vollständig dokumentiertem Genoa-Bare-Metal **E-2** und
   **E-3** einzeln messen. Danach **E-4/E-5** mit mindestens zwei Nodes und
   vollständig belegten Speicherkanälen prüfen.
5. Erst ein Kandidat, der drei interleavte A/B/B/A-Blöcke, korrekten 250K-Hash,
   Langlauf und Energie-/Thermal-Gate besteht, wird Default.

Für jeden Lauf speichern: CPU-Family/Model/Stepping, Featurebits, physische
oder virtuelle Topologie, Worker- und Dataset-Node, Cacheline, Threadzahl,
Dataset-/Hugepage-Modus, JIT-/AES-/Prefetch-Variant, Init-Zeit, H/s p05/Median/
p95, H/J soweit verfügbar, Temperatur/Takt, Correctness-Hash, Source-Commit,
Patch-Digest und Binary-SHA-256.

## Lizenzgrenze für MFW

XMRig ist insgesamt GPLv3; unter anderem `BasicCpuInfo.cpp`,
`RxDataset.cpp`, `RxNUMAStorage.cpp`, `Rx.cpp` und `CpuWorker.cpp` dürfen nicht
als MFW-Produktcode übernommen werden. Die hier beschriebenen Beobachtungen
werden in MFW sauber neu implementiert. Der Hotpath startet von der
BSD-3-Clause-lizenzierten RandomX-Basis, und BSD-Dateihinweise bleiben erhalten.
XMRig bleibt ein externes Referenzprogramm und darf für isolierte
Benchmarkpatches gebaut werden, ohne in MFW gelinkt oder kopiert zu werden.

Primärquellen:

- [RandomX v2.0.1](https://github.com/tevador/RandomX/releases/tag/v2.0.1)
- [RandomX BSD-3-Clause-Lizenz](https://github.com/tevador/RandomX/blob/master/LICENSE)
- [XMRig v6.26.0 Source](https://github.com/xmrig/xmrig/tree/b2ca72480c58d197e18c885d9fc1a0c8d517e60a)
- [XMRig GPLv3-Lizenz](https://github.com/xmrig/xmrig/blob/b2ca72480c58d197e18c885d9fc1a0c8d517e60a/LICENSE)
- [AMD EPYC 9634: Kerne, L3 und Speicherkanäle](https://www.amd.com/en/products/processors/server/epyc/4th-generation-9004-and-8004-series/amd-epyc-9634.html)
- [AMD Software Optimization Guide for Zen 4](https://www.amd.com/content/dam/amd/en/documents/processor-tech-docs/software-optimization-guides/57647.zip)

