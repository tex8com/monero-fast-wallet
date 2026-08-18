# License boundary map

This directory makes the root multi-license grant explicit and reviewable.

| Repository scope | SPDX expression | Local license text |
| --- | --- | --- |
| `wallets/**`, `packages/**` | `MPL-2.0` | `MPL-2.0.txt` |
| `backend/**` | `AGPL-3.0-only` | `AGPL-3.0-only.txt` |
| Project-authored `native/**`, `config/**`, `scripts/**`, `tools/**`, `docs/**`, and root support files | `Apache-2.0 OR MIT` | `Apache-2.0.txt`, `MIT.txt` |
| Project-authored Monero-derived patches | `BSD-3-Clause` | `BSD-3-Clause.txt` |
| `node/mfn-monero-fast-node/**` | Upstream Cuprate map | `../node/mfn-monero-fast-node/LICENSE*` |
| `third_party/**`, vendored/generated upstream files | Component notice | Component-local notice and generated release report |

Exceptions:

- A closer `LICENSE`, `COPYING`, `NOTICE`, SPDX identifier, or retained
  copyright notice overrides this directory default.
- A build artifact must include the applicable project text plus every
  dependency notice reported by the compliance generator.
- AGPL service operators must offer the complete corresponding source of the
  exact deployed version as required by AGPL section 13.
- The root grant does not relicense upstream Monero or Cuprate source.

The standard license text files must not be shortened or paraphrased.
