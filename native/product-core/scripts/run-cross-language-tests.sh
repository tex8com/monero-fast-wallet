#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core_root="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${core_root}/../.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/mfw-product-core-languages.XXXXXX")"
cleanup() {
  rm -rf "${work_dir}"
}
trap cleanup EXIT

typescript_compiler="${repo_root}/apps/mobile/node_modules/.bin/tsc"
typescript_fallback="${repo_root}/apps/desktop/.node_modules-root-owned-backup/typescript/bin/tsc"
if [[ -x "${typescript_compiler}" ]]; then
  typescript_command=("${typescript_compiler}")
elif [[ -f "${typescript_fallback}" ]]; then
  # The checked-in desktop recovery tree is intentionally read-only. Invoking
  # tsc through Node keeps ABI verification available without installing or
  # mutating dependency trees during a release audit.
  typescript_command=(node "${typescript_fallback}")
else
  echo "TypeScript compiler unavailable; restore an app dependency tree first." >&2
  exit 127
fi
"${typescript_command[@]}" \
  --strict \
  --target ES2022 \
  --module commonjs \
  --moduleResolution node \
  --outDir "${work_dir}/typescript" \
  "${core_root}/generated/typescript/mfwProductCoreContract.ts" \
  "${core_root}/generated/typescript/mfwWalletLifecycleContract.ts" \
  "${core_root}/tests/typescript_roundtrip.ts"
node "${work_dir}/typescript/tests/typescript_roundtrip.js"

swiftc \
  "${core_root}/generated/swift/MfwProductCoreContract.swift" \
  "${core_root}/generated/swift/MfwWalletLifecycleContract.swift" \
  "${core_root}/tests/swift/main.swift" \
  -o "${work_dir}/swift-roundtrip"
"${work_dir}/swift-roundtrip"

gradle_root="$(find "${HOME}/.gradle/wrapper/dists/gradle-9.0.0-bin" \
  -type d -name 'gradle-9.0.0' -print -quit)"
test -n "${gradle_root}"
gradle_lib="${gradle_root}/lib"
java -cp "${gradle_lib}/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -no-stdlib \
  -no-reflect \
  -classpath "${gradle_lib}/kotlin-stdlib-2.2.0.jar" \
  -d "${work_dir}/kotlin-roundtrip.jar" \
  "${core_root}/generated/kotlin/MfwProductCoreContract.kt" \
  "${core_root}/generated/kotlin/MfwWalletLifecycleContract.kt" \
  "${core_root}/tests/kotlin_roundtrip.kt"
java -cp "${work_dir}/kotlin-roundtrip.jar:${gradle_lib}/kotlin-stdlib-2.2.0.jar" \
  com.tex8.monero.productcore.Kotlin_roundtripKt
