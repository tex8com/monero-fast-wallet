/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace tex8::community {

constexpr std::size_t kHarrierEmbeddingDimension = 640;
constexpr std::size_t kHarrierMaximumInputTokens = 256;
constexpr std::int64_t kHarrierPaddingToken = 0;
constexpr std::int64_t kHarrierEndToken = 1;

struct HarrierTokens {
  std::vector<std::int64_t> input_ids;
  std::vector<std::int64_t> attention_mask;
  std::size_t unpadded_tokens{0};
};

class CommunityHarrierRuntime final {
 public:
  CommunityHarrierRuntime();
  ~CommunityHarrierRuntime();

  CommunityHarrierRuntime(const CommunityHarrierRuntime&) = delete;
  CommunityHarrierRuntime& operator=(const CommunityHarrierRuntime&) = delete;
  CommunityHarrierRuntime(CommunityHarrierRuntime&&) noexcept;
  CommunityHarrierRuntime& operator=(CommunityHarrierRuntime&&) noexcept;

  // The caller must verify the signed artifact manifest and all bound hashes
  // before calling load(). This class never downloads or substitutes assets.
  bool load(
      const std::string& verified_pte_path,
      const std::string& verified_tokenizer_path,
      std::string& error);

  // `prepared_text` is produced below JavaScript by the native query contract:
  // NFKC, lowercase and whitespace collapse, followed by the frozen query
  // instruction for queries. No renderer-facing API exposes this method.
  bool tokenize_prepared(
      const std::string& prepared_text,
      HarrierTokens& output,
      std::string& error) const;

  bool embed_prepared(
      const std::string& prepared_text,
      std::vector<float>& output,
      std::string& error);

  bool ready() const noexcept;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace tex8::community
