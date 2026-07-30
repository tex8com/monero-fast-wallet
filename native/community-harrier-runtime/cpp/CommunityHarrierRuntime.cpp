/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "CommunityHarrierRuntime.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <mutex>
#include <utility>

#include <pytorch/tokenizers/hf_tokenizer.h>

#if defined(TEX8_HARRIER_WITH_EXECUTORCH)
#include <executorch/extension/module/module.h>
#include <executorch/extension/tensor/tensor.h>
#endif

namespace tex8::community {

namespace {

constexpr double kMinimumOutputNorm = 0.999;
constexpr double kMaximumOutputNorm = 1.001;

bool valid_utf8(const std::string& value) {
  std::size_t index = 0;
  while (index < value.size()) {
    const auto first = static_cast<std::uint8_t>(value[index]);
    std::size_t continuation = 0;
    std::uint32_t codepoint = 0;
    if (first <= 0x7f) {
      ++index;
      continue;
    }
    if ((first & 0xe0) == 0xc0) {
      continuation = 1;
      codepoint = first & 0x1f;
      if (codepoint == 0) {
        return false;
      }
    } else if ((first & 0xf0) == 0xe0) {
      continuation = 2;
      codepoint = first & 0x0f;
    } else if ((first & 0xf8) == 0xf0) {
      continuation = 3;
      codepoint = first & 0x07;
    } else {
      return false;
    }
    if (index + continuation >= value.size()) {
      return false;
    }
    for (std::size_t offset = 1; offset <= continuation; ++offset) {
      const auto byte = static_cast<std::uint8_t>(value[index + offset]);
      if ((byte & 0xc0) != 0x80) {
        return false;
      }
      codepoint = (codepoint << 6) | (byte & 0x3f);
    }
    if ((continuation == 1 && codepoint < 0x80) ||
        (continuation == 2 && codepoint < 0x800) ||
        (continuation == 3 && codepoint < 0x10000) ||
        (codepoint >= 0xd800 && codepoint <= 0xdfff) ||
        codepoint > 0x10ffff) {
      return false;
    }
    index += continuation + 1;
  }
  return true;
}

}  // namespace

class CommunityHarrierRuntime::Impl final {
 public:
  tokenizers::HFTokenizer tokenizer;
#if defined(TEX8_HARRIER_WITH_EXECUTORCH)
  std::unique_ptr<executorch::extension::Module> module;
#endif
  bool tokenizer_ready{false};
  mutable std::mutex execution_mutex;
};

CommunityHarrierRuntime::CommunityHarrierRuntime()
    : impl_(std::make_unique<Impl>()) {}

CommunityHarrierRuntime::~CommunityHarrierRuntime() = default;
CommunityHarrierRuntime::CommunityHarrierRuntime(
    CommunityHarrierRuntime&&) noexcept = default;
CommunityHarrierRuntime& CommunityHarrierRuntime::operator=(
    CommunityHarrierRuntime&&) noexcept = default;

bool CommunityHarrierRuntime::load(
    const std::string& verified_pte_path,
    const std::string& verified_tokenizer_path,
    std::string& error) {
  if (verified_tokenizer_path.empty()) {
    error = "verified tokenizer path is empty";
    return false;
  }
  if (impl_->tokenizer.load(verified_tokenizer_path) != tokenizers::Error::Ok) {
    error = "verified tokenizer could not be loaded";
    return false;
  }
  impl_->tokenizer_ready = true;

#if defined(TEX8_HARRIER_WITH_EXECUTORCH)
  if (verified_pte_path.empty()) {
    error = "verified PTE path is empty";
    return false;
  }
  auto module = std::make_unique<executorch::extension::Module>(
      verified_pte_path,
      executorch::extension::Module::LoadMode::MmapUseMadvise);
  const auto load_error = module->load(
      executorch::runtime::Program::Verification::InternalConsistency);
  if (load_error != executorch::runtime::Error::Ok) {
    error = "verified PTE could not be loaded";
    return false;
  }
  if (module->load_forward() != executorch::runtime::Error::Ok) {
    error = "verified PTE forward method could not be loaded";
    return false;
  }
  impl_->module = std::move(module);
#else
  (void)verified_pte_path;
#endif
  error.clear();
  return true;
}

bool CommunityHarrierRuntime::tokenize_prepared(
    const std::string& prepared_text,
    HarrierTokens& output,
    std::string& error) const {
  if (!impl_->tokenizer_ready) {
    error = "Harrier tokenizer is not loaded";
    return false;
  }
  if (prepared_text.empty() || !valid_utf8(prepared_text)) {
    error = "prepared Harrier text must be non-empty UTF-8";
    return false;
  }
  auto encoded = impl_->tokenizer.encode(prepared_text, 1, 1);
  if (!encoded.ok()) {
    error = "prepared Harrier text could not be tokenized";
    return false;
  }
  auto token_ids = std::move(encoded.get());
  if (token_ids.empty()) {
    error = "Harrier tokenizer returned no tokens";
    return false;
  }
  if (token_ids.size() > kHarrierMaximumInputTokens) {
    token_ids.resize(kHarrierMaximumInputTokens);
    token_ids.back() = static_cast<std::uint64_t>(kHarrierEndToken);
  }

  output.input_ids.assign(
      kHarrierMaximumInputTokens, kHarrierPaddingToken);
  output.attention_mask.assign(kHarrierMaximumInputTokens, 0);
  output.unpadded_tokens = token_ids.size();
  for (std::size_t index = 0; index < token_ids.size(); ++index) {
    if (token_ids[index] >
        static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
      error = "Harrier tokenizer returned an invalid token";
      return false;
    }
    output.input_ids[index] = static_cast<std::int64_t>(token_ids[index]);
    output.attention_mask[index] = 1;
  }
  error.clear();
  return true;
}

bool CommunityHarrierRuntime::embed_prepared(
    const std::string& prepared_text,
    std::vector<float>& output,
    std::string& error) {
  HarrierTokens tokens;
  if (!tokenize_prepared(prepared_text, tokens, error)) {
    return false;
  }

#if defined(TEX8_HARRIER_WITH_EXECUTORCH)
  if (!impl_->module) {
    error = "Harrier ExecuTorch module is not loaded";
    return false;
  }
  std::lock_guard lock(impl_->execution_mutex);
  auto input_ids = executorch::extension::from_blob(
      tokens.input_ids.data(),
      {1, static_cast<executorch::aten::SizesType>(kHarrierMaximumInputTokens)},
      executorch::aten::ScalarType::Long,
      executorch::aten::TensorShapeDynamism::STATIC);
  auto attention_mask = executorch::extension::from_blob(
      tokens.attention_mask.data(),
      {1, static_cast<executorch::aten::SizesType>(kHarrierMaximumInputTokens)},
      executorch::aten::ScalarType::Long,
      executorch::aten::TensorShapeDynamism::STATIC);
  std::vector<executorch::runtime::EValue> inputs;
  inputs.emplace_back(*input_ids);
  inputs.emplace_back(*attention_mask);
  auto result = impl_->module->forward(inputs);
  if (!result.ok() || result->size() != 1 || !result->front().isTensor()) {
    error = "Harrier ExecuTorch inference failed";
    return false;
  }
  const auto tensor = result->front().toTensor();
  if (tensor.scalar_type() != executorch::aten::ScalarType::Float ||
      tensor.numel() != kHarrierEmbeddingDimension) {
    error = "Harrier ExecuTorch output contract is invalid";
    return false;
  }
  const auto* values = tensor.const_data_ptr<float>();
  output.assign(values, values + kHarrierEmbeddingDimension);
  double squared_norm = 0.0;
  for (const float value : output) {
    if (!std::isfinite(value)) {
      error = "Harrier ExecuTorch output is non-finite";
      return false;
    }
    squared_norm += static_cast<double>(value) * value;
  }
  const double norm = std::sqrt(squared_norm);
  if (norm < kMinimumOutputNorm || norm > kMaximumOutputNorm) {
    error = "Harrier ExecuTorch output is not L2-normalized";
    return false;
  }
  error.clear();
  return true;
#else
  (void)output;
  error = "Harrier runtime was built without ExecuTorch";
  return false;
#endif
}

bool CommunityHarrierRuntime::ready() const noexcept {
#if defined(TEX8_HARRIER_WITH_EXECUTORCH)
  return impl_->tokenizer_ready && impl_->module != nullptr;
#else
  return false;
#endif
}

}  // namespace tex8::community
