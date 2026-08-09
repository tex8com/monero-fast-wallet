# CUDA wallet derivation backend

This optional Windows/Linux library packages the validated C7 CUDA kernel used
by `tools/wallet-cuda-testbench`. It is dynamically loaded by the common Monero
wallet core, so systems without an NVIDIA GPU or CUDA runtime remain CPU-only.

Safety rules:

- CUDA is never used until its byte-exact known-answer test passes.
- A CUDA load, self-test, dispatch, transfer, or buffer-clear failure returns an
  error and the wallet repeats the batch with its native CPU implementation.
- The shared view scalar and all secret-dependent CUDA buffers are overwritten
  before a successful call returns.
- `Automatic` is the product default. `GPU preferred` never disables the CPU
  fallback and `CPU only` prevents GPU dispatch completely.

The default release build targets SM 7.5, 8.6, 8.9, and 12.0 with CUDA 12.8.
The runtime selects the fastest visible NVIDIA device unless
`MONERO_CUDA_DEVICE` names a valid device index.
