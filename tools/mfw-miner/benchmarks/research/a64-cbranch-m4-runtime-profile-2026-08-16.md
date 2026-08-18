# AArch64 CBRANCH: Korpusentscheidung und M4-Laufzeitprofil

Datum: 2026-08-16

## Auswahl

Der exakte JIT-Korpus-Profiler ordnete 72,509 % der gemappten M4-Samples und
51,962 % der gemappten M1-Samples `CBRANCH` zu. Der gewählte Kandidat änderte
nur die logische Testinstruktion:

- Referenz: `TST xDst, mask`;
- Kandidat: `TST wDst, mask`.

Alle legalen RandomX-Masken liegen in Bits 8 bis 30. Beide Formen setzen daher
für die Branchentscheidung dasselbe Z-Flag. Codegröße, CBRANCH-Länge,
Rücksprung und alle folgenden nativen Adressen bleiben identisch.

## Encoding-Incident

Der erste Ein-Programm-Smoke verwendete fälschlich `0x72781C1F` als
W-Form-Basis und endete sofort mit `SIGILL`. Der Lauf wurde ausgeschlossen.
Apple-Assembler und Disassembly zeigten die richtige logische
Immediate-Kodierung `0x72181C1F`; danach bestanden sämtliche Tests. Der
Incident ist in den Smoke-Rohdaten erhalten.

## Korrektheit

- M4 erzwungener Kandidat: RandomX v1 64 Programme und v2 64 Programme PASS;
  4.031 CBRANCH-Kodierungen; exakter Vergleich gegen Mode 0 PASS.
- M1 erzwungener Kandidat: dieselben 128 Programme und 4.031 CBRANCHes PASS.
- Stable Replay: v2, 8 Programme mal 2 PASS auf beiden Macs.
- Automatischer Produktionsmodus auf M4: 4.031/4.031 W-Formen, alle übrigen
  Bytes identisch zur Referenz.
- Derselbe automatische Modus auf M1: 4.031/4.031 X-Formen, vollständiger
  Referenzvergleich PASS.
- Profiler-freier Produktionsbuild enthält keine JitCorpus-Symbole oder CLI.
- Abschließender Fast-Hash: M4 10 Threads PASS; M1 8 Threads PASS.

## Performanceentscheidung

| Host | Referenz | Kandidat | Differenz | Entscheidung |
|---|---:|---:|---:|---|
| M4, ABBA | 2.674,20 | 2.683,80 H/s | +0,3590 % | positiv |
| M4, BAAB | 2.684,15 | 2.690,05 H/s | +0,2198 % | positiv |
| M4, beide Blöcke | 2.679,175 | 2.686,925 H/s | +0,2893 % | M4-Profil übernehmen |
| M1, ABBA | 781,50 | 779,75 H/s | -0,2239 % | nicht übernehmen |

Der neue CMake-Modus ist:

- `0`: 64-Bit-Referenz erzwingen;
- `1`: 32-Bit-Kandidat erzwingen;
- `2`: Standard; 32 Bit nur bei `machdep.cpu.brand_string` mit Präfix
  `Apple M4`, sonst Referenzform.

Die Erkennung ist absichtlich konservativ. Ein fehlendes `sysctl`, M1,
Linux-AArch64 und unbekannte Apple-Generationen fallen auf die unveränderte
Form zurück. Es gibt weiterhin einen gemeinsamen RandomX-Algorithmus und
einen AArch64-JIT; nur die gemessene Instruktionsform wird pro
Mikroarchitektur gewählt.

## Artefakte

- Automatischer Korpusbuild:
  `c48389dba09094794d34e8b710be03e58649fbc18e0870c7401e71f5e5e7ff76`.
- Automatischer profiler-freier Produktionsbuild:
  `0c3919c39e46be5cbb86a222e22969ed12e4dfed11e3981342d98ea31449c17d`.
- M4 Auto-Korpus:
  `benchmark-results/jit-corpus/a64-cbranch-auto-m4-natural-v1-v2-64.ndjson`.
- M1 Auto-Korpus:
  `benchmark-results/jit-corpus/a64-cbranch-auto-m1-natural-v1-v2-64.ndjson`.
- M4/M1 Fast- und Kandidatenbelege stehen in den im Hardwarevergleich
  referenzierten Ergebnisverzeichnissen; alle Manifeste wurden geprüft.
