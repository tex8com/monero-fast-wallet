# Ubuntu dependency remediation

`scripts/check-desktop-security-warnings.sh` has no vulnerability exception or
date override. It requires zero cargo-audit vulnerabilities and exactly the 11
reviewed **unmaintained-package** findings. New findings, unsoundness, yanked
packages, ignored advisories, incomplete index checks or changed warning versions
stop the gate. These maintenance warnings remain visible and need follow-up.

Before and after the audit, `verify-security-source-pins.py` checks complete file
sets and SHA-256 hashes for the GLib upstream backport, eight CryptoBigint API
adapters and five Tor/SSH client forks. The three provenance manifests themselves
are pinned in the verifier. Updating a pin requires source review, not regenerating
hashes to silence a failure. Product manifests must select those path sources;
the Desktop, native protocol and recipient locks require unchanged registry
CryptoBigint 0.7.10 and no RustCrypto RSA. Desktop ZIP is pinned to 9.4.2.

The GLib fix retains 0.18.5 and applies the upstream mutable output-pointer fix.
CryptoBigint arithmetic comes from upstream 0.7.10; adapters preserve protocol
representations. The Tor fork keeps public RSA verification and removes private
RSA operations. See their `third_party` provenance and regression reports.

Run `python3 scripts/test-desktop-security-warnings.py` for isolated positive,
new-finding, tampering and concurrent-change tests. The real gate still needs a
working audit database and crates.io index; `CARGO_AUDIT_NO_FETCH=1` only reuses the
local advisory database and does not disable yanked-package checks.

Passing this dependency gate does not establish installed-package behavior,
formal constant-time guarantees, current native-library advisories, or macOS and
Windows readiness. Those require their own target builds and runtime checks.
