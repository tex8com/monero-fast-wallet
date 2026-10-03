#!/usr/bin/env node

const {spawnSync} = require('node:child_process');

// braces has no patched npm release for GHSA-vfj7-8cjw-p6xm. The postinstall
// patch applies the upstream depth-guard fix, and this command permits only
// that exact advisory while still failing on every other npm vulnerability.
require('./test-braces-depth');

const audit = spawnSync('npm', ['audit', '--audit-level=moderate', '--json'], {
  cwd: require('node:path').join(__dirname, '..'),
  encoding: 'utf8',
});

if (!audit.stdout) {
  process.stderr.write(audit.stderr || 'npm audit produced no JSON output\n');
  process.exit(1);
}

const report = JSON.parse(audit.stdout);
const vulnerabilities = report.vulnerabilities || {};
const allowedAdvisory = 1240992;
const directFindings = Object.values(vulnerabilities).flatMap(vulnerability =>
  vulnerability.via.filter(via => typeof via !== 'string'),
);
const brokenReferences = Object.values(vulnerabilities).flatMap(vulnerability =>
  vulnerability.via.filter(
    via => typeof via === 'string' && !Object.hasOwn(vulnerabilities, via),
  ),
);
const blocked = directFindings.filter(
  finding => finding.source !== allowedAdvisory || finding.name !== 'braces',
);
if (blocked.length > 0 || brokenReferences.length > 0) {
  const names = blocked.map(finding => `${finding.name}:${finding.source}`);
  console.error(`npm audit found non-allowlisted vulnerabilities: ${names.join(', ')}`);
  process.exit(1);
}

if (!directFindings.some(finding => finding.source === allowedAdvisory)) {
  console.error('Expected braces advisory was not present; review and remove the temporary mitigation.');
  process.exit(1);
}

console.log('npm audit passed; the sole upstream braces advisory is locally mitigated and contract-tested.');
