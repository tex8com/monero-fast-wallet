/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "CommunityHarrierAndroidJni.h"

#if defined(TEX8_HARRIER_WITH_ANDROID_JNI_EXECUTORCH)

#include <jni.h>

#include <mutex>

namespace tex8::community {
namespace {

constexpr const char* kBridgeClass =
    "com/monerowallet/CommunityHarrierAndroidBridge";

std::mutex bridge_mutex;
JavaVM* bridge_java_vm = nullptr;
jclass bridge_class = nullptr;
jmethodID load_method = nullptr;
jmethodID forward_method = nullptr;
jmethodID last_error_method = nullptr;

void clear_exception(JNIEnv* env) noexcept {
  if (env->ExceptionCheck()) {
    env->ExceptionClear();
  }
}

std::string read_string(JNIEnv* env, jstring value) {
  if (value == nullptr) {
    return {};
  }
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) {
    clear_exception(env);
    return "Android ExecuTorch returned an unreadable diagnostic";
  }
  std::string result(chars);
  env->ReleaseStringUTFChars(value, chars);
  return result;
}

bool current_environment(JNIEnv*& env, std::string& error) {
  std::lock_guard lock(bridge_mutex);
  if (bridge_java_vm == nullptr ||
      bridge_java_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK ||
      env == nullptr) {
    error = "Android ExecuTorch was called without a Java thread";
    return false;
  }
  return true;
}

bool resolve_bridge(JNIEnv* env, std::string& error) {
  std::lock_guard lock(bridge_mutex);
  if (bridge_class != nullptr) {
    return true;
  }
  jclass local = env->FindClass(kBridgeClass);
  if (local == nullptr) {
    clear_exception(env);
    error = "Android ExecuTorch bridge class is unavailable";
    return false;
  }
  bridge_class = static_cast<jclass>(env->NewGlobalRef(local));
  env->DeleteLocalRef(local);
  load_method = env->GetStaticMethodID(
      bridge_class, "loadVerified", "(Ljava/lang/String;)Ljava/lang/String;");
  forward_method = env->GetStaticMethodID(bridge_class, "forward", "([J[J)[F");
  last_error_method = env->GetStaticMethodID(
      bridge_class, "lastError", "()Ljava/lang/String;");
  if (bridge_class == nullptr || load_method == nullptr || forward_method == nullptr ||
      last_error_method == nullptr) {
    clear_exception(env);
    if (bridge_class != nullptr) {
      env->DeleteGlobalRef(bridge_class);
    }
    bridge_class = nullptr;
    load_method = nullptr;
    forward_method = nullptr;
    last_error_method = nullptr;
    error = "Android ExecuTorch bridge contract is invalid";
    return false;
  }
  return true;
}

std::string last_error(JNIEnv* env) {
  auto* value = static_cast<jstring>(
      env->CallStaticObjectMethod(bridge_class, last_error_method));
  if (env->ExceptionCheck()) {
    clear_exception(env);
    return "Android ExecuTorch failed";
  }
  const auto result = read_string(env, value);
  if (value != nullptr) {
    env->DeleteLocalRef(value);
  }
  return result.empty() ? "Android ExecuTorch failed" : result;
}

}  // namespace

void install_android_java_vm(JavaVM* java_vm) noexcept {
  std::lock_guard lock(bridge_mutex);
  bridge_java_vm = java_vm;
}

bool android_executorch_load(
    const std::string& verified_pte_path,
    std::string& error) {
  JNIEnv* env = nullptr;
  if (!current_environment(env, error) || !resolve_bridge(env, error)) {
    return false;
  }
  jstring path = env->NewStringUTF(verified_pte_path.c_str());
  if (path == nullptr) {
    clear_exception(env);
    error = "Android ExecuTorch could not receive the verified model path";
    return false;
  }
  auto* result = static_cast<jstring>(
      env->CallStaticObjectMethod(bridge_class, load_method, path));
  env->DeleteLocalRef(path);
  if (env->ExceptionCheck()) {
    clear_exception(env);
    error = last_error(env);
    return false;
  }
  error = read_string(env, result);
  if (result != nullptr) {
    env->DeleteLocalRef(result);
  }
  return error.empty();
}

bool android_executorch_forward(
    const std::vector<std::int64_t>& input_ids,
    const std::vector<std::int64_t>& attention_mask,
    std::vector<float>& output,
    std::string& error) {
  if (input_ids.size() != 256 || attention_mask.size() != 256) {
    error = "Android ExecuTorch input contract is invalid";
    return false;
  }
  JNIEnv* env = nullptr;
  if (!current_environment(env, error) || !resolve_bridge(env, error)) {
    return false;
  }
  jlongArray ids = env->NewLongArray(static_cast<jsize>(input_ids.size()));
  jlongArray mask = env->NewLongArray(static_cast<jsize>(attention_mask.size()));
  if (ids == nullptr || mask == nullptr) {
    clear_exception(env);
    if (ids != nullptr) env->DeleteLocalRef(ids);
    if (mask != nullptr) env->DeleteLocalRef(mask);
    error = "Android ExecuTorch input allocation failed";
    return false;
  }
  env->SetLongArrayRegion(ids, 0, static_cast<jsize>(input_ids.size()),
      reinterpret_cast<const jlong*>(input_ids.data()));
  env->SetLongArrayRegion(mask, 0, static_cast<jsize>(attention_mask.size()),
      reinterpret_cast<const jlong*>(attention_mask.data()));
  if (env->ExceptionCheck()) {
    clear_exception(env);
    env->DeleteLocalRef(ids);
    env->DeleteLocalRef(mask);
    error = "Android ExecuTorch input transfer failed";
    return false;
  }
  auto* result = static_cast<jfloatArray>(
      env->CallStaticObjectMethod(bridge_class, forward_method, ids, mask));
  env->DeleteLocalRef(ids);
  env->DeleteLocalRef(mask);
  if (env->ExceptionCheck() || result == nullptr) {
    clear_exception(env);
    error = last_error(env);
    return false;
  }
  const jsize length = env->GetArrayLength(result);
  if (length != 640) {
    env->DeleteLocalRef(result);
    error = "Android ExecuTorch output contract is invalid";
    return false;
  }
  output.resize(static_cast<std::size_t>(length));
  env->GetFloatArrayRegion(result, 0, length, output.data());
  env->DeleteLocalRef(result);
  if (env->ExceptionCheck()) {
    clear_exception(env);
    output.clear();
    error = "Android ExecuTorch output transfer failed";
    return false;
  }
  error.clear();
  return true;
}

}  // namespace tex8::community

#else

namespace tex8::community {
void install_android_java_vm(JavaVM*) noexcept {}
bool android_executorch_load(const std::string&, std::string& error) {
  error = "Android ExecuTorch support is not linked";
  return false;
}
bool android_executorch_forward(
    const std::vector<std::int64_t>&,
    const std::vector<std::int64_t>&,
    std::vector<float>&,
    std::string& error) {
  error = "Android ExecuTorch support is not linked";
  return false;
}
}  // namespace tex8::community

#endif
