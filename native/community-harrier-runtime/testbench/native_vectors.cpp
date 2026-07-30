/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "CommunityHarrierRuntime.h"

#include <cstddef>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace {

using json = nlohmann::json;

json read_json(const std::string& path) {
  std::ifstream input(path);
  if (!input) {
    throw std::runtime_error("could not open " + path);
  }
  return json::parse(input);
}

void write_json(const std::string& path, const json& value) {
  std::ofstream output(path, std::ios::trunc);
  if (!output) {
    throw std::runtime_error("could not write " + path);
  }
  output << value.dump() << '\n';
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 6) {
    std::cerr
        << "usage: community_harrier_native_vectors "
        << "<pte> <tokenizer-or-directory> <prepared-inputs.json> "
        << "<pte-sha256> <output.json>\n";
    return 2;
  }
  try {
    const auto prepared = read_json(argv[3]);
    tex8::community::CommunityHarrierRuntime runtime;
    std::string error;
    if (!runtime.load(argv[1], argv[2], error)) {
      throw std::runtime_error(error);
    }
    tex8::community::HarrierTokens invalid_tokens;
    const std::string invalid_utf8("\xc0\xaf", 2);
    if (runtime.tokenize_prepared("", invalid_tokens, error) ||
        runtime.tokenize_prepared(invalid_utf8, invalid_tokens, error)) {
      throw std::runtime_error(
          "native tokenizer accepted empty or invalid UTF-8 input");
    }

    json vectors = json::array();
    for (const auto& item : prepared.at("cases")) {
      tex8::community::HarrierTokens tokens;
      if (!runtime.tokenize_prepared(
              item.at("preparedText").get<std::string>(), tokens, error)) {
        throw std::runtime_error(item.at("id").get<std::string>() + ": " + error);
      }
      const auto expected = item.at("inputIds").get<std::vector<std::int64_t>>();
      const std::vector<std::int64_t> actual(
          tokens.input_ids.begin(),
          tokens.input_ids.begin() +
              static_cast<std::ptrdiff_t>(tokens.unpadded_tokens));
      if (actual != expected) {
        throw std::runtime_error(
            item.at("id").get<std::string>() +
            ": native tokenizer differs from the frozen tokenizer");
      }

      std::vector<float> embedding;
      if (!runtime.embed_prepared(
              item.at("preparedText").get<std::string>(), embedding, error)) {
        throw std::runtime_error(item.at("id").get<std::string>() + ": " + error);
      }
      vectors.push_back({
          {"id", item.at("id")},
          {"kind", item.at("kind")},
          {"language", item.at("language")},
          {"embedding", embedding},
      });
    }

    json candidate = {
        {"schemaVersion", 1},
        {"modelId", prepared.at("modelId")},
        {"sourceRevision", prepared.at("sourceRevision")},
        {"sourceWeightsSha256", prepared.at("sourceWeightsSha256")},
        {"tokenizerSha256", prepared.at("tokenizerSha256")},
        {"queryPromptVersion", "community-query-v2"},
        {"documentPromptVersion", "community-document-v1"},
        {"pooling", "last-token"},
        {"normalization", "l2"},
        {"dimension", tex8::community::kHarrierEmbeddingDimension},
        {"maxInputTokens", tex8::community::kHarrierMaximumInputTokens},
        {"referenceCasesSha256", prepared.at("referenceCasesSha256")},
        {"runtime", "executorch"},
        {"runtimeVersion", "1.3.1"},
        {"backend", "xnnpack-a8w8"},
        {"pteSha256", argv[4]},
        {"vectors", vectors},
    };
    write_json(argv[5], candidate);
    std::cout << "wrote " << vectors.size()
              << " native Harrier vectors to " << argv[5] << '\n';
    return 0;
  } catch (const std::exception& exception) {
    std::cerr << "native Harrier test failed: " << exception.what() << '\n';
    return 1;
  }
}
