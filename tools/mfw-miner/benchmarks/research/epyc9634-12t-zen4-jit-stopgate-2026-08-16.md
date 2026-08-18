# EPYC 9634 / Zen 4: 12-Thread-JIT-Stopgate

Stand: 2026-08-16 UTC  
Entscheidung: **kein weiterer Zen-4-JIT-Kandidat aus dieser Evidenz**

## Kurzentscheidung

Die neuen 12-Thread-Daten belegen Correctness und die tatsächliche Aktivierung
des default-off AVX-512VL-Group-E-Pfads, aber keinen reproduzierbaren
Performancegewinn. Der positive Vergleich gegen das offizielle XMRig-Binary
(`+1,05 %`) widerspricht dem stärker isolierten Mode-0-gegen-Mode-1-Vergleich
(`-3,05 %`). In beiden Fällen verfehlt mindestens eine Seite das vorab
festgelegte Driftlimit von 2 %. Auch der korrigierte 2-MiB-Hugepage-Block ist
negativ und instabil. Damit fehlt sowohl eine stabile Baseline als auch eine
Hotspot-Attribution für einen neuen JIT-Eingriff.

Das belastbare Stopgate lautet daher:

1. `MFW_X86_GROUP_E_MODE=1` bleibt default-off und wird nicht promoted.
2. Es wird kein zweiter Zen-4-JIT-Modus implementiert, solange der bereits
   isolierte Group-E-Kandidat nicht in einem stabilen, direkten Vergleich
   entschieden und ein weiterer Hotspot mit PMU-/Profil-Evidenz belegt ist.
3. Hugepage-, NUMA-, Worker- und AES-Dispatch-Experimente werden nicht als
   JIT-Beleg umgedeutet.

## Ausgewertete Evidenz und Integrität

Primäre lokale Evidenz:

- `benchmark-results/hosts/tex8-epyc9634-autotune-20260816T013108Z/results-validation/`
- `benchmark-results/hosts/tex8-epyc9634-autotune-20260816T013108Z/results-pages-v2/`
- ergänzend der Worker-Screen unter `results-v3/`

`sha256sum -c full-manifest.sha256` besteht für den vollständigen lokalen
Evidenzbaum. Alle zwölf 250K-Läufe liefern den erwarteten Hash
`7D6054757BB08A63`; alle vier korrigierten 100K-Seitenläufe liefern
`BC4EF98B60B98579`. Die vier Mode-1-Läufe protokollieren ausdrücklich
`MFW_X86_GROUP_E_ACTIVE=1`. Der getestete AVX-512VL-Pfad war also aktiv; ein
stiller SSE-Fallback erklärt die Resultate nicht.

Alle 250K-Läufe verwenden `rx/0`, zwölf Worker auf CPUs `0-11`, acht
Init-Threads, keine HugeTLB-Seiten, RandomX-NUMA aus und MSR aus. Alle
Host-Preflights waren mechanisch eligible und sahen in den drei Live-Samples
99-100 % Idle, 0 % I/O-Wait, 0 % Steal sowie keine Minerreste. Diese
Momentaufnahmen schließen die danach gemessene Blockdrift jedoch nicht aus.

## 250K-Validierung

| Vergleich | Kontrolle H/s | Kandidat H/s | Mittel-Delta | Drift Kontrolle | Drift Kandidat | Gate |
|---|---:|---:|---:|---:|---:|---|
| offizielles XMRig vs. MFW Mode 0 | 5.249,2 / 5.084,0 | 5.151,9 / 5.163,4 | **-0,17 %** | 3,20 % | 0,22 % | fail |
| offizielles XMRig vs. MFW Mode 1 | 5.094,8 / 5.206,5 | 5.235,7 / 5.174,1 | **+1,05 %** | 2,17 % | 1,18 % | fail |
| MFW Mode 0 vs. MFW Mode 1 | 4.973,5 / 5.128,8 | 5.014,0 / 4.780,6 | **-3,05 %** | 3,07 % | 4,77 % | fail |

Die geometrischen Deltas (`-0,16 %`, `+1,06 %`, `-3,06 %`) ändern die
Entscheidung nicht.

### Warum der direkte Vergleich Vorrang hat

Das offizielle XMRig-6.26.0-Binary und die MFW-Testbuilds unterscheiden sich
in Compiler und Dependency-Packaging. Es handelt sich deshalb um ein
Release-/Packaging-Gate, nicht um eine reine Messung der Group-E-Codeform.
Mode 0 und Mode 1 stammen dagegen aus derselben GCC-12-/libuv-Buildfamilie;
hier ist Group-E die beabsichtigte performance-relevante Differenz.

Gerade dieser besser isolierte Block zeigt Mode 1 im Mittel 3,05 % langsamer,
aber zugleich 3,07 % und 4,77 % interne Drift. Der Wert darf deshalb weder als
stabile Regression noch der `+1,05 %`-Wert gegen XMRig als Gewinn behauptet
werden. Die beiden Richtungen sind nicht miteinander vereinbar, solange das
Driftgate fehlschlägt.

Mode 0 liegt gegen das offizielle XMRig im Mittel nur 0,17 % zurück, während
die XMRig-Kontrolle um 3,20 % driftet. Das ist innerhalb dieser Evidenz
praktisch Parität, kein belegter Rückstand, aus dem sich ein neuer Patchbedarf
oder ein schneller-als-XMRig-Claim ableiten ließe. Die etwa halbierte
Dataset-Initzeit des offiziellen Binaries gehört nicht zum Core-H/s-Intervall
und ist wegen der verschiedenen Builds ebenfalls keine JIT-Attribution.

## Korrigierter 2-MiB-Seitenblock

Der `pages-v2`-Block ist technisch gültig:

- vor dem Block: `HugePages_Total=0`;
- reserviert: 1.184 freie 2-MiB-Seiten;
- beide 2-MiB-Läufe: Dataset `1168/1168` und Worker `12/12` Hugepages;
- maximal im Prozess gesampelt: 2.418.688 KiB HugeTLB;
- nach dem Block: Pool erfolgreich auf `HugePages_Total=0` restauriert.

| Variante | H/s | Mittel H/s | interne Drift |
|---|---:|---:|---:|
| keine Hugepages | 5.130,0 / 4.909,9 | 5.019,95 | 4,38 % |
| 2-MiB-Hugepages | 4.916,2 / 5.028,4 | 4.972,30 | 2,26 % |

Das Mittel-Delta beträgt `-0,95 %` (geometrisch `-0,93 %`); beide Seiten
verfehlen das 2-%-Stabilitätsgate. Hugepages werden deshalb nicht promoted.
Unabhängig vom Vorzeichen ist die Seitengröße eine Speicherabbildungsoption
und kein Hinweis darauf, welcher x86-JIT-Handler geändert werden sollte.

## Warum kein neuer Zen-4-JIT-Kandidat seriös folgt

Der aktuelle, mikroarchitektonisch begründete JIT-Kandidat ist bereits E-2:
vier SSE-`ANDPD`/`ORPD`-Paare des Group-E-Loads werden auf Zen 4 und nur bei
AVX512F+AVX512VL durch vier 128-Bit-`VPTERNLOGQ` ersetzt. Der Quellpfad liegt
in:

- `src/crypto/randomx/asm/program_loop_load_avx512vl.inc`;
- `src/crypto/randomx/jit_compiler_x86_static.S` beziehungsweise `.asm`;
- Auswahl und Capability-Gates in
  `src/crypto/randomx/jit_compiler_x86.cpp`.

Die neue Evidenz entscheidet selbst diesen eng umrissenen Kandidaten nicht.
Einen zweiten Eingriff parallel zu einem ungeklärten ersten Pfad zu bauen,
würde Effekte vermischen statt den nächsten Hotspot zu identifizieren.

Für die dynamisch emittierten Integer-/Float-/Branch-Handler in
`JitCompilerX86::h_*` enthält der Evidenzsatz keine retired-instruction-,
Cycle-, Frontend-, Branch- oder Cache-Counter und kein symbolisiertes Profil.
Die Telemetrie enthält Prozess-/Systemticks und einen in allen Stichproben
identischen `average_mhz`-Wert von 2246,624 MHz; sie kann die beobachtete
H/s-Drift melden, aber keinen Zen-4-Port-, Decoder- oder Memory-Bottleneck
lokalisieren. Auf dem Gast sind `perf` und ein belastbarer physischer
CCD/L3-/NUMA-Plan nicht verfügbar; die virtuelle Cachetopologie ist zudem
widersprüchlich dokumentiert. Folglich gibt es keine Evidenzbasis, um etwa
`IADD_RS`, `IMUL_RCP`, Branching oder Dataset-Prefetch als *nächsten* Zen-4-
JIT-Hotspot zu priorisieren.

Die früheren Sackgassen bleiben ausgeschlossen: generische Compilerflags,
PGO/LTO, JIT-Alignment/Codeoffset, Intel- statt AMD-JIT, BMI2-off sowie blinde
Dataset-/Scratchpad-Prefetch-Sweeps werden ohne neue Attribution nicht
wiederholt.

E-3, der vorhandene VAES-512-AES-Kernel, bleibt ein separat messbarer
**Engine-/AES-Dispatch**-Kandidat. Er ist kein x86-JIT-Handler und wird durch
diese 12T-Daten nicht priorisiert. E-4/E-5 betreffen NUMA-Lokalität und können
in diesem Ein-Node-KVM-Gast nicht validiert werden.

## Aufhebung des Stopgates

Vor einem neuen Zen-4-JIT-Patch müssen beide folgenden Gates erfüllt sein:

1. **Bestehenden Group-E-Pfad entscheiden:** direkte, matched Mode-0-/Mode-1-
   Blöcke mit denselben Binaries, zwölf Workern und 250K, komplementär
   interleaved (`A-B-B-A` und `B-A-A-B`), korrektem Hash und höchstens 2 %
   Drift auf beiden Seiten. Die Richtung muss über akzeptierte Blöcke
   konsistent sein; bis dahin bleibt Mode 1 default-off.
2. **Neuen Hotspot attribuieren:** auf einem ruhigen Host mit verfügbarer PMU
   oder gleichwertigem, JIT-tauglichem Profil mindestens Cycles,
   Instructions/uOps, Frontend-/Branch- und Cache-/Memory-Signale für Mode 0
   erfassen und mit der tatsächlich emittierten Disassembly verbinden. Nur ein
   dort dominanter, Zen-4-spezifisch erklärbarer Engpass darf als neuer,
   einzeln schaltbarer JIT-Kandidat umgesetzt werden.

Wenn TEX8 weiterhin keine brauchbare PMU und keine kontrollierbare physische
Topologie exponiert, gehört Gate 2 auf genehmigtes Genoa-Bare-Metal. Mehr
Wiederholungen auf dem driftenden KVM-Gast ersetzen die Hotspot-Attribution
nicht.

## Scope dieses Turns

Dieser Turn hat ausschließlich lokale Evidenz und vorhandenen Source gelesen
und diesen Bericht ergänzt. Es wurden keine Benchmarks, Remoteaktionen,
Serviceaktionen oder Source-Edits ausgeführt; ARM-, Skylake- und EPYC-JIT-
Dateien blieben unverändert.
