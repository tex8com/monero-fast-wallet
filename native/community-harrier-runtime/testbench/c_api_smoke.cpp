/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "CommunityHarrierRuntimeC.h"

#include <array>
#include <cstddef>
#include <cstdint>

int main() {
  auto* handle = tex8_community_harrier_create_v1();
  if (handle == nullptr || tex8_community_harrier_is_ready_v1(handle) != 0) {
    tex8_community_harrier_destroy_v1(handle);
    return 1;
  }
  std::array<float, TEX8_COMMUNITY_HARRIER_EMBEDDING_DIMENSION> embedding{};
  const std::array<std::uint8_t, 1> text{{'x'}};
  if (tex8_community_harrier_embed_prepared_v1(
          handle,
          text.data(),
          text.size(),
          embedding.data(),
          embedding.size()) != TEX8_COMMUNITY_HARRIER_NOT_READY) {
    tex8_community_harrier_destroy_v1(handle);
    return 2;
  }
  std::size_t error_length = 0;
  if (tex8_community_harrier_last_error_v1(
          handle, nullptr, &error_length) != TEX8_COMMUNITY_HARRIER_OK ||
      error_length <= 1) {
    tex8_community_harrier_destroy_v1(handle);
    return 3;
  }
  tex8_community_harrier_destroy_v1(handle);
  return 0;
}
