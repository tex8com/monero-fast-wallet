import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import test from 'node:test';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(desktop, 'src-tauri/tauri.windows.conf.json'), 'utf8'));
const hooks = readFileSync(resolve(desktop, 'src-tauri', config.bundle.windows.nsis.installerHooks), 'utf8');
const macro = name => {
  const matches = [...hooks.matchAll(new RegExp(`^!macro ${name}\\s*\\n([\\s\\S]*?)^!macroend\\s*$`, 'gm'))];
  assert.equal(matches.length, 1, `${name} must have one definition`);
  return matches[0][1];
};

test('legacy helper migration removes only the reserved sibling after its replacement exists', () => {
  const postInstall = macro('NSIS_HOOK_POSTINSTALL');
  assert.equal(config.bundle.resources['target/release/monero-fast-walletd.exe'], 'target/release/monero-fast-walletd.exe');
  assert.deepEqual([...postInstall.matchAll(/^\s*Delete\s+"([^"]+)"\s*$/gm)].map(match => match[1]), ['$INSTDIR\\monero-fast-walletd.exe']);
  assert.match(postInstall, /\$\{IfNot\} \$\{FileExists\} "\$INSTDIR\\target\\release\\monero-fast-walletd\.exe"[\s\S]*?SetErrorLevel 2\s+Abort\s+\$\{EndIf\}[\s\S]*?Delete /);
  assert.doesNotMatch(postInstall, /\b(?:RMDir|Exec|ExecWait|DeleteRegKey|DeleteRegValue|SetRegView|WriteRegStr)\b|\/REBOOTOK|schtasks|Stop-Process|\$APPDATA|\$LOCALAPPDATA|\$UpdateMode/);
});

test('locked legacy files cannot be deferred or reported as a successful update', () => {
  const postInstall = macro('NSIS_HOOK_POSTINSTALL');
  assert.match(postInstall, /ClearErrors\s+Delete "\$INSTDIR\\monero-fast-walletd\.exe"\s+\$\{If\} \$\{Errors\}\s+MessageBox MB_OK\|MB_ICONSTOP [^\n]+\s+SetErrorLevel 2\s+Abort\s+\$\{EndIf\}/);
});

test('uninstall cleanup and wallet-data preservation remain separate from update migration', () => {
  const preUninstall = macro('NSIS_HOOK_PREUNINSTALL');
  assert.match(preUninstall, /StrCpy \$DeleteAppDataCheckboxState 0/);
  assert.match(preUninstall, /\$\{If\} \$UpdateMode <> 1[\s\S]*?uninstall-notification-agent\.ps1/);
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(config.bundle.resources['../windows/uninstall-notification-agent.ps1'], 'uninstall-notification-agent.ps1');
});
