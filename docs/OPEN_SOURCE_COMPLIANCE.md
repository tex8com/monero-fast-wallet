# Open-Source-Compliance

Dieses Repository verwendet eine Verzeichnis-basierte Mehrfachlizenz. Die
maßgebliche Zuordnung steht in der Datei [LICENSE](../LICENSE); vollständige
Lizenztexte liegen unter [`LICENSES/`](../LICENSES/). Für übernommene Komponenten
und deren Hinweise gilt [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Prüfumfang je Release

Jedes Release muss die folgenden reproduzierbaren Prüfungen am exakt zu
veröffentlichenden Commit bestehen:

```sh
node --test scripts/test-license-boundaries.mjs scripts/test-release-sbom.mjs
./scripts/check-supply-chain-contract.sh
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" \
  node scripts/generate-release-sbom.mjs build/compliance/sbom.spdx.json
```

Die letzte Anweisung erzeugt eine deterministische SPDX-2.3-SBOM. Zusätzlich
erzeugt der Workflow **Security verification** eine CycloneDX-SBOM und bewahrt
sie 30 Tage als CI-Artefakt auf. Das Release-Archiv muss beide SBOM-Formate,
den zugehörigen Lizenzbericht und die erforderlichen Upstream-Hinweise
enthalten.

Eine SBOM ist eine Bestandsaufnahme, keine Sicherheitsfreigabe. Vor einer
Veröffentlichung sind daher außerdem die Abhängigkeits- und Secret-Scans sowie
die Tests des konkreten Release-Artefakts ohne unakzeptierte Befunde erforderlich.
