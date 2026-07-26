#pragma once

#include <stddef.h>

// Native user-presence verification. The platform owns the biometric or
// device-credential UI and returns only a result code to Rust.
extern "C" int tex8_desktop_system_auth_available() noexcept;
extern "C" int tex8_desktop_system_authenticate(
    const char* reason,
    void* parent_window) noexcept;

// Presents an operating-system-native recovery form and copies the normalized
// 25-word seed directly into a native caller-owned buffer. The seed never
// enters the Tauri renderer or IPC payloads.
extern "C" int tex8_desktop_prompt_recovery_seed(
    char* output,
    size_t output_length,
    void* parent_window) noexcept;
