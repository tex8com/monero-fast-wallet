const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const playBundle = fs.readFileSync(path.join(__dirname, 'android-play-bundle.sh'), 'utf8');
const signingHelper = fs.readFileSync(path.join(__dirname, 'android-release-signing.sh'), 'utf8');
const releaseInstall = fs.readFileSync(path.join(__dirname, 'android-release-install.sh'), 'utf8');
const buildScript = fs.readFileSync(path.join(__dirname, 'android-build.sh'), 'utf8');
const gradle = fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8');

for (const variableName of [
  'MONERO_UPLOAD_STORE_FILE',
  'MONERO_UPLOAD_STORE_PASSWORD',
  'MONERO_UPLOAD_KEY_ALIAS',
  'MONERO_UPLOAD_KEY_PASSWORD',
]) {
  assert.match(signingHelper, new RegExp(variableName));
  assert.match(gradle, new RegExp(`System\\.getenv\\("${variableName}"\\)`));
}

assert.match(playBundle, /source "\$\{script_dir\}\/android-release-signing\.sh"/);
assert.match(releaseInstall, /source "\$\{script_dir\}\/android-release-signing\.sh"/);
assert.match(signingHelper, /provided_count > 0 && provided_count < \$\{#required_variables\[@\]\}/);
assert.match(signingHelper, /Missing Android release signing credentials\. Set all MONERO_UPLOAD_\* variables/);
assert.match(signingHelper, /\[\[ "\$\(uname -s\)" == "Darwin" \]\]/);
assert.match(playBundle, /MONERO_WALLET_ANDROID_GRADLE_TASK="bundleRelease"/);
assert.match(buildScript, /MONERO_WALLET_ANDROID_VARIANT:-release/);
assert.match(gradle, /Release signing is required/);

console.log('Android release-signing contract accepts protected cross-platform credentials and fails closed.');
