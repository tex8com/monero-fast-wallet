/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#pragma once

#include <cstdint>
#include <string>
#include <vector>

// Matches Android NDK jni.h without forcing that platform header into the
// Apple/host build of this cross-platform static C ABI.
struct _JavaVM;
using JavaVM = _JavaVM;

namespace tex8::community {

// The owning wallet JNI library provides the VM exactly once during load. The
// adapter never keeps an Activity, Context, query, or embedding beyond a call.
void install_android_java_vm(JavaVM* java_vm) noexcept;

bool android_executorch_load(
    const std::string& verified_pte_path,
    std::string& error);

bool android_executorch_forward(
    const std::vector<std::int64_t>& input_ids,
    const std::vector<std::int64_t>& attention_mask,
    std::vector<float>& output,
    std::string& error);

}  // namespace tex8::community
