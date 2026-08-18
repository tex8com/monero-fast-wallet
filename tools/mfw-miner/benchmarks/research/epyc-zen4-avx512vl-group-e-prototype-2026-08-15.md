# EPYC Zen 4: test-only AVX-512VL Group-E prototype

Stand: 2026-08-15  
Status: Source-, Truth-Table-, Assembly- und beide x86-250K-Hashgates bestanden; Performancegate offen

## Umfang

Der E-2-Kandidat aus der Engine-Analyse ist als begrenzter, standardmäßig
deaktivierter x86-64-Prototyp implementiert. Er verändert weder ARM-Dateien
noch den generischen SSE-Pfad. Es wurde kein Miner, Pool, Remote-Benchmark oder
Performancevergleich gestartet.

## Implementierung

- `ICpuInfo::FLAG_AVX512VL` ist ein separates Capabilitybit.
- `BasicCpuInfo.cpp` erkennt CPUID Leaf 7, Subleaf 0, EBX Bit 31 nur zusammen
  mit OSXSAVE und dem vollständigen AVX-512-XCR0-Zustand.
- `program_loop_load_avx512vl.inc` behält alle Loads und Konvertierungen des
  Referenztemplates bei. Nur vier `ANDPD` plus vier `ORPD` werden durch vier
  128-Bit-`VPTERNLOGQ` ersetzt.
- `MFW_X86_GROUP_E_MODE` ist ein CMake-String mit Default `0`. Modus `1` ist
  zusätzlich auf `ARCH_ZEN4 + AVX512F + AVX512VL` begrenzt. Fehlt ein Gate,
  kopiert der JIT unverändert das SSE-Template.
- GNU-Assembler und MASM erhalten dasselbe symbolische Immediate `0xEA`.

Die bestehende x86-Group-E-Maske ist bereits
`0x00ffffffffc00000` pro 64-Bit-Lane. Der Prototyp verändert daher keine
RandomX-Maske oder andere Konsenskonstante.

## Beweis des Immediates

Intel-Ternary-Indexierung für Operanden `converted`, `mask`, `exponent`:

```text
index = (converted << 2) | (mask << 1) | exponent
result = (converted & mask) | exponent
```

Die acht Ausgänge in Indexreihenfolge sind `0,1,0,1,0,1,1,1`, also
`11101010b = 0xEA`. Der C++-JIT enthält denselben Compile-Time-Beweis mit
`static_assert`. `verify-x86-group-e-vpternlog.py` berechnet alle acht Zeilen
erneut, prüft die Source-Verträge, cross-assembliert das gesamte statische
x86-64-JIT-Template und disassembliert genau vier
`VPTERNLOGQ ..., 0xEA`-Instruktionen.

Lokale Ergebnisse:

```text
PASS: VPTERNLOGQ 0xEA truth table, opt-in gates, SSE fallback, and x86-64 assembly
Apple-Clang x86_64 syntax-only: jit_compiler_x86.cpp mode 0 PASS
Apple-Clang x86_64 syntax-only: jit_compiler_x86.cpp mode 1 PASS
Apple-Clang x86_64 syntax-only: BasicCpuInfo.cpp with ASM detection PASS
CMake ARM rejection for MFW_X86_GROUP_E_MODE=1 PASS
CMake ARM Debug configure with default mode 0 PASS
git diff --check PASS
```

Der Default-Debug-Configure beweist, dass der neue Default auf ARM keine
x86-Auswahl erzwingt. Der Kandidaten-Configure bricht auf ARM absichtlich mit
einer klaren Fehlermeldung ab. Ein separater Release-Configure erreichte einen
bereits vorhandenen, nicht E-2-bezogenen Clang-Strip-Hook-Fehler in
`CMakeLists.txt`; dieser bestehende Seiteneffekt wurde nicht in den
Patchumfang gezogen und betrifft den vorgesehenen GCC-Linux-Gate nicht.

## Ausgeführtes Correctness-Gate

Das eingecheckte Gate `run-x86-group-e-correctness.sh` wurde auf dem
genehmigten TEX8-EPYC-9634-Gast ausgeführt. Es:

1. verlangt Family 19h und einen expliziten Zen-4-Modelbereich;
2. verlangt AVX512F und AVX512VL im CPU-/OS-Featurebild;
3. baut getrennte SSE- und Kandidatenbinaries;
4. führt ausschließlich den fail-closed Offline-Benchmark `rx/0`, 250K aus;
5. akzeptiert beide Pfade nur mit `7D6054757BB08A63`.

Beide Pfade lieferten `7D6054757BB08A63`. Der Kandidatenlauf meldete zusätzlich
aus dem echten JIT-Konstruktor `MFW_X86_GROUP_E_ACTIVE=1`; das Zielobjekt
enthielt exakt vier `VPTERNLOGQ ..., 0xEA`, während das SSE-Objekt keine
enthielt. Vollständige Evidenz und Buildprovenienz stehen in
`benchmarks/hosts/TEX8_EPYC9634_GROUP_E_AVX512VL_CORRECTNESS_2026-08-15.md`.

Wegen erheblicher Fremdlast und unterschiedlicher Lastphasen ist dieser Erfolg
keine Performanceaussage. Der Kandidat bleibt nicht promotierbar und
default-off, bis ein ruhiger, identisch konfigurierter ABBA/BAAB-Test vorliegt.
