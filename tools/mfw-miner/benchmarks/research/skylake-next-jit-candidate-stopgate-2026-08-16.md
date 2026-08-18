# Skylake-S JIT: Stopgate nach ISWAP_R

Stand: 2026-08-16  
Entscheidung: kein zweiter Source-Kandidat; zuerst ruhiges ISWAP-Retestgate

## Ergebnis

Nach dem korrekten, aber lastkontaminierten `ISWAP_R`-Versuch folgt aus den
vorhandenen Source- und Perf-Belegen kein zweiter, mikroarchitektonisch klarer
Skylake-JIT-Patch. Deshalb wurde kein weiterer CMake-Schalter, Handler oder
Dispatch ergänzt und kein weiterer 250K-Lauf auf dem produktiv belasteten
Host gestartet.

Der nächste kompakte und orthogonale Formkandidat wäre
`JitCompilerX86::h_IMUL_RCP`: die derzeitige Multiplikation mit einem
Stack-Literal könnte durch das bereits vorhandene Fallback aus `movabs` und
Register-`imul` ersetzt werden. Die statische Skylake-Analyse zeigt jedoch
keinen Durchsatz- oder µOp-Vorteil und zugleich einen deutlichen
Codegrößennachteil. Damit erfüllt dieser Kandidat das Implementierungsgate
nicht.

## Ausgangsevidence

Die Monero-Konfiguration erzeugt pro 256 VM-Instruktionen im Mittel:

- 25 `CBRANCH`;
- 8 `IMUL_RCP`;
- 6 `FSQRT_R`;
- 4 `FDIV_M`.

Der jüngste gematchte Skylake-Block lag im Prozessmittel bei ungefähr
0,93-0,96 IPC, etwa 26 % Cache-Misses je gezählter Cache-Referenz und nur
ungefähr 0,87 % Branch-Misses. Die absoluten Werte waren durch den produktiven
Fast-Wallet-Prozess kontaminiert, reichen aber für zwei negative
Routingentscheidungen:

1. ein weiterer Branch-Layout-/Alignment-Versuch ist durch die niedrige
   Missrate nicht priorisiert und wurde bereits als Sackgasse getestet;
2. ein JIT-Formwechsel muss entweder die lange Integer-Abhängigkeitskette oder
   eine nachweisbare µOp-/Portgrenze verbessern, nicht nur Code umordnen.

Quellen im Baum:

- `src/crypto/randomx/randomx.cpp`: Monero-Instruktionsfrequenzen;
- `src/crypto/randomx/jit_compiler_x86.cpp`: die emittierten Handler;
- `src/crypto/randomx/asm/program_imul_rcp_store.inc`: 16 in der Prologue
  materialisierte `movabs`-Konstanten;
- `benchmark-results/hosts/fork-new-intel-skylake-iswap-20260816T003500Z/`:
  gematchte Perf- und Telemetriebelege.

## Genau untersuchter nächster Formkandidat: IMUL_RCP

`IMUL_RCP` hat Frequenz 8/256. Potenzen von zwei erzeugen laut RandomX-Handler
keine Multiplikation; für die praktisch relevanten übrigen Divisoren schreibt
der JIT die ersten 16 Reziproken als `movabs`-Immediate in den Program-Prologue
und emittiert im Hot-Body:

```text
imul dst, qword ptr [rsp + disp8]
```

Die naheliegende Skylake-Alternative ist das bereits vorhandene Fallback:

```text
movabs rax, reciprocal
imul dst, rax
```

`rax` ist ein dediziertes JIT-Temporärregister, und beide Formen sind
semantisch exakt. Der Vergleich wurde mit dem auf `fork-new` vorhandenen
LLVM-MCA und `-mcpu=skylake` modelliert:

```text
llvm-mca -mtriple=x86_64 -mcpu=skylake -iterations=100
```

| Form | Instruktionen | µOps | modellierte Latenz | Block-RThroughput | Codegröße |
|---|---:|---:|---:|---:|---:|
| `imul dst,[rsp+disp8]` | 1 | 2 | 8 | 1,0 | 6 Byte |
| `movabs`; `imul dst,rax` | 2 | 2 | 1 + 3 | 1,0 | 14 Byte |

Die acht Zyklen der Memory-Form enthalten die Operand-Load-Latenz. Das
Stack-Literal ist jedoch pro Program-Prologue materialisiert, adressiert eine
bekannte Stackposition und wird in der inneren Schleife wiederverwendet. Der
Load kann daher parallel zur vorherigen `dst`-Abhängigkeit anlaufen. Genau das
spiegelt das Modell: beide Formen haben zwei µOps und denselben modellierten
Blockdurchsatz von einer Instruktionsgruppe je Zyklus.

Die Immediate-Form tauscht lediglich den Load-µOp gegen einen Immediate-Move-
µOp und wächst um acht Byte je `IMUL_RCP`. Bei der erwarteten Frequenz sind das
ungefähr 64 zusätzliche Byte pro 256-Instruktionsprogramm. Ohne µOp- oder
Durchsatzgewinn ist dieser I-Cache-/Decode-Aufpreis keine klare
Skylake-Optimierung. Der Modus wurde deshalb nicht implementiert.

LLVM-MCA ist ein statisches Schedulingmodell, kein Hardwarebenchmark. Seine
neutrale Aussage reicht nicht, um einen Gewinn endgültig auszuschließen; sie
reicht aber zusammen mit der Codegrößenregression aus, um das verlangte
„mikroarchitektonisch klar begründet“-Gate nicht zu bestehen.

## Warum die nominell teureren Handler nicht zu einem Patch führen

Die Skylake-Schedulinganalyse modelliert die unveränderten Hardwareprimitive
mit:

| Handler-Kern | Frequenz | Latenz | RThroughput |
|---|---:|---:|---:|
| `divpd` in `FDIV_M` | 4/256 | 14 | 4,0 |
| `sqrtpd` in `FSQRT_R` | 6/256 | 18 | 6,0 |

Diese beiden Operationen sind die klarsten verbleibenden Latenz-Hotspots. Es
gibt auf Skylake-S aber keine kürzere bitexakte SIMD-Divisions- oder
Quadratwurzelinstruktion. Reziprokal-/Newton- oder `rsqrt`-Näherungen würden
IEEE-Ergebnisse und damit den RandomX-Hash verändern. VEX-Encoding ändert die
Recheneinheit nicht und würde in den überwiegend Legacy-SSE-emittierten Body
zusätzlich AVX/SSE-Übergangsrisiken einführen.

Weitere geprüfte Routen wurden aus konkreten Gründen verworfen:

- `CBRANCH`: 25/256, aber etwa 0,87 % Misses; Alignment und JIT-Offset sind
  bereits dokumentierte Sackgassen.
- `IADD_RS`-LEA-Splitting: das Skylake-Modell bewertet die bestehende LEA hier
  mit einem µOp, Latenz 1 und RThroughput 0,5; die gesplittete Form benötigt
  zwei µOps und RThroughput 1,0.
- gepackte AVX2-Group-E-Konvertierung: sie müsste YMM-Zustand in einen
  Legacy-SSE-Body tragen. `vzeroupper` würde die gepackten Masken zerstören;
  die Alternative wäre eine breite VEX-Umschreibung vieler FP-Handler und
  damit kein isolierter zweiter Modus.
- Intel-/AMD-ASM-Wahl, BMI2-off, Compilerflags, Alignment/Offset, QoS und
  Affinity bleiben die bereits dokumentierten Sackgassen beziehungsweise vom
  Auftrag ausgeschlossenen Kategorien.

## Nächstes sinnvolles Gate

Der höchste Informationsgewinn kommt nun nicht von einem dritten JIT-Pfad,
sondern von einem ruhigen Wiederholungstest des bereits korrekten,
standardmäßig ausgeschalteten `MFW_X86_SKYLAKE_ISWAP_MODE=1`:

1. identische Mode-0-/Mode-1-Binaries und `0-6`-CPU-Set verwenden;
2. erst starten, wenn Fremdlast und I/O-Wait ein stabiles Fenster zeigen;
3. erneut mindestens ABBA und BAAB mit 250K und
   `7D6054757BB08A63` ausführen;
4. nur bei übereinstimmender Richtung, kleiner Blockdrift und Annäherung an die
   ruhige Referenz eine Promotion erwägen.

Bis dahin bleibt ISWAP Mode 1 default-off. Dieser Stopgate-Turn hat keine
ARM-, EPYC-, CMake-Strip- oder sonstigen Source-Dateien verändert, keinen
Miner gestartet, keinen Dienst berührt und keine Systemkonfiguration geändert.

## Primärquellen

- [Intel 64 and IA-32 Optimization Manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel64-and-ia32-architectures-optimization.html)
- [LLVM-MCA command guide](https://llvm.org/docs/CommandGuide/llvm-mca.html)
- [XMRig 6.26.0 x86 RandomX JIT](https://github.com/xmrig/xmrig/blob/v6.26.0/src/crypto/randomx/jit_compiler_x86.cpp)
- [RandomX design](https://github.com/tevador/RandomX/blob/master/doc/design.md)
