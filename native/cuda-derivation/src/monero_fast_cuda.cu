#include "monero_fast_cuda.h"

// These are the exact arithmetic headers used by the validated C7 benchmark.
// Keeping one implementation prevents the product and testbench from drifting.
#include "derivation_core.cuh"
#include "derivation_radix2625.cuh"

#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <mutex>
#include <string>

namespace
{
  using monero_cuda::u8;
  using monero_cuda::u32;

  constexpr int INVERSE_THREADS = 64;
  constexpr int COMPRESS_THREADS = 128;
  constexpr u32 BATCH_INVERSION_CHUNK = 8;

  void secure_zero_host(void *memory, size_t bytes)
  {
    volatile u8 *cursor = static_cast<volatile u8 *>(memory);
    while (bytes-- != 0)
      *cursor++ = 0;
  }

  std::string cuda_error(const char *operation, cudaError_t status)
  {
    return std::string(operation) + ": " + cudaGetErrorString(status);
  }

  __global__ void fold_scalar_kernel(
      u8 *folded, char *radix8_digits, const u8 *input)
  {
    if (blockIdx.x == 0 && threadIdx.x == 0)
    {
      monero_cuda::fold_scalar(folded, input);
      monero_cuda2625::scalar_as_radix_8_group(radix8_digits, folded);
    }
  }

  __global__ void projective_kernel(
      const char *radix8_digits, const u8 *points, u32 *projective,
      u8 *valid, size_t count)
  {
    const size_t id = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (id >= count)
      return;

    const size_t byte_offset = id * 32;
    const size_t field_offset = id * 30;
    u8 encoded[32];
    for (u32 byte = 0; byte < 32; ++byte)
      encoded[byte] = points[byte_offset + byte];

    monero_cuda2625::Point point, derived;
    if (!monero_cuda2625::point_from_compressed_m6(point, encoded))
    {
      for (u32 limb = 0; limb < 30; ++limb)
        projective[field_offset + limb] = 0;
      valid[id] = 0;
      return;
    }
    monero_cuda2625::point_scalar_multiply_radix8_group(
        derived, point, radix8_digits);
    monero_cuda2625::fe_store_device(projective + field_offset, derived.x);
    monero_cuda2625::fe_store_device(projective + field_offset + 10, derived.y);
    monero_cuda2625::fe_store_device(projective + field_offset + 20, derived.z);
    valid[id] = 1;
  }

  __global__ void inverse_kernel(
      const u32 *projective, u32 *inverse_z, const u8 *valid,
      size_t count, u32 chunk_size)
  {
    const size_t chunk = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    const size_t begin = chunk * chunk_size;
    if (begin >= count)
      return;
    const size_t end = begin + chunk_size < count ? begin + chunk_size : count;

    monero_cuda2625::Fe accumulator;
    monero_cuda2625::fe_one(accumulator);
    for (size_t record = begin; record < end; ++record)
    {
      const size_t field_offset = record * 30;
      const size_t inverse_offset = record * 10;
      monero_cuda2625::fe_store_device(inverse_z + inverse_offset, accumulator);
      monero_cuda2625::Fe z, next;
      if (valid[record] != 0)
        monero_cuda2625::fe_load_device(z, projective + field_offset + 20);
      else
        monero_cuda2625::fe_one(z);
      monero_cuda2625::fe_mul(next, accumulator, z);
      monero_cuda2625::fe_copy(accumulator, next);
    }

    monero_cuda2625::Fe inverse_product;
    monero_cuda2625::fe_inverse_m5(inverse_product, accumulator);
    size_t remaining = end;
    while (remaining != begin)
    {
      const size_t record = --remaining;
      const size_t field_offset = record * 30;
      const size_t inverse_offset = record * 10;
      monero_cuda2625::Fe prefix, z, inverse_record, next;
      monero_cuda2625::fe_load_device(prefix, inverse_z + inverse_offset);
      if (valid[record] != 0)
        monero_cuda2625::fe_load_device(z, projective + field_offset + 20);
      else
        monero_cuda2625::fe_one(z);
      monero_cuda2625::fe_mul(inverse_record, inverse_product, prefix);
      if (valid[record] != 0)
        monero_cuda2625::fe_store_device(inverse_z + inverse_offset, inverse_record);
      else
      {
        monero_cuda2625::Fe zero;
        monero_cuda2625::fe_zero(zero);
        monero_cuda2625::fe_store_device(inverse_z + inverse_offset, zero);
      }
      monero_cuda2625::fe_mul(next, inverse_product, z);
      monero_cuda2625::fe_copy(inverse_product, next);
    }
  }

  __global__ void compress_kernel(
      const u32 *projective, const u32 *inverse_z, u8 *results,
      const u8 *valid, size_t count)
  {
    const size_t id = static_cast<size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (id >= count)
      return;
    const size_t byte_offset = id * 32;
    if (valid[id] == 0)
    {
      for (u32 byte = 0; byte < 32; ++byte)
        results[byte_offset + byte] = 0;
      return;
    }

    const size_t field_offset = id * 30;
    const size_t inverse_offset = id * 10;
    monero_cuda2625::Fe projective_x, projective_y, inverse, x, y;
    monero_cuda2625::fe_load_device(projective_x, projective + field_offset);
    monero_cuda2625::fe_load_device(projective_y, projective + field_offset + 10);
    monero_cuda2625::fe_load_device(inverse, inverse_z + inverse_offset);
    monero_cuda2625::fe_mul(x, projective_x, inverse);
    monero_cuda2625::fe_mul(y, projective_y, inverse);
    u8 encoded[32];
    monero_cuda2625::fe_to_bytes(encoded, y);
    encoded[31] ^= monero_cuda2625::fe_is_negative(x) ? 128 : 0;
    for (u32 byte = 0; byte < 32; ++byte)
      results[byte_offset + byte] = encoded[byte];
  }

  class CudaDerivationContext
  {
  public:
    ~CudaDerivationContext()
    {
      std::lock_guard<std::mutex> lock(mutex_);
      release_locked(true);
    }

    int available()
    {
      std::lock_guard<std::mutex> lock(mutex_);
      return initialize_locked() ? 1 : 0;
    }

    int device_count()
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!probed_)
        (void)initialize_locked();
      return device_count_;
    }

    const char *device_name()
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!probed_)
        (void)initialize_locked();
      return device_name_.c_str();
    }

    const char *last_error()
    {
      std::lock_guard<std::mutex> lock(mutex_);
      return last_error_.c_str();
    }

    int64_t derive(
        u8 *results, const u8 *scalar, const u8 *points, u8 *valid,
        size_t count)
    {
      if (count == 0)
        return 0;
      if (results == nullptr || scalar == nullptr || points == nullptr || valid == nullptr
          || count > std::numeric_limits<size_t>::max() / 120)
        return MONERO_FAST_CUDA_INVALID_ARGUMENT;

      std::lock_guard<std::mutex> lock(mutex_);
      if (!initialize_locked())
        return self_test_failed_ ? MONERO_FAST_CUDA_SELF_TEST_FAILED
                                 : MONERO_FAST_CUDA_UNAVAILABLE;
      return execute_locked(results, scalar, points, valid, count);
    }

    void shutdown()
    {
      std::lock_guard<std::mutex> lock(mutex_);
      release_locked(true);
      probed_ = false;
      initialized_ = false;
      self_test_failed_ = false;
      last_error_.clear();
      device_name_.clear();
      device_count_ = 0;
    }

  private:
    bool initialize_locked()
    {
      if (probed_)
        return initialized_;
      probed_ = true;

      cudaError_t status = cudaGetDeviceCount(&device_count_);
      if (status != cudaSuccess || device_count_ <= 0)
      {
        device_count_ = 0;
        last_error_ = status == cudaSuccess
            ? "No CUDA device is available"
            : cuda_error("CUDA device discovery failed", status);
        return false;
      }

      int selected = select_device_locked();
      status = cudaSetDevice(selected);
      if (status != cudaSuccess)
      {
        last_error_ = cuda_error("CUDA device selection failed", status);
        return false;
      }
      device_ = selected;
      cudaDeviceProp properties{};
      status = cudaGetDeviceProperties(&properties, device_);
      if (status != cudaSuccess)
      {
        last_error_ = cuda_error("CUDA device properties failed", status);
        return false;
      }
      device_name_ = properties.name;
      projective_threads_ = properties.major >= 12 ? 64 : 128;

      // Public, deterministic known-answer vector. It is checked before any
      // real wallet scalar can be dispatched to this backend.
      const std::array<u8, 32> scalar = {
          0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
      const std::array<u8, 64> points = {
          0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
          0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
          0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
          0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
          0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
      const std::array<u8, 32> expected = {
          0x54, 0x42, 0x54, 0xf1, 0xab, 0xca, 0x26, 0xae,
          0x4c, 0xe3, 0xe2, 0xb0, 0x81, 0xbc, 0x96, 0xe7,
          0x94, 0x1d, 0xd7, 0x96, 0xee, 0x29, 0x61, 0x68,
          0xc7, 0xfb, 0x3c, 0xea, 0xe1, 0x3e, 0xe2, 0xf3};
      std::array<u8, 64> actual{};
      std::array<u8, 2> valid{};
      const int64_t successes = execute_locked(
          actual.data(), scalar.data(), points.data(), valid.data(), 2);
      const bool correct = successes == 1 && valid[0] == 1 && valid[1] == 0
          && std::equal(expected.begin(), expected.end(), actual.begin())
          && std::all_of(actual.begin() + 32, actual.end(), [](u8 byte) { return byte == 0; });
      secure_zero_host(actual.data(), actual.size());
      valid.fill(0);
      if (!correct)
      {
        self_test_failed_ = true;
        last_error_ = "CUDA derivation known-answer self-test failed";
        release_locked(false);
        return false;
      }

      initialized_ = true;
      last_error_.clear();
      return true;
    }

    int select_device_locked()
    {
      const char *configured = std::getenv("MONERO_CUDA_DEVICE");
      if (configured != nullptr && *configured != '\0')
      {
        errno = 0;
        char *end = nullptr;
        const long parsed = std::strtol(configured, &end, 10);
        if (errno == 0 && end != nullptr && *end == '\0'
            && parsed >= 0 && parsed < device_count_)
          return static_cast<int>(parsed);
      }

      int best = 0;
      long long best_score = -1;
      for (int index = 0; index < device_count_; ++index)
      {
        cudaDeviceProp properties{};
        if (cudaGetDeviceProperties(&properties, index) != cudaSuccess)
          continue;
        const long long score = static_cast<long long>(properties.multiProcessorCount)
            * static_cast<long long>(properties.clockRate);
        if (score > best_score)
        {
          best = index;
          best_score = score;
        }
      }
      return best;
    }

    bool ensure_capacity_locked(size_t count)
    {
      if (count <= capacity_)
        return true;
      release_buffers_locked();

      const size_t point_bytes = count * 32;
      const size_t projective_bytes = count * 30 * sizeof(u32);
      const size_t inverse_bytes = count * 10 * sizeof(u32);
      auto allocate = [&](void **target, size_t bytes) {
        const cudaError_t status = cudaMalloc(target, bytes);
        if (status != cudaSuccess)
        {
          last_error_ = cuda_error("CUDA buffer allocation failed", status);
          return false;
        }
        return true;
      };
      if (!allocate(reinterpret_cast<void **>(&scalar_), 32)
          || !allocate(reinterpret_cast<void **>(&folded_), 32)
          || !allocate(reinterpret_cast<void **>(&radix8_digits_), 86)
          || !allocate(reinterpret_cast<void **>(&points_), point_bytes)
          || !allocate(reinterpret_cast<void **>(&results_), point_bytes)
          || !allocate(reinterpret_cast<void **>(&valid_), count)
          || !allocate(reinterpret_cast<void **>(&projective_), projective_bytes)
          || !allocate(reinterpret_cast<void **>(&inverse_z_), inverse_bytes))
      {
        release_buffers_locked();
        return false;
      }
      capacity_ = count;
      return true;
    }

    int64_t execute_locked(
        u8 *host_results, const u8 *host_scalar, const u8 *host_points,
        u8 *host_valid, size_t count)
    {
      if (!ensure_capacity_locked(count))
        return MONERO_FAST_CUDA_EXECUTION_ERROR;
      const size_t point_bytes = count * 32;
      cudaError_t status = cudaMemcpy(scalar_, host_scalar, 32, cudaMemcpyHostToDevice);
      if (status == cudaSuccess)
        status = cudaMemcpy(points_, host_points, point_bytes, cudaMemcpyHostToDevice);
      if (status != cudaSuccess)
        return fail_and_clear_locked("CUDA input transfer failed", status, count);

      fold_scalar_kernel<<<1, 1>>>(folded_, radix8_digits_, scalar_);
      const size_t blocks_size = (count + projective_threads_ - 1) / projective_threads_;
      const size_t chunks = (count + BATCH_INVERSION_CHUNK - 1) / BATCH_INVERSION_CHUNK;
      const size_t inverse_blocks_size = (chunks + INVERSE_THREADS - 1) / INVERSE_THREADS;
      const size_t compress_blocks_size = (count + COMPRESS_THREADS - 1) / COMPRESS_THREADS;
      if (blocks_size > static_cast<size_t>(std::numeric_limits<int>::max())
          || inverse_blocks_size > static_cast<size_t>(std::numeric_limits<int>::max())
          || compress_blocks_size > static_cast<size_t>(std::numeric_limits<int>::max()))
      {
        last_error_ = "CUDA grid size exceeds the supported range";
        clear_device_buffers_locked(count);
        return MONERO_FAST_CUDA_INVALID_ARGUMENT;
      }
      projective_kernel<<<static_cast<int>(blocks_size), projective_threads_>>>(
          radix8_digits_, points_, projective_, valid_, count);
      inverse_kernel<<<static_cast<int>(inverse_blocks_size), INVERSE_THREADS>>>(
          projective_, inverse_z_, valid_, count, BATCH_INVERSION_CHUNK);
      compress_kernel<<<static_cast<int>(compress_blocks_size), COMPRESS_THREADS>>>(
          projective_, inverse_z_, results_, valid_, count);
      status = cudaGetLastError();
      if (status == cudaSuccess)
        status = cudaDeviceSynchronize();
      if (status != cudaSuccess)
        return fail_and_clear_locked("CUDA derivation dispatch failed", status, count);

      status = cudaMemcpy(host_results, results_, point_bytes, cudaMemcpyDeviceToHost);
      if (status == cudaSuccess)
        status = cudaMemcpy(host_valid, valid_, count, cudaMemcpyDeviceToHost);
      if (status != cudaSuccess)
        return fail_and_clear_locked("CUDA result transfer failed", status, count);

      int64_t successes = 0;
      for (size_t index = 0; index < count; ++index)
        successes += host_valid[index] == 1 ? 1 : 0;
      if (!clear_device_buffers_locked(count))
      {
        disable_after_clear_failure_locked();
        return MONERO_FAST_CUDA_EXECUTION_ERROR;
      }
      return successes;
    }

    int64_t fail_and_clear_locked(const char *operation, cudaError_t status, size_t count)
    {
      last_error_ = cuda_error(operation, status);
      if (!clear_device_buffers_locked(count))
        disable_after_clear_failure_locked();
      return MONERO_FAST_CUDA_EXECUTION_ERROR;
    }

    void disable_after_clear_failure_locked()
    {
      // A reset destroys the complete CUDA context and is the last-resort
      // erasure path when an ordinary cudaMemset/cudaDeviceSynchronize cannot
      // prove that secret-dependent buffers were overwritten.
      (void)cudaDeviceReset();
      scalar_ = nullptr;
      folded_ = nullptr;
      radix8_digits_ = nullptr;
      points_ = nullptr;
      results_ = nullptr;
      valid_ = nullptr;
      projective_ = nullptr;
      inverse_z_ = nullptr;
      capacity_ = 0;
      device_ = -1;
      initialized_ = false;
    }

    bool clear_device_buffers_locked(size_t count)
    {
      if (capacity_ == 0)
        return true;
      const size_t point_bytes = count * 32;
      const size_t projective_bytes = count * 30 * sizeof(u32);
      const size_t inverse_bytes = count * 10 * sizeof(u32);
      cudaError_t first = cudaSuccess;
      const auto clear = [&](void *pointer, size_t bytes) {
        if (pointer == nullptr || bytes == 0)
          return;
        const cudaError_t status = cudaMemset(pointer, 0, bytes);
        if (first == cudaSuccess && status != cudaSuccess)
          first = status;
      };
      clear(scalar_, 32);
      clear(folded_, 32);
      clear(radix8_digits_, 86);
      clear(points_, point_bytes);
      clear(results_, point_bytes);
      clear(valid_, count);
      clear(projective_, projective_bytes);
      clear(inverse_z_, inverse_bytes);
      const cudaError_t synchronized = cudaDeviceSynchronize();
      if (first == cudaSuccess)
        first = synchronized;
      if (first != cudaSuccess)
      {
        last_error_ = cuda_error("CUDA secure buffer clearing failed", first);
        return false;
      }
      return true;
    }

    void release_buffers_locked()
    {
      if (capacity_ != 0)
        (void)clear_device_buffers_locked(capacity_);
      for (void *pointer : {static_cast<void *>(scalar_), static_cast<void *>(folded_),
                            static_cast<void *>(radix8_digits_), static_cast<void *>(points_),
                            static_cast<void *>(results_), static_cast<void *>(valid_),
                            static_cast<void *>(projective_), static_cast<void *>(inverse_z_)})
      {
        if (pointer != nullptr)
          (void)cudaFree(pointer);
      }
      scalar_ = nullptr;
      folded_ = nullptr;
      radix8_digits_ = nullptr;
      points_ = nullptr;
      results_ = nullptr;
      valid_ = nullptr;
      projective_ = nullptr;
      inverse_z_ = nullptr;
      capacity_ = 0;
    }

    void release_locked(bool reset_device)
    {
      if (device_ >= 0)
      {
        (void)cudaSetDevice(device_);
        release_buffers_locked();
        if (reset_device)
          (void)cudaDeviceReset();
      }
      device_ = -1;
    }

    std::mutex mutex_;
    bool probed_ = false;
    bool initialized_ = false;
    bool self_test_failed_ = false;
    int device_count_ = 0;
    int device_ = -1;
    int projective_threads_ = 128;
    size_t capacity_ = 0;
    u8 *scalar_ = nullptr;
    u8 *folded_ = nullptr;
    char *radix8_digits_ = nullptr;
    u8 *points_ = nullptr;
    u8 *results_ = nullptr;
    u8 *valid_ = nullptr;
    u32 *projective_ = nullptr;
    u32 *inverse_z_ = nullptr;
    std::string device_name_;
    std::string last_error_;
  };

  CudaDerivationContext &context()
  {
    static CudaDerivationContext instance;
    return instance;
  }
}

extern "C" int fast_cuda_derivation_available(void)
{
  return context().available();
}

extern "C" int fast_cuda_derivation_device_count(void)
{
  return context().device_count();
}

extern "C" const char *fast_cuda_derivation_device_name(void)
{
  return context().device_name();
}

extern "C" const char *fast_cuda_derivation_last_error(void)
{
  return context().last_error();
}

extern "C" int64_t fast_cuda_generate_key_derivation_batch_same_scalar(
    uint8_t *results, const uint8_t *scalar, const uint8_t *points,
    uint8_t *valid, size_t count)
{
  return context().derive(results, scalar, points, valid, count);
}

extern "C" void fast_cuda_derivation_shutdown(void)
{
  context().shutdown();
}
