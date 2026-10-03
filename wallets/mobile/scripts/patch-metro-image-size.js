#!/usr/bin/env node

const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

// Metro 0.84 passes a filename to image-size. image-size 2.0.3+ accepts a
// byte view only, so feed it the bytes explicitly instead of retaining the
// vulnerable 1.x parser. Fail loudly if Metro changes this API.
const assetModule = resolve(__dirname, '../node_modules/metro/src/Assets.js');
const legacyInput = `const isImageInput = assetInfo.files[0].includes(".zip/")\n    ? _fs.default.readFileSync(assetInfo.files[0])\n    : assetInfo.files[0];`;
const secureInput = 'const isImageInput = _fs.default.readFileSync(assetInfo.files[0]);';
const source = readFileSync(assetModule, 'utf8');

if (source.includes(secureInput)) process.exit(0);
if (!source.includes(legacyInput)) {
  throw new Error('Unsupported Metro Assets.js layout; review the image-size compatibility patch.');
}
writeFileSync(assetModule, source.replace(legacyInput, secureInput));
