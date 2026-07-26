const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const android = path.join(root, 'android');
const read = relativePath =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

const wrapper = read('android/gradle/wrapper/gradle-wrapper.properties');
assert.match(wrapper, /distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-8\.14\.3-bin\.zip/);
assert.match(
  wrapper,
  /distributionSha256Sum=bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531/,
);

const rootGradle = read('android/build.gradle');
assert.match(rootGradle, /com\.android\.tools\.build:gradle:8\.12\.0/);
assert.match(rootGradle, /org\.jetbrains\.kotlin:kotlin-gradle-plugin:2\.1\.20/);
assert.match(rootGradle, /com\.google\.gms:google-services:4\.4\.4/);
assert.match(rootGradle, /project\(":app"\)[\s\S]*lockAllConfigurations\(\)/);
assert.match(rootGradle, /lockMode = LockMode\.STRICT/);

const appGradle = read('android/app/build.gradle');
assert.doesNotMatch(appGradle, /jsc-android:[^'"\n]*\+/);
assert.match(appGradle, /jsc-android:2026004\.0\.1/);
assert.match(appGradle, /def enableProguardInReleaseBuilds = true/);
assert.match(appGradle, /shrinkResources enableProguardInReleaseBuilds/);
assert.match(appGradle, /Release signing is required/);

const verification = read('android/gradle/verification-metadata.xml');
assert.match(verification, /<verify-metadata>true<\/verify-metadata>/);
assert.doesNotMatch(verification, /<trusted-artifacts>|<ignored-key/);
for (const platform of ['linux', 'osx', 'windows']) {
  assert.ok(
    verification.includes(`aapt2-8.12.0-13700139-${platform}.jar`),
    `missing verified AAPT2 checksum for ${platform}`,
  );
}
const checksums = verification.match(/<sha256 value="[a-f0-9]{64}"/g) ?? [];
assert.ok(checksums.length > 500, 'expected a complete Gradle checksum inventory');

const lockfile = path.join(android, 'app', 'gradle.lockfile');
assert.ok(fs.existsSync(lockfile), 'Android dependency lockfile is required');
const locks = fs.readFileSync(lockfile, 'utf8');
assert.match(locks, /com\.facebook\.react:react-android:0\.85\.1=/);
assert.match(locks, /com\.google\.firebase:firebase-messaging:/);
assert.match(locks, /^empty=/m);

assert.ok(
  fs.existsSync(path.join(root, 'ios', 'Podfile.lock')),
  'CocoaPods lockfile is required',
);
assert.ok(fs.existsSync(path.join(root, 'Gemfile.lock')), 'Ruby tool lockfile is required');

console.log('Mobile build integrity contract is pinned, checksummed, locked, and release-hardened.');
