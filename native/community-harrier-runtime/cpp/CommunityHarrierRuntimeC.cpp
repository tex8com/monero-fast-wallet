/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "CommunityHarrierRuntimeC.h"

#include "CommunityHarrierRuntime.h"

#include <algorithm>
#include <cstring>
#include <mutex>
#include <new>
#include <string>
#include <vector>

struct tex8_community_harrier_handle {
  std::mutex mutex;
  tex8::community::CommunityHarrierRuntime runtime;
  std::string last_error;
};

namespace {

bool valid_bytes(const uint8_t* bytes, std::size_t length) {
  return bytes != nullptr && length > 0;
}

std::string copy_string(const uint8_t* bytes, std::size_t length) {
  return {
      reinterpret_cast<const char*>(bytes),
      reinterpret_cast<const char*>(bytes) + length,
  };
}

int32_t fail_locked(
    tex8_community_harrier_handle* handle,
    int32_t code,
    const char* message) {
  handle->last_error = message;
  return code;
}

}  // namespace

extern "C" tex8_community_harrier_handle*
tex8_community_harrier_create_v1(void) {
  try {
    return new tex8_community_harrier_handle();
  } catch (...) {
    return nullptr;
  }
}

extern "C" void tex8_community_harrier_destroy_v1(
    tex8_community_harrier_handle* handle) {
  delete handle;
}

extern "C" int32_t tex8_community_harrier_load_verified_v1(
    tex8_community_harrier_handle* handle,
    const uint8_t* pte_path,
    std::size_t pte_path_len,
    const uint8_t* tokenizer_path,
    std::size_t tokenizer_path_len) {
  if (handle == nullptr) {
    return TEX8_COMMUNITY_HARRIER_INVALID_ARGUMENT;
  }
  try {
    std::lock_guard lock(handle->mutex);
    if (!valid_bytes(pte_path, pte_path_len) ||
        !valid_bytes(tokenizer_path, tokenizer_path_len)) {
      return fail_locked(
          handle,
          TEX8_COMMUNITY_HARRIER_INVALID_ARGUMENT,
          "verified Harrier asset path is invalid");
    }
    std::string runtime_error;
    if (!handle->runtime.load(
            copy_string(pte_path, pte_path_len),
            copy_string(tokenizer_path, tokenizer_path_len),
            runtime_error)) {
      return fail_locked(
          handle,
          TEX8_COMMUNITY_HARRIER_RUNTIME_FAILED,
          runtime_error.c_str());
    }
    handle->last_error.clear();
    return TEX8_COMMUNITY_HARRIER_OK;
  } catch (...) {
    try {
      std::lock_guard lock(handle->mutex);
      return fail_locked(
          handle,
          TEX8_COMMUNITY_HARRIER_RUNTIME_FAILED,
          "Harrier runtime initialization failed");
    } catch (...) {
      return TEX8_COMMUNITY_HARRIER_RUNTIME_FAILED;
    }
  }
}

extern "C" int32_t tex8_community_harrier_embed_prepared_v1(
    tex8_community_harrier_handle* handle,
    const uint8_t* prepared_text,
    std::size_t prepared_text_len,
    float* output,
    std::size_t output_len) {
  if (handle == nullptr) {
    return TEX8_COMMUNITY_HARRIER_INVALID_ARGUMENT;
  }
  try {
    std::lock_guard lock(handle->mutex);
    if (!valid_bytes(prepared_text, prepared_text_len) ||
        output == nullptr ||
        output_len != TEX8_COMMUNITY_HARRIER_EMBEDDING_DIMENSION) {
      return fail_locked(
          handle,
          TEX8_COMMUNITY_HARRIER_INVALID_ARGUMENT,
          "Harrier embedding arguments are invalid");
    }
    if (!handle->runtime.ready()) {
      return fail_locked(
          handle,
          TEX8_COMMUNITY_HARRIER_NOT_READY,
          "Harrier runtime is not ready");
    }
    std::vector<float> embedding;
    std::string runtime_error;
    if (!handle->runtime.embed_prepared(
            copy_string(prepared_text, prepared_text_len),
            embedding,
            runtime_error) ||
        embedding.size() != TEX8_COMMUNITY_HARRIER_EMBEDDING_DIMENSION) {
      return fail_locked(
          handle,
          TEX8_COMMUNITY_HARRIER_RUNTIME_FAILED,
          runtime_error.empty()
              ? "Harrier runtime returned an invalid embedding"
              : runtime_error.c_str());
    }
    std::copy(embedding.begin(), embedding.end(), output);
    handle->last_error.clear();
    return TEX8_COMMUNITY_HARRIER_OK;
  } catch (...) {
    try {
      std::lock_guard lock(handle->mutex);
      return fail_locked(
          handle,
          TEX8_COMMUNITY_HARRIER_RUNTIME_FAILED,
          "Harrier embedding failed");
    } catch (...) {
      return TEX8_COMMUNITY_HARRIER_RUNTIME_FAILED;
    }
  }
}

extern "C" int32_t tex8_community_harrier_is_ready_v1(
    tex8_community_harrier_handle* handle) {
  if (handle == nullptr) {
    return 0;
  }
  try {
    std::lock_guard lock(handle->mutex);
    return handle->runtime.ready() ? 1 : 0;
  } catch (...) {
    return 0;
  }
}

extern "C" int32_t tex8_community_harrier_last_error_v1(
    tex8_community_harrier_handle* handle,
    uint8_t* output,
    std::size_t* output_len) {
  if (handle == nullptr || output_len == nullptr) {
    return TEX8_COMMUNITY_HARRIER_INVALID_ARGUMENT;
  }
  try {
    std::lock_guard lock(handle->mutex);
    const std::size_t required = handle->last_error.size() + 1;
    if (output == nullptr) {
      *output_len = required;
      return TEX8_COMMUNITY_HARRIER_OK;
    }
    if (*output_len < required) {
      *output_len = required;
      return TEX8_COMMUNITY_HARRIER_INVALID_ARGUMENT;
    }
    std::memcpy(output, handle->last_error.data(), handle->last_error.size());
    output[handle->last_error.size()] = 0;
    *output_len = required;
    return TEX8_COMMUNITY_HARRIER_OK;
  } catch (...) {
    return TEX8_COMMUNITY_HARRIER_RUNTIME_FAILED;
  }
}
