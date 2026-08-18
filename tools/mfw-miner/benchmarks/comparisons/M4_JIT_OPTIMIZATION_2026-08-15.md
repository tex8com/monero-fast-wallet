# Apple M4: erster JIT-Optimierungsblock

Stand: 2026-08-15

## Ergebnis

Das lokale Profil ordnet 94,15% der Worker-Samples bei vier Threads und
93,14% bei zehn Threads dem generierten ARM64-RandomX-JIT-Code zu. Deshalb
wurde zuerst die Dataset-Prefetchform und danach die Group-E-Codeform im
ARM64-JIT verändert.

Der erste retained Kandidat ersetzt vier `AND+ORR`-Paare durch vier ARM64
`BIF`-Instruktionen. Anders als die kompakte RandomX-Upstream-Form erhält MFW
den bisherigen absoluten Offset des nachfolgenden generierten VM-Codes durch
vier nur einmal im Prolog ausgeführte NOPs.

| C-A-A-C, 4 Threads, 100K | Lauf 1 | Lauf 2 | Median |
|---|---:|---:|---:|
| XMRig-Group-E + `ISUB_R`-Fix | 2.497,8 H/s | 2.360,3 H/s | 2.429,05 H/s |
| MFW `BIF` + altes VM-Codeoffset | 2.512,4 H/s | 2.427,5 H/s | **2.469,95 H/s** |

Nominaler Medianvorteil: **+1,6838%**. Alle vier Läufe erzeugten den korrekten
100K-Hash `BC4EF98B60B98579`, liefen ohne Netzwerkzugriff und endeten sauber.

Der Kandidat bestand zusätzlich den offiziellen 250K-Hash
`7D6054757BB08A63`. Seine dabei gemessenen 1.576,9 H/s sind wegen starker
thermischer Drosselung ausdrücklich kein Performancewert.

## Verworfene Varianten

| Variante | Ergebnis | Entscheidung |
|---|---:|---|
| JIT-Dataset-Prefetch aus | 2.257,2 H/s, −32,98% im ersten Screen | verworfen |
| JIT-Prefetch L1 keep | 3.026,5 H/s, −10,14% | verworfen |
| JIT-Prefetch L2 keep | 2.798,5 H/s, −16,91% | verworfen |
| kompakter Group-E-`BIF`-JIT | Median 1.903,8 statt 2.183,3 H/s, −12,80% | verworfen |
| `BIF` mit exaktem Hot-Code-Layout (Mode 3) | Mittel 2.328,15 statt 2.444,05 H/s, −4,7421% | verworfen |

Der reine L2-Stream-Vorlauftest fiel in einen thermisch zusammengebrochenen
Hostzustand und ist ausgeschlossen. Die großen negativen Prefetch-Screens sind
korrekt, aber nicht interleaved; sie begründen keine genaue Prozentbehauptung.

## 10-Thread-Validierung

Ein zusätzlicher A-B-B-A/B-A-A-B-Block mit zehn Threads erzeugte in allen acht
Läufen den korrekten 100K-Hash und lief vollständig ohne Netzwerkzugriff:

| Block | Kontrolle Mittel | Kandidat Mittel | Delta |
|---|---:|---:|---:|
| A-B-B-A | 3.740,85 H/s | 3.852,65 H/s | +2,9886% |
| B-A-A-B | 3.859,65 H/s | 3.758,25 H/s | -2,6272% |

Die gegensätzlichen Blöcke widersprechen sich wegen starker thermischer Drift.
Über alle Läufe liegen die Mittel bei 3.800,25 und 3.805,45 H/s (+0,1368%);
die geometrisch symmetrische Blockkorrektur ergibt +0,1414%. Das ist praktisch
neutral und ausdrücklich kein Releasegewinn.

Folgerung: Mode 2 wird **nicht** für das 10-Thread-M4-Profil aktiviert. Der
Kandidat bleibt ausschließlich für ein Profil der vier Performance-Kerne
interessant, wo der erste kontrollierte Block +1,6838% gemessen hatte.

## Exaktes Layout nach jeder FDIV-Instruktion

Mode 3 kombiniert `BIF` mit je einer ARM64-NOP-Instruktion nach jedem dynamisch
erzeugten `FDIV`. Dadurch bleiben nicht nur der VM-Code-Start, sondern auch alle
nachfolgenden Instruktionsadressen exakt auf dem Referenzlayout. Das
vier-Thread-A-C-C-A-Ergebnis war:

| Lauf | Kontrolle | Exact-Layout-Kandidat |
|---|---:|---:|
| 1 | 2.376,4 H/s | 2.198,2 H/s |
| 2 | 2.511,7 H/s | 2.458,1 H/s |
| Mittel | 2.444,05 H/s | 2.328,15 H/s |

Das entspricht −4,7421% nach Blockmittel und −4,8542% als geometrisches Mittel
der beiden gepaarten Verhältnisse. Alle vier Läufe erzeugten
`BC4EF98B60B98579`, endeten sauber und liefen mit durch die macOS-Sandbox
gesperrtem Netzwerk. Die hohe absolute Drift ändert nicht die Richtung beider
Paare. Ausführungspadding im heißen JIT-Code ist damit verworfen; ein späterer
Runtime-Profilselektor soll stattdessen kompakte, paddingfreie Codetemplates
wählen.

## Erster längerer 250K-Sustained-Block

Nach einer Ruhephase wurde Mode 2 erstmals in A-B-B-A-Reihenfolge mit 250K
Hashes und vier Threads gemessen:

| Lauf | Variante | H/s | Prüfhash |
|---|---|---:|---|
| A1 | Kontrolle | 2.526,0 | korrekt |
| B1 | Mode 2 | 2.358,3 | korrekt |
| B2 | Mode 2 | 2.295,2 | korrekt |
| A2 | Kontrolle | 1.709,7 | korrekt |

Alle Läufe endeten sauber, lieferten `7D6054757BB08A63` und hatten durchgehend
gesperrtes Netzwerk. Der Kontrollpfad verlor jedoch von A1 bis A2 **32,3159%**.
Das naive Blockmittel würde Mode 2 fälschlich einen Vorteil von 9,8638%
zuschreiben. Der Block ist deshalb als `excluded-thermal-collapse` klassifiziert
und unterstützt weder einen Gewinn noch eine Niederlage. Nächstes Gate ist ein
aus kaltem Zustand gestarteter B-A-A-B-Gegenblock.

Ein erster B-Lauf für diesen Gegenblock wurde nach rund sieben Minuten Pause
versucht. Er lieferte zwar erneut den korrekten Hash, erreichte aber nur
2.213,0 H/s und lag damit sogar unter B2 des heißen Blocks. Die Pause war also
nicht ausreichend; die Sequenz wurde nach diesem einen Lauf beendet und der
Wert als `excluded-cooldown-insufficient` gespeichert.

## Nächstes Gate

Vor M4-Produktfreigabe fehlen weiterhin ein wirklich abgekühlter längerer
Vier-P-Core-Sustained-Test und ein gematchter 250K-Performancevergleich. Der
aktuelle Kandidat bleibt deshalb `promising-candidate`, nicht finaler
"schneller als XMRig"-Releaseclaim.
