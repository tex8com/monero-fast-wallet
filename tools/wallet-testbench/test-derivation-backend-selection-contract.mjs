import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const patch = read(
  'third_party/monero-patches/0073-wallet-benchmark-and-report-automatic-derivation-backend.patch',
);
const additions = patch
  .split(/\r?\n/)
  .filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .join('\n');
const gpuDispatchPatch = read(
  'third_party/monero-patches/0024-wallet-add-verified-automatic-GPU-derivation-dispat.patch',
);
const manualBenchmarkPatch = read(
  'third_party/monero-patches/0082-wallet-run-manual-derivation-backends-for-ten-seconds.patch',
);
const desktopBridge = read('native/desktop-bridge/cpp/DesktopWalletCore.cpp');
const walletEngine = read('native/monero-bridge/cpp/WalletEngine.cpp');
const mobileService = read('wallets/mobile/src/backend/DerivationPerformance.ts');
const proofMain = read('native/monero-bridge/proof/main.cpp');

test('automatic backend selection uses one bounded public-vector benchmark', () => {
  assert.match(additions, /std::once_flag automatic_backend_benchmark_once/);
  assert.match(additions, /std::call_once\(automatic_backend_benchmark_once/);
  assert.match(additions, /public_test_vector=1/);
  assert.match(additions, /4096, std::chrono::milliseconds\(100\), 8/);
  assert.match(additions, /16384, std::chrono::milliseconds\(60\), 32/);
});

test('only a verified faster GPU wins and CPU remains the fallback', () => {
  assert.match(additions, /gpu\.verified/);
  assert.match(
    additions,
    /gpu\.derivations_per_second > cpu\.derivations_per_second/,
  );
  assert.match(additions, /automatic_gpu_selected\.store\(select_gpu/);
  assert.match(gpuDispatchPatch, /set_active_backend\("cpu-fallback"/);
  assert.match(gpuDispatchPatch, /return fast_generate_key_derivation_batch_same_scalar/);
});

test('manual testbench runs each supported backend sequentially for ten seconds', () => {
  assert.match(
    manualBenchmarkPatch,
    /measurement_duration = std::chrono::milliseconds\(10000\)/,
  );
  assert.equal(
    manualBenchmarkPatch.match(/measurement_duration, measurement_maximum_rounds/g)
      ?.length,
    3,
  );
  assert.match(mobileService, /DERIVATION_BACKEND_DURATION_MS = 10_000/);
  assert.match(mobileService, /setInterval\(emitProgress, 100\)/);
});

test('every wallet scan reports the actual CPU, Metal, or CUDA backend', () => {
  assert.match(additions, /active_derivation_backend_name/);
  assert.match(additions, /backend=/);
  assert.match(additions, /gpu_name = "metal"/);
  assert.match(additions, /gpu_name = "cuda"/);
});

test('desktop, mobile, and CLI bridge share the same native benchmark surface', () => {
  assert.match(desktopBridge, /benchmarkDerivationPerformance/);
  assert.match(walletEngine, /benchmarkDerivationPerformance/);
  assert.match(mobileService, /benchmarkDerivationPerformance/);
  assert.match(proofMain, /command == "derivation-benchmark"/);
  assert.match(proofMain, /fixed public test vector/);
  assert.match(proofMain, /WalletEngine::derivationBackendStatus\(\)/);
  assert.match(proofMain, /WalletEngine::benchmarkDerivationPerformance\(\)/);
});
