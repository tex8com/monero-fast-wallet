#include "WalletEngine.h"
#include "FastWalletProtocolBridge.h"
#include "mfw_product_core_contract.h"

static_assert(MFW_PRODUCT_CORE_ABI_VERSION == 1u,
              "Mobile JNI was built against an unsupported Product Core ABI");

#ifndef TEX8_COMMUNITY_MATRIX_LINKED
#define TEX8_COMMUNITY_MATRIX_LINKED 0
#endif

#ifndef TEX8_COMMUNITY_RUNTIME_LINKED
#define TEX8_COMMUNITY_RUNTIME_LINKED 0
#endif

#if TEX8_COMMUNITY_MATRIX_LINKED
#include "community_matrix_core.h"
#endif

#if TEX8_COMMUNITY_RUNTIME_LINKED
#include "community_runtime_core.h"
#include "CommunityHarrierRuntimeC.h"
#endif

#include <jni.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr uint32_t kMfwNameMaximumTermYears = 1000;
constexpr uint64_t kMfwNameAnnualFeeAtomic = 10000000000ULL;

using tex8::wallet::CreateWalletRequest;
using tex8::wallet::CreateWalletFromDeviceRequest;
using tex8::wallet::CreateViewOnlyWalletRequest;
using tex8::wallet::CreateFastReceiveIdentityRequest;
using tex8::wallet::DaemonConfig;
using tex8::wallet::FastReceiveIdentity;
using tex8::wallet::FastReceiveRegistrationPayload;
using tex8::wallet::HardwareWalletStatus;
using tex8::wallet::LedgerBleTransportCallbacks;
using tex8::wallet::LedgerKeyImageSyncResult;
using tex8::wallet::NetworkType;
using tex8::wallet::NetworkSyncStatus;
using tex8::wallet::OpenWalletRequest;
using tex8::wallet::PreparedTransaction;
using tex8::wallet::PrepareTransactionRequest;
using tex8::wallet::RestoreWalletRequest;
using tex8::wallet::WalletEngine;
using tex8::wallet::WalletEngineError;
using tex8::wallet::WalletSnapshot;
using tex8::wallet::WalletSubaddress;
using tex8::wallet::WalletTransaction;
using tex8::wallet::WalletTransactionTransfer;

WalletEngine& walletEngine() {
  static WalletEngine engine;
  return engine;
}

#if TEX8_COMMUNITY_MATRIX_LINKED
std::mutex communityMatrixMutex;
tex8_community_matrix_handle* communityMatrixHandle = nullptr;

std::string communityMatrixError() {
  if (communityMatrixHandle == nullptr) {
    return "The private chat session is unavailable";
  }
  std::array<uint8_t, 4096> buffer{};
  size_t length = buffer.size();
  if (tex8_community_matrix_last_error_v1(
          communityMatrixHandle, buffer.data(), &length) !=
          TEX8_COMMUNITY_MATRIX_OK ||
      length == 0) {
    return "The private chat operation failed";
  }
  return std::string(
      reinterpret_cast<const char*>(buffer.data()),
      strnlen(reinterpret_cast<const char*>(buffer.data()), buffer.size()));
}

void requireCommunityMatrixStatus(int32_t status) {
  if (status != TEX8_COMMUNITY_MATRIX_OK) {
    const auto message = communityMatrixError();
    throw WalletEngineError(
        message.empty() ? "The private chat operation failed" : message);
  }
}

std::string takeCommunityMatrixOutput(uint8_t* output, size_t length) {
  if (output == nullptr || length == 0) {
    throw WalletEngineError("The private chat returned an invalid response");
  }
  std::string result(reinterpret_cast<const char*>(output), length);
  tex8_community_matrix_free_buffer_v1(output, length);
  return result;
}
#endif

#if TEX8_COMMUNITY_RUNTIME_LINKED
std::mutex communityRuntimeMutex;
tex8_community_runtime_handle* communityRuntimeHandle = nullptr;

std::string communityRuntimeError() {
  if (communityRuntimeHandle == nullptr) {
    return "The local Community catalog is unavailable";
  }
  std::array<uint8_t, 4096> buffer{};
  size_t length = buffer.size();
  if (tex8_community_runtime_last_error_v1(
          communityRuntimeHandle, buffer.data(), &length) !=
          TEX8_COMMUNITY_RUNTIME_OK ||
      length == 0) {
    return "The local Community operation failed";
  }
  return std::string(
      reinterpret_cast<const char*>(buffer.data()),
      strnlen(reinterpret_cast<const char*>(buffer.data()), buffer.size()));
}

void requireCommunityRuntimeStatus(int32_t status) {
  if (status != TEX8_COMMUNITY_RUNTIME_OK) {
    const auto message = communityRuntimeError();
    throw WalletEngineError(
        message.empty() ? "The local Community operation failed" : message);
  }
}

std::string takeCommunityRuntimeOutput(uint8_t* output, size_t length) {
  if (output == nullptr || length == 0) {
    throw WalletEngineError("The local Community search returned an invalid response");
  }
  std::string result(reinterpret_cast<const char*>(output), length);
  tex8_community_runtime_free_buffer_v1(output, length);
  return result;
}
#endif

JavaVM* ledgerJavaVm = nullptr;
jclass ledgerBridgeClass = nullptr;
jmethodID ledgerConnectMethod = nullptr;
jmethodID ledgerDisconnectMethod = nullptr;
jmethodID ledgerConnectedMethod = nullptr;
jmethodID ledgerExchangeMethod = nullptr;
std::mutex ledgerBridgeMutex;

JNIEnv* ledgerEnvironment(bool& attached) {
  attached = false;
  if (ledgerJavaVm == nullptr) {
    return nullptr;
  }
  JNIEnv* env = nullptr;
  const jint status = ledgerJavaVm->GetEnv(
      reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
  if (status == JNI_OK) {
    return env;
  }
  if (status != JNI_EDETACHED ||
      ledgerJavaVm->AttachCurrentThread(&env, nullptr) != JNI_OK) {
    return nullptr;
  }
  attached = true;
  return env;
}

void clearLedgerJavaException(JNIEnv* env) {
  if (env != nullptr && env->ExceptionCheck()) {
    env->ExceptionClear();
  }
}

bool androidLedgerConnect(void*) {
  bool attached = false;
  JNIEnv* env = ledgerEnvironment(attached);
  if (env == nullptr || ledgerBridgeClass == nullptr || ledgerConnectMethod == nullptr) {
    return false;
  }
  const bool result = env->CallStaticBooleanMethod(
      ledgerBridgeClass, ledgerConnectMethod) == JNI_TRUE;
  if (env->ExceptionCheck()) {
    clearLedgerJavaException(env);
    if (attached) ledgerJavaVm->DetachCurrentThread();
    return false;
  }
  if (attached) ledgerJavaVm->DetachCurrentThread();
  return result;
}

void androidLedgerDisconnect(void*) {
  bool attached = false;
  JNIEnv* env = ledgerEnvironment(attached);
  if (env != nullptr && ledgerBridgeClass != nullptr && ledgerDisconnectMethod != nullptr) {
    env->CallStaticVoidMethod(ledgerBridgeClass, ledgerDisconnectMethod);
    clearLedgerJavaException(env);
  }
  if (attached) ledgerJavaVm->DetachCurrentThread();
}

bool androidLedgerConnected(void*) {
  bool attached = false;
  JNIEnv* env = ledgerEnvironment(attached);
  if (env == nullptr || ledgerBridgeClass == nullptr || ledgerConnectedMethod == nullptr) {
    return false;
  }
  const bool result = env->CallStaticBooleanMethod(
      ledgerBridgeClass, ledgerConnectedMethod) == JNI_TRUE;
  if (env->ExceptionCheck()) {
    clearLedgerJavaException(env);
    if (attached) ledgerJavaVm->DetachCurrentThread();
    return false;
  }
  if (attached) ledgerJavaVm->DetachCurrentThread();
  return result;
}

int androidLedgerExchange(
    void*,
    const unsigned char* command,
    unsigned int commandLength,
    unsigned char* response,
    unsigned int responseCapacity,
    bool userInput) {
  bool attached = false;
  JNIEnv* env = ledgerEnvironment(attached);
  if (env == nullptr || ledgerBridgeClass == nullptr || ledgerExchangeMethod == nullptr) {
    return -1;
  }

  jbyteArray javaCommand = env->NewByteArray(static_cast<jsize>(commandLength));
  if (javaCommand == nullptr) {
    if (attached) ledgerJavaVm->DetachCurrentThread();
    return -1;
  }
  env->SetByteArrayRegion(
      javaCommand, 0, static_cast<jsize>(commandLength),
      reinterpret_cast<const jbyte*>(command));
  auto javaResponse = static_cast<jbyteArray>(env->CallStaticObjectMethod(
      ledgerBridgeClass,
      ledgerExchangeMethod,
      javaCommand,
      userInput ? JNI_TRUE : JNI_FALSE));
  env->DeleteLocalRef(javaCommand);
  if (env->ExceptionCheck() || javaResponse == nullptr) {
    clearLedgerJavaException(env);
    if (attached) ledgerJavaVm->DetachCurrentThread();
    return -1;
  }

  const jsize responseLength = env->GetArrayLength(javaResponse);
  if (responseLength < 0 ||
      static_cast<unsigned int>(responseLength) > responseCapacity) {
    env->DeleteLocalRef(javaResponse);
    if (attached) ledgerJavaVm->DetachCurrentThread();
    return -1;
  }
  env->GetByteArrayRegion(
      javaResponse, 0, responseLength, reinterpret_cast<jbyte*>(response));
  env->DeleteLocalRef(javaResponse);
  if (attached) ledgerJavaVm->DetachCurrentThread();
  return static_cast<int>(responseLength);
}

std::string toStdString(JNIEnv* env, jstring value) {
  if (value == nullptr) {
    return {};
  }

  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) {
    throw WalletEngineError("failed to read Java string");
  }

  std::string result(chars);
  env->ReleaseStringUTFChars(value, chars);
  return result;
}

std::vector<unsigned char> toByteVector(
    JNIEnv* env,
    jbyteArray value,
    std::size_t minimum,
    std::size_t maximum) {
  if (value == nullptr) {
    throw WalletEngineError("Java byte array is missing");
  }
  const jsize length = env->GetArrayLength(value);
  if (length < 0 || static_cast<std::size_t>(length) < minimum ||
      static_cast<std::size_t>(length) > maximum) {
    throw WalletEngineError("Java byte array has an invalid length");
  }
  std::vector<unsigned char> result(static_cast<std::size_t>(length));
  env->GetByteArrayRegion(
      value, 0, length, reinterpret_cast<jbyte*>(result.data()));
  if (env->ExceptionCheck()) {
    throw WalletEngineError("failed to read Java byte array");
  }
  return result;
}

jstring toJavaString(JNIEnv* env, const std::string& value) {
  return env->NewStringUTF(value.c_str());
}

jbyteArray toJavaByteArray(
    JNIEnv* env,
    const std::vector<unsigned char>& value) {
  if (value.size() >
      static_cast<std::size_t>(std::numeric_limits<jsize>::max())) {
    throw WalletEngineError("native byte array is too large");
  }
  auto output = env->NewByteArray(static_cast<jsize>(value.size()));
  if (output == nullptr) {
    throw WalletEngineError("failed to allocate Java byte array");
  }
  env->SetByteArrayRegion(
      output, 0, static_cast<jsize>(value.size()),
      reinterpret_cast<const jbyte*>(value.data()));
  if (env->ExceptionCheck()) {
    env->DeleteLocalRef(output);
    throw WalletEngineError("failed to write Java byte array");
  }
  return output;
}

NetworkType parseNetwork(const std::string& value) {
  if (value == "mainnet") {
    return NetworkType::Mainnet;
  }
  if (value == "testnet") {
    return NetworkType::Testnet;
  }
  if (value == "stagenet") {
    return NetworkType::Stagenet;
  }
  throw WalletEngineError("unknown network: " + value);
}

std::string networkName(NetworkType network) {
  switch (network) {
    case NetworkType::Mainnet:
      return "mainnet";
    case NetworkType::Testnet:
      return "testnet";
    case NetworkType::Stagenet:
      return "stagenet";
  }

  throw WalletEngineError("unknown wallet network");
}

uint64_t toUInt64(jdouble value, const char* fieldName) {
  if (value < 0 ||
      value > static_cast<jdouble>(std::numeric_limits<uint64_t>::max())) {
    throw WalletEngineError(std::string(fieldName) + " is out of range");
  }
  return static_cast<uint64_t>(value);
}

uint64_t toExactUInt64(jdouble value, const char* fieldName) {
  if (!std::isfinite(value) || value != std::floor(value)) {
    throw WalletEngineError(std::string(fieldName) + " is out of range");
  }
  return toUInt64(value, fieldName);
}

unsigned char toUnsignedByte(jdouble value, const char* fieldName) {
  const auto converted = toExactUInt64(value, fieldName);
  if (converted > std::numeric_limits<unsigned char>::max()) {
    throw WalletEngineError(std::string(fieldName) + " is out of range");
  }
  return static_cast<unsigned char>(converted);
}

uint32_t toUInt32(jdouble value, const char* fieldName) {
  if (value < 0 ||
      value > static_cast<jdouble>(std::numeric_limits<uint32_t>::max())) {
    throw WalletEngineError(std::string(fieldName) + " is out of range");
  }
  return static_cast<uint32_t>(value);
}

void throwJavaError(JNIEnv* env, const std::exception& error) {
  jclass errorClass = env->FindClass("java/lang/IllegalStateException");
  if (errorClass != nullptr) {
    env->ThrowNew(errorClass, error.what());
  }
}

jobject boxedDouble(JNIEnv* env, double value) {
  jclass doubleClass = env->FindClass("java/lang/Double");
  jmethodID valueOf =
      env->GetStaticMethodID(doubleClass, "valueOf", "(D)Ljava/lang/Double;");
  return env->CallStaticObjectMethod(doubleClass, valueOf, value);
}

jobject boxedBoolean(JNIEnv* env, bool value) {
  jclass booleanClass = env->FindClass("java/lang/Boolean");
  jmethodID valueOf =
      env->GetStaticMethodID(booleanClass, "valueOf", "(Z)Ljava/lang/Boolean;");
  return env->CallStaticObjectMethod(booleanClass, valueOf, value);
}

void putMapString(
    JNIEnv* env,
    jobject map,
    jmethodID putMethod,
    const char* key,
    const std::string& value) {
  jstring javaKey = toJavaString(env, key);
  jstring javaValue = toJavaString(env, value);
  env->CallObjectMethod(map, putMethod, javaKey, javaValue);
  env->DeleteLocalRef(javaKey);
  env->DeleteLocalRef(javaValue);
}

void putMapDouble(
    JNIEnv* env,
    jobject map,
    jmethodID putMethod,
    const char* key,
    double value) {
  jstring javaKey = toJavaString(env, key);
  jobject javaValue = boxedDouble(env, value);
  env->CallObjectMethod(map, putMethod, javaKey, javaValue);
  env->DeleteLocalRef(javaKey);
  env->DeleteLocalRef(javaValue);
}

void putMapBoolean(
    JNIEnv* env,
    jobject map,
    jmethodID putMethod,
    const char* key,
    bool value) {
  jstring javaKey = toJavaString(env, key);
  jobject javaValue = boxedBoolean(env, value);
  env->CallObjectMethod(map, putMethod, javaKey, javaValue);
  env->DeleteLocalRef(javaKey);
  env->DeleteLocalRef(javaValue);
}

void putMapObject(
    JNIEnv* env,
    jobject map,
    jmethodID putMethod,
    const char* key,
    jobject value) {
  jstring javaKey = toJavaString(env, key);
  env->CallObjectMethod(map, putMethod, javaKey, value);
  env->DeleteLocalRef(javaKey);
}

jobject newHashMap(JNIEnv* env) {
  jclass hashMapClass = env->FindClass("java/util/HashMap");
  jmethodID constructor = env->GetMethodID(hashMapClass, "<init>", "()V");
  return env->NewObject(hashMapClass, constructor);
}

jmethodID hashMapPutMethod(JNIEnv* env) {
  jclass hashMapClass = env->FindClass("java/util/HashMap");
  return env->GetMethodID(
      hashMapClass,
      "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
}

jobject newArrayList(JNIEnv* env) {
  jclass arrayListClass = env->FindClass("java/util/ArrayList");
  jmethodID constructor = env->GetMethodID(arrayListClass, "<init>", "()V");
  return env->NewObject(arrayListClass, constructor);
}

jmethodID arrayListAddMethod(JNIEnv* env) {
  jclass arrayListClass = env->FindClass("java/util/ArrayList");
  return env->GetMethodID(arrayListClass, "add", "(Ljava/lang/Object;)Z");
}

jobject toJavaStringList(
    JNIEnv* env,
    const std::vector<std::string>& values) {
  jobject list = newArrayList(env);
  jmethodID addMethod = arrayListAddMethod(env);
  for (const auto& value : values) {
    jstring javaValue = toJavaString(env, value);
    env->CallBooleanMethod(list, addMethod, javaValue);
    env->DeleteLocalRef(javaValue);
  }
  return list;
}

jobject toJavaDoubleList(JNIEnv* env, const std::vector<uint32_t>& values) {
  jobject list = newArrayList(env);
  jmethodID addMethod = arrayListAddMethod(env);
  for (const auto value : values) {
    jobject javaValue = boxedDouble(env, value);
    env->CallBooleanMethod(list, addMethod, javaValue);
    env->DeleteLocalRef(javaValue);
  }
  return list;
}

jobject toJavaMap(JNIEnv* env, const WalletSnapshot& snapshot) {
  jclass hashMapClass = env->FindClass("java/util/HashMap");
  jmethodID constructor = env->GetMethodID(hashMapClass, "<init>", "()V");
  jmethodID putMethod = env->GetMethodID(
      hashMapClass,
      "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");

  jobject map = env->NewObject(hashMapClass, constructor);

  putMapString(env, map, putMethod, "id", snapshot.id);
  putMapString(env, map, putMethod, "path", snapshot.path);
  putMapString(env, map, putMethod, "primaryAddress", snapshot.primaryAddress);
  putMapString(
      env,
      map,
      putMethod,
      "balanceAtomic",
      std::to_string(snapshot.balanceAtomic));
  putMapString(
      env,
      map,
      putMethod,
      "unlockedBalanceAtomic",
      std::to_string(snapshot.unlockedBalanceAtomic));
  putMapDouble(env, map, putMethod, "walletHeight", snapshot.walletHeight);
  putMapDouble(env, map, putMethod, "daemonHeight", snapshot.daemonHeight);
  putMapDouble(
      env,
      map,
      putMethod,
      "daemonTargetHeight",
      snapshot.daemonTargetHeight);
  putMapDouble(
      env,
      map,
      putMethod,
      "pendingOutputKeyImageCount",
      snapshot.pendingOutputKeyImageCount);
  putMapDouble(
      env,
      map,
      putMethod,
      "snapshotRevision",
      snapshot.snapshotRevision);
  putMapBoolean(env, map, putMethod, "synchronized", snapshot.synchronized);

  return map;
}

jobject toJavaMap(JNIEnv* env, const LedgerKeyImageSyncResult& result) {
  jclass hashMapClass = env->FindClass("java/util/HashMap");
  jmethodID constructor = env->GetMethodID(hashMapClass, "<init>", "()V");
  jmethodID putMethod = env->GetMethodID(
      hashMapClass,
      "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  jobject map = env->NewObject(hashMapClass, constructor);
  putMapDouble(env, map, putMethod, "importHeight", result.importHeight);
  putMapString(
      env,
      map,
      putMethod,
      "spentAtomic",
      std::to_string(result.spentAtomic));
  putMapString(
      env,
      map,
      putMethod,
      "unspentAtomic",
      std::to_string(result.unspentAtomic));
  putMapDouble(
      env,
      map,
      putMethod,
      "verifiedOutputCount",
      result.verifiedOutputCount);
  putMapDouble(
      env,
      map,
      putMethod,
      "pendingOutputCount",
      result.pendingOutputCount);
  putMapDouble(
      env,
      map,
      putMethod,
      "remainingPendingOutputCount",
      result.remainingPendingOutputCount);
  putMapDouble(
      env,
      map,
      putMethod,
      "importedOutputCount",
      result.importedOutputCount);
  putMapDouble(
      env,
      map,
      putMethod,
      "derivedOutputCount",
      result.derivedOutputCount);
  putMapDouble(
      env,
      map,
      putMethod,
      "spentStatusUnspentOutputCount",
      result.spentStatusUnspentOutputCount);
  putMapDouble(
      env,
      map,
      putMethod,
      "spentStatusBlockchainOutputCount",
      result.spentStatusBlockchainOutputCount);
  putMapDouble(
      env,
      map,
      putMethod,
      "spentStatusPoolOutputCount",
      result.spentStatusPoolOutputCount);
  putMapDouble(
      env,
      map,
      putMethod,
      "derivationDurationMs",
      result.derivationDurationMs);
  putMapDouble(
      env,
      map,
      putMethod,
      "spentStatusRpcDurationMs",
      result.spentStatusRpcDurationMs);
  putMapDouble(
      env,
      map,
      putMethod,
      "outgoingRpcDurationMs",
      result.outgoingRpcDurationMs);
  putMapDouble(
      env,
      map,
      putMethod,
      "stateUpdateDurationMs",
      result.stateUpdateDurationMs);
  putMapDouble(
      env,
      map,
      putMethod,
      "verificationDurationMs",
      result.verificationDurationMs);
  putMapDouble(
      env,
      map,
      putMethod,
      "storeDurationMs",
      result.storeDurationMs);
  putMapDouble(
      env,
      map,
      putMethod,
      "totalDurationMs",
      result.totalDurationMs);
  putMapDouble(
      env,
      map,
      putMethod,
      "snapshotRevision",
      result.snapshotRevision);
  return map;
}

jobject toJavaMap(JNIEnv* env, const NetworkSyncStatus& status) {
  jclass hashMapClass = env->FindClass("java/util/HashMap");
  jmethodID constructor = env->GetMethodID(hashMapClass, "<init>", "()V");
  jmethodID putMethod = env->GetMethodID(
      hashMapClass,
      "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  jobject map = env->NewObject(hashMapClass, constructor);
  putMapString(env, map, putMethod, "network", networkName(status.network));
  putMapString(env, map, putMethod, "state", status.state);
  putMapString(env, map, putMethod, "phase", status.phase);
  putMapString(env, map, putMethod, "lastError", status.lastError);
  putMapDouble(env, map, putMethod, "consecutiveFailures", status.consecutiveFailures);
  putMapDouble(env, map, putMethod, "phaseSequence", status.phaseSequence);
  putMapDouble(
      env,
      map,
      putMethod,
      "providerGeneration",
      status.providerGeneration);
  putMapDouble(env, map, putMethod, "phaseElapsedMs", status.phaseElapsedMs);
  putMapDouble(env, map, putMethod, "lastProviderSelectionMs", status.lastProviderSelectionMs);
  putMapDouble(env, map, putMethod, "lastTransportInitializationMs", status.lastTransportInitializationMs);
  putMapDouble(env, map, putMethod, "lastBlockFetchMs", status.lastBlockFetchMs);
  putMapDouble(env, map, putMethod, "lastPrefetchMs", status.lastPrefetchMs);
  putMapDouble(env, map, putMethod, "lastPrefetchWaitMs", status.lastPrefetchWaitMs);
  putMapDouble(env, map, putMethod, "prefetchedPayloadBytes", status.prefetchedPayloadBytes);
  putMapDouble(env, map, putMethod, "peakPrefetchedPayloadBytes", status.peakPrefetchedPayloadBytes);
  putMapDouble(env, map, putMethod, "lastNonEmptyBlockFetchMs", status.lastNonEmptyBlockFetchMs);
  putMapDouble(env, map, putMethod, "lastNonEmptyBlockCount", status.lastNonEmptyBlockCount);
  putMapDouble(env, map, putMethod, "lastNonEmptyNetworkBytes", status.lastNonEmptyNetworkBytes);
  putMapDouble(env, map, putMethod, "lastNonEmptyPayloadBytes", status.lastNonEmptyPayloadBytes);
  putMapDouble(env, map, putMethod, "networkBytesReceived", status.networkBytesReceived);
  putMapDouble(env, map, putMethod, "payloadBytesReceived", status.payloadBytesReceived);
  putMapDouble(env, map, putMethod, "grpcFramedBytesReceived", status.grpcFramedBytesReceived);
  putMapDouble(env, map, putMethod, "spoolBytesBuffered", status.spoolBytesBuffered);
  putMapDouble(env, map, putMethod, "spoolPeakBytes", status.spoolPeakBytes);
  putMapDouble(env, map, putMethod, "spoolWriteCount", status.spoolWriteCount);
  putMapDouble(env, map, putMethod, "spoolReadCount", status.spoolReadCount);
  putMapDouble(env, map, putMethod, "spoolBackpressureCount", status.spoolBackpressureCount);
  putMapBoolean(env, map, putMethod, "spoolEnabled", status.spoolEnabled);
  putMapDouble(env, map, putMethod, "lastWalletScanMs", status.lastWalletScanMs);
  putMapDouble(env, map, putMethod, "lastNonEmptyWalletDerivationCount", status.lastNonEmptyWalletDerivationCount);
  putMapDouble(env, map, putMethod, "lastNonEmptyWalletDerivationUs", status.lastNonEmptyWalletDerivationUs);
  putMapDouble(env, map, putMethod, "totalWalletDerivationCount", status.totalWalletDerivationCount);
  putMapDouble(env, map, putMethod, "totalWalletDerivationUs", status.totalWalletDerivationUs);
  putMapDouble(env, map, putMethod, "lastMempoolMs", status.lastMempoolMs);
  putMapDouble(env, map, putMethod, "lastCheckpointMs", status.lastCheckpointMs);
  putMapDouble(env, map, putMethod, "lastIterationMs", status.lastIterationMs);
  putMapDouble(env, map, putMethod, "downloadStartHeight", status.downloadStartHeight);
  putMapDouble(env, map, putMethod, "downloadedHeight", status.downloadedHeight);
  putMapDouble(env, map, putMethod, "chainHeight", status.chainHeight);
  putMapDouble(env, map, putMethod, "targetHeight", status.targetHeight);
  putMapDouble(env, map, putMethod, "transportStarts", status.transportStarts);
  putMapDouble(env, map, putMethod, "fetchedBatches", status.fetchedBatches);
  putMapDouble(env, map, putMethod, "fetchedBlocks", status.fetchedBlocks);
  putMapDouble(env, map, putMethod, "decodedBatches", status.decodedBatches);
  putMapDouble(env, map, putMethod, "prefetchedBatches", status.prefetchedBatches);
  putMapDouble(env, map, putMethod, "prefetchHits", status.prefetchHits);
  putMapDouble(env, map, putMethod, "fanoutDeliveries", status.fanoutDeliveries);
  putMapDouble(env, map, putMethod, "poolSnapshots", status.poolSnapshots);
  putMapDouble(env, map, putMethod, "cacheHits", status.cacheHits);
  putMapDouble(env, map, putMethod, "cacheMisses", status.cacheMisses);
  putMapDouble(env, map, putMethod, "replayCachePayloadBytes", status.replayCachePayloadBytes);
  putMapDouble(env, map, putMethod, "replayCachePeakPayloadBytes", status.replayCachePeakPayloadBytes);
  putMapDouble(env, map, putMethod, "replayCachePayloadLimitBytes", status.replayCachePayloadLimitBytes);
  putMapDouble(env, map, putMethod, "stalledWallets", status.stalledWallets);
  putMapDouble(env, map, putMethod, "scanWorkers", status.scanWorkers);
  putMapDouble(env, map, putMethod, "joinedWallets", status.joinedWallets);
  putMapDouble(env, map, putMethod, "queueDepth", status.queueDepth);
  putMapDouble(env, map, putMethod, "prefetchQueueDepth", status.prefetchQueueDepth);
  putMapDouble(env, map, putMethod, "prefetchQueueCapacity", status.prefetchQueueCapacity);
  putMapDouble(env, map, putMethod, "replayCacheEntries", status.replayCacheEntries);
  putMapDouble(env, map, putMethod, "replayCacheCapacity", status.replayCacheCapacity);
  return map;
}

jobject toJavaMap(JNIEnv* env, const WalletTransactionTransfer& transfer) {
  jobject map = newHashMap(env);
  jmethodID putMethod = hashMapPutMethod(env);

  putMapString(
      env,
      map,
      putMethod,
      "amountAtomic",
      std::to_string(transfer.amountAtomic));
  putMapString(env, map, putMethod, "address", transfer.address);

  return map;
}

jobject toJavaTransferList(
    JNIEnv* env,
    const std::vector<WalletTransactionTransfer>& transfers) {
  jobject list = newArrayList(env);
  jmethodID addMethod = arrayListAddMethod(env);
  for (const auto& transfer : transfers) {
    jobject map = toJavaMap(env, transfer);
    env->CallBooleanMethod(list, addMethod, map);
    env->DeleteLocalRef(map);
  }
  return list;
}

jobject toJavaMap(JNIEnv* env, const WalletTransaction& transaction) {
  jobject map = newHashMap(env);
  jmethodID putMethod = hashMapPutMethod(env);

  putMapString(env, map, putMethod, "hash", transaction.hash);
  putMapString(env, map, putMethod, "paymentId", transaction.paymentId);
  putMapString(env, map, putMethod, "description", transaction.description);
  putMapString(env, map, putMethod, "label", transaction.label);
  putMapString(env, map, putMethod, "direction", transaction.direction);
  putMapBoolean(env, map, putMethod, "pending", transaction.pending);
  putMapBoolean(env, map, putMethod, "failed", transaction.failed);
  putMapBoolean(env, map, putMethod, "coinbase", transaction.coinbase);
  putMapString(
      env,
      map,
      putMethod,
      "amountAtomic",
      std::to_string(transaction.amountAtomic));
  putMapString(
      env,
      map,
      putMethod,
      "feeAtomic",
      std::to_string(transaction.feeAtomic));
  putMapDouble(env, map, putMethod, "blockHeight", transaction.blockHeight);
  putMapDouble(env, map, putMethod, "confirmations", transaction.confirmations);
  putMapDouble(env, map, putMethod, "unlockTime", transaction.unlockTime);
  putMapDouble(env, map, putMethod, "timestamp", transaction.timestamp);
  putMapDouble(
      env,
      map,
      putMethod,
      "subaddrAccount",
      transaction.subaddrAccount);

  jobject subaddrIndices = toJavaDoubleList(env, transaction.subaddrIndices);
  putMapObject(env, map, putMethod, "subaddrIndices", subaddrIndices);
  env->DeleteLocalRef(subaddrIndices);

  jobject transfers = toJavaTransferList(env, transaction.transfers);
  putMapObject(env, map, putMethod, "transfers", transfers);
  env->DeleteLocalRef(transfers);

  return map;
}

jobject toJavaTransactionList(
    JNIEnv* env,
    const std::vector<WalletTransaction>& transactions) {
  jobject list = newArrayList(env);
  jmethodID addMethod = arrayListAddMethod(env);
  for (const auto& transaction : transactions) {
    jobject map = toJavaMap(env, transaction);
    env->CallBooleanMethod(list, addMethod, map);
    env->DeleteLocalRef(map);
  }
  return list;
}

jobject toJavaMap(JNIEnv* env, const PreparedTransaction& transaction) {
  jobject map = newHashMap(env);
  jmethodID putMethod = hashMapPutMethod(env);

  putMapString(env, map, putMethod, "id", transaction.id);
  putMapString(env, map, putMethod, "status", transaction.status);
  putMapString(env, map, putMethod, "error", transaction.error);
  putMapString(
      env,
      map,
      putMethod,
      "amountAtomic",
      std::to_string(transaction.amountAtomic));
  putMapString(
      env,
      map,
      putMethod,
      "dustAtomic",
      std::to_string(transaction.dustAtomic));
  putMapString(
      env,
      map,
      putMethod,
      "feeAtomic",
      std::to_string(transaction.feeAtomic));
  putMapDouble(env, map, putMethod, "txCount", transaction.txCount);

  jobject txIds = toJavaStringList(env, transaction.txIds);
  putMapObject(env, map, putMethod, "txIds", txIds);
  env->DeleteLocalRef(txIds);

  jobject subaddrAccounts = toJavaDoubleList(env, transaction.subaddrAccounts);
  putMapObject(env, map, putMethod, "subaddrAccounts", subaddrAccounts);
  env->DeleteLocalRef(subaddrAccounts);

  jobject subaddrIndices = toJavaDoubleList(env, transaction.subaddrIndices);
  putMapObject(env, map, putMethod, "subaddrIndices", subaddrIndices);
  env->DeleteLocalRef(subaddrIndices);

  return map;
}

jobject toJavaMap(JNIEnv* env, const HardwareWalletStatus& status) {
  jclass hashMapClass = env->FindClass("java/util/HashMap");
  jmethodID constructor = env->GetMethodID(hashMapClass, "<init>", "()V");
  jmethodID putMethod = env->GetMethodID(
      hashMapClass,
      "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");

  jobject map = env->NewObject(hashMapClass, constructor);

  putMapString(env, map, putMethod, "walletId", status.walletId);
  putMapString(env, map, putMethod, "deviceName", status.deviceName);
  putMapString(env, map, putMethod, "deviceType", status.deviceType);
  putMapBoolean(env, map, putMethod, "connected", status.connected);
  putMapBoolean(
      env,
      map,
      putMethod,
      "requiresUserAction",
      status.requiresUserAction);
  putMapString(env, map, putMethod, "promptKind", status.promptKind);
  putMapDouble(env, map, putMethod, "promptCode", status.promptCode);
  putMapDouble(env, map, putMethod, "progress", status.progress);
  putMapBoolean(env, map, putMethod, "indeterminate", status.indeterminate);

  return map;
}

jobject toJavaMap(JNIEnv* env, const FastReceiveIdentity& identity) {
  jclass hashMapClass = env->FindClass("java/util/HashMap");
  jmethodID constructor = env->GetMethodID(hashMapClass, "<init>", "()V");
  jmethodID putMethod = env->GetMethodID(
      hashMapClass,
      "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");

  jobject map = env->NewObject(hashMapClass, constructor);

  putMapString(env, map, putMethod, "id", identity.id);
  putMapString(env, map, putMethod, "label", identity.label);
  putMapString(env, map, putMethod, "path", identity.path);
  putMapString(env, map, putMethod, "address", identity.address);
  putMapString(env, map, putMethod, "network", networkName(identity.network));
  putMapDouble(env, map, putMethod, "restoreHeight", identity.restoreHeight);
  putMapDouble(
      env,
      map,
      putMethod,
      "derivationIndex",
      identity.derivationIndex);
  putMapString(env, map, putMethod, "scannerStatus", identity.scannerStatus);

  return map;
}

jobject toJavaMap(JNIEnv* env, const WalletSubaddress& subaddress) {
  jclass hashMapClass = env->FindClass("java/util/HashMap");
  jmethodID constructor = env->GetMethodID(hashMapClass, "<init>", "()V");
  jmethodID putMethod = env->GetMethodID(
      hashMapClass,
      "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");

  jobject map = env->NewObject(hashMapClass, constructor);
  putMapDouble(env, map, putMethod, "accountIndex", subaddress.accountIndex);
  putMapDouble(env, map, putMethod, "addressIndex", subaddress.addressIndex);
  putMapString(
      env,
      map,
      putMethod,
      "balanceAtomic",
      std::to_string(subaddress.balanceAtomic));
  putMapString(env, map, putMethod, "address", subaddress.address);
  putMapString(env, map, putMethod, "label", subaddress.label);
  return map;
}

jobject toJavaSubaddressList(
    JNIEnv* env,
    const std::vector<WalletSubaddress>& addresses) {
  jobject list = newArrayList(env);
  jmethodID addMethod = arrayListAddMethod(env);
  for (const auto& address : addresses) {
    jobject value = toJavaMap(env, address);
    env->CallBooleanMethod(list, addMethod, value);
    env->DeleteLocalRef(value);
  }
  return list;
}

jobject toJavaMap(
    JNIEnv* env,
    const FastReceiveRegistrationPayload& payload) {
  jobject map = toJavaMap(env, payload.identity);
  jmethodID putMethod = hashMapPutMethod(env);
  putMapString(
      env,
      map,
      putMethod,
      "privateViewKey",
      payload.privateViewKey);
  return map;
}

} // namespace

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  tex8_community_harrier_android_install_java_vm_v1(vm);
#else
  (void)vm;
#endif
  return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeLinkedWithMonero(
    JNIEnv*,
    jclass) {
  return WalletEngine::linkedWithMonero();
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeConfigurePublicBlockSpool(
    JNIEnv* env,
    jclass,
    jstring directory,
    jlong maxBytes) {
  try {
    const std::string spoolDirectory = toStdString(env, directory);
    if (spoolDirectory.empty() || maxBytes <= 0) {
      return JNI_FALSE;
    }
    const std::string limit = std::to_string(static_cast<uint64_t>(maxBytes));
    if (setenv("CUPRATE_GRPC_SPOOL_DIR", spoolDirectory.c_str(), 1) != 0 ||
        setenv("CUPRATE_GRPC_SPOOL_MAX_BYTES", limit.c_str(), 1) != 0) {
      return JNI_FALSE;
    }
    return JNI_TRUE;
  } catch (const std::exception&) {
    return JNI_FALSE;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeDrainEngineDiagnostics(
    JNIEnv* env,
    jclass) {
  try {
    return toJavaStringList(env, WalletEngine::drainDiagnosticLines());
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeDerivationBackendStatus(
    JNIEnv* env,
    jclass) {
  try {
    return toJavaString(env, WalletEngine::derivationBackendStatus());
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeBenchmarkDerivationPerformance(
    JNIEnv* env,
    jclass) {
  try {
    return toJavaString(env, WalletEngine::benchmarkDerivationPerformance());
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixLinked(
    JNIEnv*,
    jclass) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  return tex8_community_matrix_link_anchor_v1() != 0 ? JNI_TRUE : JNI_FALSE;
#else
  return JNI_FALSE;
#endif
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeLinked(
    JNIEnv*,
    jclass) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  return tex8_community_runtime_link_anchor_v1() != 0 ? JNI_TRUE : JNI_FALSE;
#else
  return JNI_FALSE;
#endif
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixCreate(
    JNIEnv* env,
    jclass,
    jstring homeserverValue,
    jstring storePathValue,
    jbyteArray storePassphraseValue,
    jstring proxyValue,
    jboolean allowLoopbackHttpForTests) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  try {
    auto homeserver = toStdString(env, homeserverValue);
    auto storePath = toStdString(env, storePathValue);
    auto proxy = toStdString(env, proxyValue);
    auto storePassphrase =
        toByteVector(env, storePassphraseValue, 32, 256);
    std::lock_guard<std::mutex> lock(communityMatrixMutex);
    if (communityMatrixHandle != nullptr) {
      tex8_community_matrix_destroy_v1(communityMatrixHandle);
      communityMatrixHandle = nullptr;
    }
    std::array<uint8_t, 4096> error{};
    size_t errorLength = error.size();
    const auto status = tex8_community_matrix_create_v1(
        reinterpret_cast<const uint8_t*>(homeserver.data()),
        homeserver.size(),
        reinterpret_cast<const uint8_t*>(storePath.data()),
        storePath.size(),
        storePassphrase.data(),
        storePassphrase.size(),
        reinterpret_cast<const uint8_t*>(proxy.data()),
        proxy.size(),
        allowLoopbackHttpForTests == JNI_TRUE,
        &communityMatrixHandle,
        error.data(),
        &errorLength);
    std::fill(storePassphrase.begin(), storePassphrase.end(), 0);
    if (status != TEX8_COMMUNITY_MATRIX_OK ||
        communityMatrixHandle == nullptr) {
      const std::string message(
          reinterpret_cast<const char*>(error.data()),
          strnlen(reinterpret_cast<const char*>(error.data()), error.size()));
      throw WalletEngineError(
          message.empty() ? "The private chat could not be initialized" : message);
    }
    return JNI_TRUE;
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return JNI_FALSE;
  }
#else
  (void)env;
  (void)homeserverValue;
  (void)storePathValue;
  (void)storePassphraseValue;
  (void)proxyValue;
  (void)allowLoopbackHttpForTests;
  return JNI_FALSE;
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixDestroy(
    JNIEnv*,
    jclass) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  std::lock_guard<std::mutex> lock(communityMatrixMutex);
  if (communityMatrixHandle != nullptr) {
    tex8_community_matrix_destroy_v1(communityMatrixHandle);
    communityMatrixHandle = nullptr;
  }
#endif
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixLogin(
    JNIEnv* env,
    jclass,
    jstring userIdValue,
    jbyteArray passwordValue,
    jstring deviceNameValue) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  try {
    auto userId = toStdString(env, userIdValue);
    auto password = toByteVector(env, passwordValue, 32, 256);
    auto deviceName = toStdString(env, deviceNameValue);
    std::lock_guard<std::mutex> lock(communityMatrixMutex);
    if (communityMatrixHandle == nullptr) {
      throw WalletEngineError("The private chat session is unavailable");
    }
    uint8_t* output = nullptr;
    size_t outputLength = 0;
    const auto status = tex8_community_matrix_login_v1(
        communityMatrixHandle,
        reinterpret_cast<const uint8_t*>(userId.data()),
        userId.size(),
        password.data(),
        password.size(),
        reinterpret_cast<const uint8_t*>(deviceName.data()),
        deviceName.size(),
        &output,
        &outputLength);
    std::fill(password.begin(), password.end(), 0);
    requireCommunityMatrixStatus(status);
    auto result = takeCommunityMatrixOutput(output, outputLength);
    auto javaResult = toJavaString(env, result);
    std::fill(result.begin(), result.end(), '\0');
    return javaResult;
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
#else
  (void)env;
  (void)userIdValue;
  (void)passwordValue;
  (void)deviceNameValue;
  return nullptr;
#endif
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixRestore(
    JNIEnv* env,
    jclass,
    jbyteArray sessionValue) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  try {
    auto session = toByteVector(env, sessionValue, 2, 64 * 1024);
    std::lock_guard<std::mutex> lock(communityMatrixMutex);
    if (communityMatrixHandle == nullptr) {
      throw WalletEngineError("The private chat session is unavailable");
    }
    const auto status = tex8_community_matrix_restore_v1(
        communityMatrixHandle, session.data(), session.size());
    std::fill(session.begin(), session.end(), 0);
    requireCommunityMatrixStatus(status);
    return JNI_TRUE;
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return JNI_FALSE;
  }
#else
  (void)env;
  (void)sessionValue;
  return JNI_FALSE;
#endif
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixExportSession(
    JNIEnv* env,
    jclass) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  try {
    std::lock_guard<std::mutex> lock(communityMatrixMutex);
    if (communityMatrixHandle == nullptr) {
      throw WalletEngineError("The private chat session is unavailable");
    }
    uint8_t* output = nullptr;
    size_t outputLength = 0;
    requireCommunityMatrixStatus(tex8_community_matrix_export_session_v1(
        communityMatrixHandle, &output, &outputLength));
    auto result = takeCommunityMatrixOutput(output, outputLength);
    auto javaResult = toJavaString(env, result);
    std::fill(result.begin(), result.end(), '\0');
    return javaResult;
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
#else
  (void)env;
  return nullptr;
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixSync(
    JNIEnv* env,
    jclass,
    jdouble timeoutMsValue) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  try {
    const auto timeoutMs = toExactUInt64(timeoutMsValue, "timeoutMs");
    std::lock_guard<std::mutex> lock(communityMatrixMutex);
    if (communityMatrixHandle == nullptr) {
      throw WalletEngineError("The private chat session is unavailable");
    }
    requireCommunityMatrixStatus(
        tex8_community_matrix_sync_once_v1(communityMatrixHandle, timeoutMs));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
#else
  (void)env;
  (void)timeoutMsValue;
#endif
}

#if TEX8_COMMUNITY_MATRIX_LINKED
template <typename Operation>
jstring communityMatrixStringOperation(
    JNIEnv* env,
    Operation operation) {
  try {
    std::lock_guard<std::mutex> lock(communityMatrixMutex);
    if (communityMatrixHandle == nullptr) {
      throw WalletEngineError("The private chat session is unavailable");
    }
    uint8_t* output = nullptr;
    size_t outputLength = 0;
    requireCommunityMatrixStatus(operation(
        communityMatrixHandle, &output, &outputLength));
    auto result = takeCommunityMatrixOutput(output, outputLength);
    auto javaResult = toJavaString(env, result);
    std::fill(result.begin(), result.end(), '\0');
    return javaResult;
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}
#endif

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixOpenDirect(
    JNIEnv* env,
    jclass,
    jstring peerValue) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  auto peer = toStdString(env, peerValue);
  return communityMatrixStringOperation(
      env,
      [&peer](auto* handle, auto** output, auto* outputLength) {
        return tex8_community_matrix_create_direct_room_v1(
            handle,
            reinterpret_cast<const uint8_t*>(peer.data()),
            peer.size(),
            output,
            outputLength);
      });
#else
  (void)env;
  (void)peerValue;
  return nullptr;
#endif
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixSendText(
    JNIEnv* env,
    jclass,
    jstring roomValue,
    jstring bodyValue) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  auto room = toStdString(env, roomValue);
  auto body = toStdString(env, bodyValue);
  return communityMatrixStringOperation(
      env,
      [&room, &body](auto* handle, auto** output, auto* outputLength) {
        return tex8_community_matrix_send_text_v1(
            handle,
            reinterpret_cast<const uint8_t*>(room.data()),
            room.size(),
            reinterpret_cast<const uint8_t*>(body.data()),
            body.size(),
            output,
            outputLength);
      });
#else
  (void)env;
  (void)roomValue;
  (void)bodyValue;
  return nullptr;
#endif
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixMessages(
    JNIEnv* env,
    jclass,
    jstring roomValue,
    jstring fromValue,
    jdouble limitValue) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  auto room = toStdString(env, roomValue);
  auto from = toStdString(env, fromValue);
  const auto limit = static_cast<size_t>(toExactUInt64(limitValue, "limit"));
  return communityMatrixStringOperation(
      env,
      [&room, &from, limit](auto* handle, auto** output, auto* outputLength) {
        return tex8_community_matrix_messages_v1(
            handle,
            reinterpret_cast<const uint8_t*>(room.data()),
            room.size(),
            from.empty() ? nullptr : reinterpret_cast<const uint8_t*>(from.data()),
            from.size(),
            limit,
            output,
            outputLength);
      });
#else
  (void)env;
  (void)roomValue;
  (void)fromValue;
  (void)limitValue;
  return nullptr;
#endif
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixReportPreview(
    JNIEnv* env,
    jclass,
    jstring roomValue,
    jstring eventValue) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  auto room = toStdString(env, roomValue);
  auto event = toStdString(env, eventValue);
  return communityMatrixStringOperation(
      env,
      [&room, &event](auto* handle, auto** output, auto* outputLength) {
        return tex8_community_matrix_selected_report_v1(
            handle,
            reinterpret_cast<const uint8_t*>(room.data()),
            room.size(),
            reinterpret_cast<const uint8_t*>(event.data()),
            event.size(),
            output,
            outputLength);
      });
#else
  (void)env;
  (void)roomValue;
  (void)eventValue;
  return nullptr;
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixSetBlocked(
    JNIEnv* env,
    jclass,
    jstring peerValue,
    jboolean blockedValue) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  try {
    auto peer = toStdString(env, peerValue);
    std::lock_guard<std::mutex> lock(communityMatrixMutex);
    if (communityMatrixHandle == nullptr) {
      throw WalletEngineError("The private chat session is unavailable");
    }
    requireCommunityMatrixStatus(tex8_community_matrix_set_blocked_v1(
        communityMatrixHandle,
        reinterpret_cast<const uint8_t*>(peer.data()),
        peer.size(),
        blockedValue == JNI_TRUE));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
#else
  (void)env;
  (void)peerValue;
  (void)blockedValue;
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityMatrixLogout(
    JNIEnv* env,
    jclass) {
#if TEX8_COMMUNITY_MATRIX_LINKED
  try {
    std::lock_guard<std::mutex> lock(communityMatrixMutex);
    if (communityMatrixHandle != nullptr) {
      requireCommunityMatrixStatus(
          tex8_community_matrix_logout_v1(communityMatrixHandle));
    }
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
#else
  (void)env;
#endif
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeCreate(
    JNIEnv* env,
    jclass,
    jstring storageRootValue,
    jstring scopeValue,
    jbyteArray catalogKeyValue,
    jbyteArray advertisingKeyValue,
    jbyteArray artifactKeyValue,
    jbyteArray queryCacheKeyValue,
    jstring artifactManifestValue,
    jstring ptePathValue,
    jstring tokenizerPathValue,
    jstring conformancePathValue) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  try {
    auto storageRoot = toStdString(env, storageRootValue);
    auto scope = toStdString(env, scopeValue);
    auto catalogKey = toByteVector(env, catalogKeyValue, 32, 32);
    auto advertisingKey = toByteVector(env, advertisingKeyValue, 32, 32);
    auto artifactKey = toByteVector(env, artifactKeyValue, 32, 32);
    auto queryCacheKey = toByteVector(env, queryCacheKeyValue, 32, 32);
    auto artifactManifest = toStdString(env, artifactManifestValue);
    auto ptePath = toStdString(env, ptePathValue);
    auto tokenizerPath = toStdString(env, tokenizerPathValue);
    auto conformancePath = toStdString(env, conformancePathValue);
    std::lock_guard<std::mutex> lock(communityRuntimeMutex);
    if (communityRuntimeHandle != nullptr) {
      tex8_community_runtime_destroy_v1(communityRuntimeHandle);
      communityRuntimeHandle = nullptr;
    }
    std::array<uint8_t, 4096> error{};
    size_t errorLength = error.size();
    const auto status = tex8_community_runtime_create_v1(
        reinterpret_cast<const uint8_t*>(storageRoot.data()),
        storageRoot.size(),
        reinterpret_cast<const uint8_t*>(scope.data()),
        scope.size(),
        catalogKey.data(),
        catalogKey.size(),
        advertisingKey.data(),
        advertisingKey.size(),
        artifactKey.data(),
        artifactKey.size(),
        queryCacheKey.data(),
        queryCacheKey.size(),
        reinterpret_cast<const uint8_t*>(artifactManifest.data()),
        artifactManifest.size(),
        reinterpret_cast<const uint8_t*>(ptePath.data()),
        ptePath.size(),
        reinterpret_cast<const uint8_t*>(tokenizerPath.data()),
        tokenizerPath.size(),
        reinterpret_cast<const uint8_t*>(conformancePath.data()),
        conformancePath.size(),
        &communityRuntimeHandle,
        error.data(),
        &errorLength);
    std::fill(catalogKey.begin(), catalogKey.end(), 0);
    std::fill(advertisingKey.begin(), advertisingKey.end(), 0);
    std::fill(artifactKey.begin(), artifactKey.end(), 0);
    std::fill(queryCacheKey.begin(), queryCacheKey.end(), 0);
    if (status != TEX8_COMMUNITY_RUNTIME_OK ||
        communityRuntimeHandle == nullptr) {
      const std::string message(
          reinterpret_cast<const char*>(error.data()),
          strnlen(reinterpret_cast<const char*>(error.data()), error.size()));
      throw WalletEngineError(
          message.empty() ? "The local Community runtime could not be initialized" : message);
    }
    return JNI_TRUE;
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return JNI_FALSE;
  }
#else
  (void)env;
  (void)storageRootValue;
  (void)scopeValue;
  (void)catalogKeyValue;
  (void)advertisingKeyValue;
  (void)artifactKeyValue;
  (void)queryCacheKeyValue;
  (void)artifactManifestValue;
  (void)ptePathValue;
  (void)tokenizerPathValue;
  (void)conformancePathValue;
  return JNI_FALSE;
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeClearQueryCache(
    JNIEnv* env,
    jclass) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  try {
    std::lock_guard<std::mutex> lock(communityRuntimeMutex);
    if (communityRuntimeHandle == nullptr) {
      throw WalletEngineError("The local Community catalog is unavailable");
    }
    requireCommunityRuntimeStatus(
        tex8_community_runtime_clear_query_cache_v1(communityRuntimeHandle));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
#else
  (void)env;
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeDestroy(
    JNIEnv*,
    jclass) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  std::lock_guard<std::mutex> lock(communityRuntimeMutex);
  if (communityRuntimeHandle != nullptr) {
    tex8_community_runtime_destroy_v1(communityRuntimeHandle);
    communityRuntimeHandle = nullptr;
  }
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeInstallCatalog(
    JNIEnv* env,
    jclass,
    jbyteArray manifestValue,
    jbyteArray payloadValue,
    jdouble nowMsValue) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  try {
    auto manifest = toByteVector(env, manifestValue, 2, 1024 * 1024);
    auto payload = toByteVector(env, payloadValue, 2, 64 * 1024 * 1024);
    const auto nowMs = toExactUInt64(nowMsValue, "nowMs");
    std::lock_guard<std::mutex> lock(communityRuntimeMutex);
    if (communityRuntimeHandle == nullptr) {
      throw WalletEngineError("The local Community catalog is unavailable");
    }
    requireCommunityRuntimeStatus(tex8_community_runtime_install_catalog_v1(
        communityRuntimeHandle,
        manifest.data(),
        manifest.size(),
        payload.data(),
        payload.size(),
        nowMs));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
#else
  (void)env;
  (void)manifestValue;
  (void)payloadValue;
  (void)nowMsValue;
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeInstallQueryCatalog(
    JNIEnv* env,
    jclass,
    jbyteArray manifestValue,
    jbyteArray payloadValue,
    jdouble nowMsValue) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  try {
    auto manifest = toByteVector(env, manifestValue, 2, 1024 * 1024);
    auto payload = toByteVector(env, payloadValue, 2, 64 * 1024 * 1024);
    const auto nowMs = toExactUInt64(nowMsValue, "nowMs");
    std::lock_guard<std::mutex> lock(communityRuntimeMutex);
    if (communityRuntimeHandle == nullptr) {
      throw WalletEngineError("The local Community catalog is unavailable");
    }
    requireCommunityRuntimeStatus(
        tex8_community_runtime_install_query_catalog_v1(
            communityRuntimeHandle,
            manifest.data(),
            manifest.size(),
            payload.data(),
            payload.size(),
            nowMs));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
#else
  (void)env;
  (void)manifestValue;
  (void)payloadValue;
  (void)nowMsValue;
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeInstallAdvertisingCatalog(
    JNIEnv* env,
    jclass,
    jbyteArray responseValue,
    jstring countryValue,
    jstring placementValue,
    jdouble nowMsValue) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  try {
    auto response = toByteVector(env, responseValue, 2, 8 * 1024 * 1024);
    auto country = toStdString(env, countryValue);
    auto placement = toStdString(env, placementValue);
    const auto nowMs = toExactUInt64(nowMsValue, "nowMs");
    std::lock_guard<std::mutex> lock(communityRuntimeMutex);
    if (communityRuntimeHandle == nullptr) {
      throw WalletEngineError("The local Community catalog is unavailable");
    }
    requireCommunityRuntimeStatus(
        tex8_community_runtime_install_advertising_catalog_v1(
            communityRuntimeHandle,
            response.data(),
            response.size(),
            reinterpret_cast<const uint8_t*>(country.data()),
            country.size(),
            reinterpret_cast<const uint8_t*>(placement.data()),
            placement.size(),
            nowMs));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
#else
  (void)env;
  (void)responseValue;
  (void)countryValue;
  (void)placementValue;
  (void)nowMsValue;
#endif
}

#if TEX8_COMMUNITY_RUNTIME_LINKED
template <typename Operation>
jstring communityRuntimeStringOperation(
    JNIEnv* env,
    Operation operation) {
  try {
    std::lock_guard<std::mutex> lock(communityRuntimeMutex);
    if (communityRuntimeHandle == nullptr) {
      throw WalletEngineError("The local Community catalog is unavailable");
    }
    uint8_t* output = nullptr;
    size_t outputLength = 0;
    requireCommunityRuntimeStatus(operation(
        communityRuntimeHandle, &output, &outputLength));
    return toJavaString(
        env, takeCommunityRuntimeOutput(output, outputLength));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}
#endif

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeStatus(
    JNIEnv* env,
    jclass,
    jdouble nowMsValue) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  const auto nowMs = toExactUInt64(nowMsValue, "nowMs");
  return communityRuntimeStringOperation(
      env,
      [nowMs](auto* handle, auto** output, auto* outputLength) {
        return tex8_community_runtime_status_v1(
            handle, nowMs, output, outputLength);
      });
#else
  (void)env;
  (void)nowMsValue;
  return nullptr;
#endif
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeSuggestions(
    JNIEnv* env,
    jclass,
    jstring requestValue,
    jdouble nowMsValue) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  auto request = toStdString(env, requestValue);
  const auto nowMs = toExactUInt64(nowMsValue, "nowMs");
  return communityRuntimeStringOperation(
      env,
      [&request, nowMs](auto* handle, auto** output, auto* outputLength) {
        return tex8_community_runtime_suggestions_v1(
            handle,
            reinterpret_cast<const uint8_t*>(request.data()),
            request.size(),
            nowMs,
            output,
            outputLength);
      });
#else
  (void)env;
  (void)requestValue;
  (void)nowMsValue;
  return nullptr;
#endif
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeSearch(
    JNIEnv* env,
    jclass,
    jstring requestValue,
    jdouble nowMsValue) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  try {
    auto request = toStdString(env, requestValue);
    const auto nowMs = toExactUInt64(nowMsValue, "nowMs");
    return communityRuntimeStringOperation(
        env,
        [&request, nowMs](auto* handle, auto** output, auto* outputLength) {
          return tex8_community_runtime_search_v1(
              handle,
              reinterpret_cast<const uint8_t*>(request.data()),
              request.size(),
              nowMs,
              output,
              outputLength);
        });
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
#else
  (void)env;
  (void)requestValue;
  (void)nowMsValue;
  return nullptr;
#endif
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeAdvertisements(
    JNIEnv* env,
    jclass,
    jstring requestValue,
    jdouble nowMsValue) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  try {
    auto request = toStdString(env, requestValue);
    const auto nowMs = toExactUInt64(nowMsValue, "nowMs");
    return communityRuntimeStringOperation(
        env,
        [&request, nowMs](auto* handle, auto** output, auto* outputLength) {
          return tex8_community_runtime_advertisements_v1(
              handle,
              reinterpret_cast<const uint8_t*>(request.data()),
              request.size(),
              nowMs,
              output,
              outputLength);
        });
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
#else
  (void)env;
  (void)requestValue;
  (void)nowMsValue;
  return nullptr;
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommunityRuntimeRecordAdvertisementView(
    JNIEnv* env,
    jclass,
    jstring requestValue,
    jdouble nowMsValue) {
#if TEX8_COMMUNITY_RUNTIME_LINKED
  try {
    auto request = toStdString(env, requestValue);
    const auto nowMs = toExactUInt64(nowMsValue, "nowMs");
    std::lock_guard<std::mutex> lock(communityRuntimeMutex);
    if (communityRuntimeHandle == nullptr) {
      throw WalletEngineError("The local Community catalog is unavailable");
    }
    requireCommunityRuntimeStatus(
        tex8_community_runtime_record_advertising_view_v1(
            communityRuntimeHandle,
            reinterpret_cast<const uint8_t*>(request.data()),
            request.size(),
            nowMs));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
#else
  (void)env;
  (void)requestValue;
  (void)nowMsValue;
#endif
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeInstallLedgerBleTransport(
    JNIEnv* env,
    jclass bridgeClass) {
  std::lock_guard<std::mutex> lock(ledgerBridgeMutex);
  if (env->GetJavaVM(&ledgerJavaVm) != JNI_OK) {
    return JNI_FALSE;
  }
  if (ledgerBridgeClass != nullptr) {
    env->DeleteGlobalRef(ledgerBridgeClass);
  }
  ledgerBridgeClass = static_cast<jclass>(env->NewGlobalRef(bridgeClass));
  if (ledgerBridgeClass == nullptr) {
    return JNI_FALSE;
  }

  ledgerConnectMethod = env->GetStaticMethodID(
      ledgerBridgeClass, "ledgerBleConnect", "()Z");
  ledgerDisconnectMethod = env->GetStaticMethodID(
      ledgerBridgeClass, "ledgerBleDisconnect", "()V");
  ledgerConnectedMethod = env->GetStaticMethodID(
      ledgerBridgeClass, "ledgerBleConnected", "()Z");
  ledgerExchangeMethod = env->GetStaticMethodID(
      ledgerBridgeClass, "ledgerBleExchange", "([BZ)[B");
  if (env->ExceptionCheck() || ledgerConnectMethod == nullptr ||
      ledgerDisconnectMethod == nullptr || ledgerConnectedMethod == nullptr ||
      ledgerExchangeMethod == nullptr) {
    clearLedgerJavaException(env);
    return JNI_FALSE;
  }

  LedgerBleTransportCallbacks callbacks;
  callbacks.connect = androidLedgerConnect;
  callbacks.disconnect = androidLedgerDisconnect;
  callbacks.connected = androidLedgerConnected;
  callbacks.exchange = androidLedgerExchange;
  WalletEngine::setLedgerBleTransportCallbacks(callbacks);
  return WalletEngine::ledgerBleTransportAvailable() ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCreateWallet(
    JNIEnv* env,
    jclass,
    jstring path,
    jstring password,
    jstring language,
    jstring network) {
  try {
    CreateWalletRequest request;
    request.path = toStdString(env, path);
    request.password = toStdString(env, password);
    request.language = toStdString(env, language);
    request.network = parseNetwork(toStdString(env, network));
    return toJavaString(env, walletEngine().createWallet(request));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeRestoreWallet(
    JNIEnv* env,
    jclass,
    jstring path,
    jstring password,
    jstring mnemonic,
    jstring seedOffset,
    jstring network,
    jdouble restoreHeight) {
  try {
    RestoreWalletRequest request;
    request.path = toStdString(env, path);
    request.password = toStdString(env, password);
    request.mnemonic = toStdString(env, mnemonic);
    request.seedOffset = toStdString(env, seedOffset);
    request.network = parseNetwork(toStdString(env, network));
    request.restoreHeight = toUInt64(restoreHeight, "restoreHeight");
    return toJavaString(env, walletEngine().restoreWallet(request));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeOpenWallet(
    JNIEnv* env,
    jclass,
    jstring path,
    jstring password,
    jstring network,
    jdouble restoreHeight) {
  try {
    OpenWalletRequest request;
    request.path = toStdString(env, path);
    request.password = toStdString(env, password);
    request.network = parseNetwork(toStdString(env, network));
    request.restoreHeight = toUInt64(restoreHeight, "restoreHeight");
    return toJavaString(env, walletEngine().openWallet(request));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCreateWalletFromDevice(
    JNIEnv* env,
    jclass,
    jstring path,
    jstring password,
    jstring network,
    jstring deviceName,
    jdouble restoreHeight,
    jstring subaddressLookahead,
    jdouble accountIndex) {
  try {
    CreateWalletFromDeviceRequest request;
    request.path = toStdString(env, path);
    request.password = toStdString(env, password);
    request.network = parseNetwork(toStdString(env, network));
    request.deviceName = toStdString(env, deviceName);
    if (request.deviceName.empty()) {
      request.deviceName = "Ledger";
    }
    request.restoreHeight = toUInt64(restoreHeight, "restoreHeight");
    request.subaddressLookahead = toStdString(env, subaddressLookahead);
    request.accountIndex = toUInt32(accountIndex, "accountIndex");
    return toJavaString(env, walletEngine().createWalletFromDevice(request));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCreateViewOnlyWalletFromHardware(
    JNIEnv* env,
    jclass,
    jstring sourceWalletId,
    jstring path,
    jstring password,
    jstring network,
    jdouble restoreHeight) {
  tex8::wallet::HardwareViewKeyExport exported;
  CreateViewOnlyWalletRequest request;
  try {
    const NetworkType requestedNetwork = parseNetwork(toStdString(env, network));
    exported = walletEngine().exportHardwarePrivateViewKey(
        toStdString(env, sourceWalletId));
    if (exported.network != requestedNetwork) {
      throw WalletEngineError(
          "hardware wallet network does not match the requested view-only wallet network");
    }

    request.path = toStdString(env, path);
    request.password = toStdString(env, password);
    request.address = exported.address;
    request.privateViewKey = exported.privateViewKey;
    request.network = requestedNetwork;
    request.restoreHeight = toUInt64(restoreHeight, "restoreHeight");
    const std::string walletId = walletEngine().createViewOnlyWallet(request);

    std::fill(request.password.begin(), request.password.end(), '\0');
    std::fill(request.privateViewKey.begin(), request.privateViewKey.end(), '\0');
    std::fill(exported.privateViewKey.begin(), exported.privateViewKey.end(), '\0');
    return toJavaString(env, walletId);
  } catch (const std::exception& error) {
    std::fill(request.password.begin(), request.password.end(), '\0');
    std::fill(request.privateViewKey.begin(), request.privateViewKey.end(), '\0');
    std::fill(exported.privateViewKey.begin(), exported.privateViewKey.end(), '\0');
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCreateFastReceiveIdentity(
    JNIEnv* env,
    jclass,
    jstring sourceWalletId,
    jstring identityId,
    jstring path,
    jstring password,
    jstring label,
    jdouble restoreHeight,
    jdouble derivationIndex) {
  try {
    CreateFastReceiveIdentityRequest request;
    request.sourceWalletId = toStdString(env, sourceWalletId);
    request.identityId = toStdString(env, identityId);
    request.path = toStdString(env, path);
    request.password = toStdString(env, password);
    request.label = toStdString(env, label);
    request.restoreHeight = toUInt64(restoreHeight, "restoreHeight");
    request.derivationIndex = toUInt64(derivationIndex, "derivationIndex");
    return toJavaMap(env, walletEngine().createFastReceiveIdentity(request));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeFastReceiveRegistrationPayload(
    JNIEnv* env,
    jclass,
    jstring identityId,
    jstring path,
    jstring password,
    jstring network,
    jdouble restoreHeight) {
  try {
    return toJavaMap(
        env,
        walletEngine().fastReceiveRegistrationPayload(
            toStdString(env, identityId),
            toStdString(env, path),
            toStdString(env, password),
            parseNetwork(toStdString(env, network)),
            toUInt64(restoreHeight, "restoreHeight")));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSealFastReceiveWatch(
    JNIEnv* env,
    jclass,
    jstring identityId,
    jstring path,
    jstring password,
    jstring network,
    jdouble restoreHeight,
    jstring workerDescriptorHex,
    jstring assignmentHandleHex,
    jdouble assignmentEpoch,
    jdouble issuedAt,
    jdouble expiresAt,
    jdouble now) {
  std::string passwordValue = toStdString(env, password);
  try {
    const auto result = tex8::wallet::fast_wallet_protocol_bridge::sealWatch(
        walletEngine(),
        toStdString(env, identityId),
        toStdString(env, path),
        passwordValue,
        parseNetwork(toStdString(env, network)),
        toUInt64(restoreHeight, "restoreHeight"),
        toStdString(env, workerDescriptorHex),
        toStdString(env, assignmentHandleHex),
        toUInt64(assignmentEpoch, "assignmentEpoch"),
        toUInt64(issuedAt, "issuedAt"),
        toUInt64(expiresAt, "expiresAt"),
        toUInt64(now, "now"));
    tex8::wallet::secureClear(passwordValue);
    return toJavaString(env, result);
  } catch (const std::exception& error) {
    tex8::wallet::secureClear(passwordValue);
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSealLedgerFastWalletWatch(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jstring identityId,
    jdouble accountIndex,
    jstring network,
    jdouble restoreHeight,
    jstring workerDescriptorHex,
    jstring assignmentHandleHex,
    jdouble assignmentEpoch,
    jdouble issuedAt,
    jdouble expiresAt,
    jdouble now) {
  try {
    return toJavaString(
        env,
        tex8::wallet::fast_wallet_protocol_bridge::sealAccountWatch(
            walletEngine(),
            toStdString(env, walletId),
            toStdString(env, identityId),
            toUInt32(accountIndex, "accountIndex"),
            toUInt64(restoreHeight, "restoreHeight"),
            parseNetwork(toStdString(env, network)),
            toStdString(env, workerDescriptorHex),
            toStdString(env, assignmentHandleHex),
            toUInt64(assignmentEpoch, "assignmentEpoch"),
            toUInt64(issuedAt, "issuedAt"),
            toUInt64(expiresAt, "expiresAt"),
            toUInt64(now, "now")));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeVerifiedFastWalletRelayOrigin(
    JNIEnv* env,
    jclass,
    jstring workerDescriptorHex,
    jstring network,
    jdouble now) {
  try {
    return toJavaString(
        env,
        tex8::wallet::fast_wallet_protocol_bridge::verifiedRelayOrigin(
            toStdString(env, workerDescriptorHex),
            parseNetwork(toStdString(env, network)),
            toUInt64(now, "now")));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeVerifiedFastWalletWorkerRootId(
    JNIEnv* env,
    jclass,
    jstring workerDescriptorHex,
    jstring network,
    jdouble now) {
  try {
    return toJavaString(
        env,
        tex8::wallet::fast_wallet_protocol_bridge::verifiedWorkerRootId(
            toStdString(env, workerDescriptorHex),
            parseNetwork(toStdString(env, network)),
            toUInt64(now, "now")));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jdouble JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeVerifiedFastWalletWorkerAdmission(
    JNIEnv* env,
    jclass,
    jstring workerDescriptorHex,
    jstring admissionCertificateHex,
    jstring directoryPublicKeyHex,
    jstring network,
    jdouble now) {
  try {
    return static_cast<jdouble>(
        tex8::wallet::fast_wallet_protocol_bridge::verifiedWorkerAdmission(
            toStdString(env, workerDescriptorHex),
            toStdString(env, admissionCertificateHex),
            toStdString(env, directoryPublicKeyHex),
            parseNetwork(toStdString(env, network)),
            toUInt64(now, "now")));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return 0;
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCloseWallet(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jboolean store) {
  try {
    walletEngine().closeWallet(toStdString(env, walletId), store == JNI_TRUE);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSetDaemon(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jstring address,
    jboolean trusted,
    jboolean useSsl,
    jstring username,
    jstring password,
    jstring proxyAddress) {
  try {
    DaemonConfig config;
    config.address = toStdString(env, address);
    config.trusted = trusted == JNI_TRUE;
    config.useSsl = useSsl == JNI_TRUE;
    config.username = toStdString(env, username);
    config.password = toStdString(env, password);
    config.proxyAddress = toStdString(env, proxyAddress);
    walletEngine().setDaemon(toStdString(env, walletId), config);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSetGrpcEndpoint(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jstring endpoint) {
  try {
    walletEngine().setGrpcEndpoint(
        toStdString(env, walletId),
        toStdString(env, endpoint));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeNetworkSyncStatus(
    JNIEnv* env,
    jclass,
    jstring network) {
  try {
    return toJavaMap(
        env,
        walletEngine().networkSyncStatus(
            parseNetwork(toStdString(env, network))));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativePrioritizeNetworkWallet(
    JNIEnv* env,
    jclass,
    jstring walletId) {
  try {
    walletEngine().prioritizeNetworkWallet(toStdString(env, walletId));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeStartRefresh(
    JNIEnv* env,
    jclass,
    jstring walletId) {
  try {
    walletEngine().startRefresh(toStdString(env, walletId));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeStopRefresh(
    JNIEnv* env,
    jclass,
    jstring walletId) {
  try {
    walletEngine().stopRefresh(toStdString(env, walletId));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativePersistOpenWallets(
    JNIEnv* env,
    jclass) {
  try {
    walletEngine().persistOpenWallets();
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCloseAllWallets(
    JNIEnv* env,
    jclass) {
  try {
    walletEngine().closeAllWallets(true);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeGetAddress(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jdouble accountIndex,
    jdouble addressIndex) {
  try {
    return toJavaString(
        env,
        walletEngine().getAddress(
            toStdString(env, walletId),
            toUInt32(accountIndex, "accountIndex"),
            toUInt32(addressIndex, "addressIndex")));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeValidateRecipientAddress(
    JNIEnv* env,
    jclass,
    jstring address,
    jstring network) {
  try {
    return toJavaString(
        env,
        walletEngine().validateRecipientAddress(
            toStdString(env, address),
            parseNetwork(toStdString(env, network))));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeVerifyMfwNameRecordAddress(
    JNIEnv* env,
    jclass,
    jstring recordPayloadHex,
    jstring expectedName,
    jstring network,
    jstring signingOwnerPublicKeyHex) {
  try {
    return toJavaString(
        env,
        tex8::wallet::fast_wallet_protocol_bridge::verifiedNameAddress(
            walletEngine(),
            toStdString(env, recordPayloadHex),
            toStdString(env, expectedName),
            parseNetwork(toStdString(env, network)),
            toStdString(env, signingOwnerPublicKeyHex)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeNormalizePrivatePhoneE164(
    JNIEnv* env,
    jclass,
    jstring input) {
  try {
    return toJavaString(
        env,
        tex8::wallet::fast_wallet_protocol_bridge::normalizePrivatePhoneE164(
            toStdString(env, input)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeBlindPrivatePhone(
    JNIEnv* env,
    jclass,
    jstring normalizedE164,
    jdouble epoch) {
  try {
    const auto result =
        tex8::wallet::fast_wallet_protocol_bridge::blindPrivatePhone(
            toStdString(env, normalizedE164), toUInt64(epoch, "epoch"));
    return toJavaString(env, result.stateHandleHex + result.requestHex);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeFinalizePrivatePhone(
    JNIEnv* env,
    jclass,
    jstring stateHandle,
    jstring evaluationHex,
    jstring expectedServerPublicKeyHex) {
  try {
    return toJavaString(
        env,
        tex8::wallet::fast_wallet_protocol_bridge::finalizePrivatePhone(
            toStdString(env, stateHandle),
            toStdString(env, evaluationHex),
            toStdString(env, expectedServerPublicKeyHex)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeDiscardPrivatePhoneSession(
    JNIEnv* env,
    jclass,
    jstring stateHandle) {
  try {
    tex8::wallet::fast_wallet_protocol_bridge::discardPrivatePhoneSession(
        toStdString(env, stateHandle));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCombinePrivatePhoneToken(
    JNIEnv* env,
    jclass,
    jstring firstServerPublicKeyHex,
    jstring firstOutputHex,
    jstring secondServerPublicKeyHex,
    jstring secondOutputHex) {
  try {
    return toJavaString(
        env,
        tex8::wallet::fast_wallet_protocol_bridge::combinePrivatePhoneToken(
            toStdString(env, firstServerPublicKeyHex),
            toStdString(env, firstOutputHex),
            toStdString(env, secondServerPublicKeyHex),
            toStdString(env, secondOutputHex)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeDerivePrivatePhonePairId(
    JNIEnv* env,
    jclass,
    jstring firstPhoneTokenHex,
    jstring secondPhoneTokenHex) {
  try {
    return toJavaString(
        env,
        tex8::wallet::fast_wallet_protocol_bridge::derivePrivatePhonePairId(
            toStdString(env, firstPhoneTokenHex),
            toStdString(env, secondPhoneTokenHex)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeGeneratePrivatePhoneIdentity(
    JNIEnv* env,
    jclass) {
  try {
    auto result =
        tex8::wallet::fast_wallet_protocol_bridge::generatePrivatePhoneIdentity();
    std::string encoded = result.privateKeyHex + result.publicKeyHex;
    tex8::wallet::secureClear(result.privateKeyHex);
    jstring javaResult = toJavaString(env, encoded);
    tex8::wallet::secureClear(encoded);
    return javaResult;
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeGeneratePrivatePhoneRegistrationIdentity(
    JNIEnv* env,
    jclass) {
  try {
    auto result = tex8::wallet::fast_wallet_protocol_bridge::
        generatePrivatePhoneRegistrationIdentity();
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        contactPrivateGuard(result.contactPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        hpkePrivateGuard(result.hpkePrivateKeyHex);
    std::string encoded =
        result.contactPrivateKeyHex + result.contactPublicKeyHex +
        result.hpkePrivateKeyHex + result.hpkePublicKeyHex;
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard encodedGuard(
        encoded);
    return toJavaString(env, encoded);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeVerifyPrivatePhoneParticipant(
    JNIEnv* env,
    jclass,
    jstring participantHex,
    jstring expectedVerificationPublicKeyHex,
    jdouble expectedEpoch,
    jstring expectedContactPublicKeyHex,
    jstring expectedHpkePublicKeyHex,
    jdouble now) {
  try {
    const auto result =
        tex8::wallet::fast_wallet_protocol_bridge::verifyPrivatePhoneParticipant(
            toStdString(env, participantHex),
            toStdString(env, expectedVerificationPublicKeyHex),
            toExactUInt64(expectedEpoch, "expectedEpoch"),
            toStdString(env, expectedContactPublicKeyHex),
            toStdString(env, expectedHpkePublicKeyHex),
            toExactUInt64(now, "now"));
    return toJavaString(
        env,
        result.phoneTokenHex + "|" + std::to_string(result.expiresAt) + "|" +
            std::to_string(result.sequence));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSignPrivatePhonePermitRefresh(
    JNIEnv* env,
    jclass,
    jdouble epoch,
    jstring phoneTokenHex,
    jdouble participantSequence,
    jdouble issuedAt,
    jdouble expiresAt,
    jstring contactPrivateKeyHex) {
  try {
    std::string contactPrivate = toStdString(env, contactPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard privateGuard(
        contactPrivate);
    auto output =
        tex8::wallet::fast_wallet_protocol_bridge::
            signPrivatePhonePermitRefresh(
                toExactUInt64(epoch, "epoch"),
                toStdString(env, phoneTokenHex),
                toExactUInt64(participantSequence, "participantSequence"),
                toExactUInt64(issuedAt, "issuedAt"),
                toExactUInt64(expiresAt, "expiresAt"), contactPrivate);
    return toJavaByteArray(env, output);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSealPrivatePhoneContact(
    JNIEnv* env,
    jclass,
    jstring publisherPhoneTokenHex,
    jstring recipientPhoneTokenHex,
    jdouble policy,
    jstring network,
    jdouble issuedAt,
    jdouble expiresAt,
    jdouble sequence,
    jdouble addressKind,
    jstring publicSpendKeyHex,
    jstring publicViewKeyHex,
    jstring contactPrivateKeyHex,
    jstring recipientHpkePublicKeyHex) {
  try {
    std::string contactPrivate = toStdString(env, contactPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard privateGuard(
        contactPrivate);
    auto output =
        tex8::wallet::fast_wallet_protocol_bridge::sealPrivatePhoneContact(
            toStdString(env, publisherPhoneTokenHex),
            toStdString(env, recipientPhoneTokenHex),
            toUnsignedByte(policy, "policy"),
            parseNetwork(toStdString(env, network)),
            toExactUInt64(issuedAt, "issuedAt"),
            toExactUInt64(expiresAt, "expiresAt"),
            toExactUInt64(sequence, "sequence"),
            toUnsignedByte(addressKind, "addressKind"),
            toStdString(env, publicSpendKeyHex),
            toStdString(env, publicViewKeyHex), contactPrivate,
            toStdString(env, recipientHpkePublicKeyHex));
    return toJavaByteArray(env, output);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSealPrivatePhoneAskRequest(
    JNIEnv* env,
    jclass,
    jstring requesterPhoneTokenHex,
    jstring targetPhoneTokenHex,
    jstring network,
    jdouble issuedAt,
    jdouble expiresAt,
    jdouble sequence,
    jstring contactPrivateKeyHex,
    jstring targetHpkePublicKeyHex) {
  try {
    std::string contactPrivate = toStdString(env, contactPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard privateGuard(
        contactPrivate);
    auto result =
        tex8::wallet::fast_wallet_protocol_bridge::sealPrivatePhoneAskRequest(
            toStdString(env, requesterPhoneTokenHex),
            toStdString(env, targetPhoneTokenHex),
            parseNetwork(toStdString(env, network)),
            toExactUInt64(issuedAt, "issuedAt"),
            toExactUInt64(expiresAt, "expiresAt"),
            toExactUInt64(sequence, "sequence"), contactPrivate,
            toStdString(env, targetHpkePublicKeyHex));
    const std::string encoded =
        result.requestIdHex + "|" +
        tex8::wallet::fast_wallet_protocol_bridge::encodeHex(
            result.requestState.data(), result.requestState.size()) +
        "|" + tex8::wallet::fast_wallet_protocol_bridge::encodeHex(
                  result.envelope.data(), result.envelope.size());
    std::fill(result.requestState.begin(), result.requestState.end(), 0);
    std::fill(result.envelope.begin(), result.envelope.end(), 0);
    return toJavaString(env, encoded);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeInspectPrivatePhoneAskEnvelope(
    JNIEnv* env,
    jclass,
    jbyteArray envelope) {
  try {
    const auto bytes =
        toByteVector(env, envelope, TEX8_MFW_ASK_ENVELOPE_SIZE,
                     TEX8_MFW_ASK_ENVELOPE_SIZE);
    const auto header =
        tex8::wallet::fast_wallet_protocol_bridge::
            inspectPrivatePhoneAskEnvelope(bytes.data(), bytes.size());
    return toJavaString(
        env,
        std::to_string(header.kind) + "|" + header.pairIdHex + "|" +
            header.requestIdHex + "|" + header.senderPhoneTokenHex + "|" +
            header.recipientPhoneTokenHex + "|" +
            std::to_string(header.issuedAt) + "|" +
            std::to_string(header.expiresAt) + "|" +
            std::to_string(header.sequence));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeOpenPrivatePhoneAskRequest(
    JNIEnv* env,
    jclass,
    jbyteArray envelope,
    jstring expectedRequesterPublicKeyHex,
    jstring targetHpkePrivateKeyHex,
    jstring targetHpkePublicKeyHex,
    jdouble now) {
  try {
    const auto bytes =
        toByteVector(env, envelope, TEX8_MFW_ASK_ENVELOPE_SIZE,
                     TEX8_MFW_ASK_ENVELOPE_SIZE);
    std::string targetPrivate = toStdString(env, targetHpkePrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard privateGuard(
        targetPrivate);
    const auto request =
        tex8::wallet::fast_wallet_protocol_bridge::openPrivatePhoneAskRequest(
            bytes.data(), bytes.size(),
            toStdString(env, expectedRequesterPublicKeyHex), targetPrivate,
            toStdString(env, targetHpkePublicKeyHex),
            toExactUInt64(now, "now"));
    return toJavaByteArray(env, request);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSealPrivatePhoneAskResponse(
    JNIEnv* env,
    jclass,
    jbyteArray request,
    jboolean approved,
    jdouble issuedAt,
    jdouble expiresAt,
    jdouble sequence,
    jdouble addressKind,
    jstring publicSpendKeyHex,
    jstring publicViewKeyHex,
    jstring responderContactPrivateKeyHex,
    jstring requesterHpkePublicKeyHex) {
  try {
    const auto requestBytes =
        toByteVector(env, request, TEX8_MFW_ASK_MESSAGE_SIZE,
                     TEX8_MFW_ASK_MESSAGE_SIZE);
    std::string contactPrivate =
        toStdString(env, responderContactPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard privateGuard(
        contactPrivate);
    const auto envelope =
        tex8::wallet::fast_wallet_protocol_bridge::
            sealPrivatePhoneAskResponse(
                requestBytes.data(), requestBytes.size(), approved == JNI_TRUE,
                toExactUInt64(issuedAt, "issuedAt"),
                toExactUInt64(expiresAt, "expiresAt"),
                toExactUInt64(sequence, "sequence"),
                toUnsignedByte(addressKind, "addressKind"),
                toStdString(env, publicSpendKeyHex),
                toStdString(env, publicViewKeyHex), contactPrivate,
                toStdString(env, requesterHpkePublicKeyHex));
    return toJavaByteArray(env, envelope);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeOpenPrivatePhoneAskResponse(
    JNIEnv* env,
    jclass,
    jbyteArray envelope,
    jstring expectedResponderPublicKeyHex,
    jstring requesterHpkePrivateKeyHex,
    jstring requesterHpkePublicKeyHex,
    jdouble now,
    jbyteArray expectedRequest,
    jstring expectedNetwork) {
  try {
    const auto envelopeBytes =
        toByteVector(env, envelope, TEX8_MFW_ASK_ENVELOPE_SIZE,
                     TEX8_MFW_ASK_ENVELOPE_SIZE);
    const auto requestBytes =
        toByteVector(env, expectedRequest, TEX8_MFW_ASK_MESSAGE_SIZE,
                     TEX8_MFW_ASK_MESSAGE_SIZE);
    std::string requesterPrivate =
        toStdString(env, requesterHpkePrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard privateGuard(
        requesterPrivate);
    const auto result =
        tex8::wallet::fast_wallet_protocol_bridge::
            openPrivatePhoneAskResponse(
                walletEngine(), envelopeBytes.data(), envelopeBytes.size(),
                toStdString(env, expectedResponderPublicKeyHex),
                requesterPrivate, toStdString(env, requesterHpkePublicKeyHex),
                toExactUInt64(now, "now"), requestBytes.data(),
                requestBytes.size(),
                parseNetwork(toStdString(env, expectedNetwork)));
    return toJavaString(
        env,
        std::string(result.approved ? "approved" : "declined") + "|" +
            networkName(result.network) + "|" + result.address + "|" +
            std::to_string(result.issuedAt) + "|" +
            std::to_string(result.expiresAt) + "|" +
            std::to_string(result.sequence));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSignPrivatePhoneAskMailboxPoll(
    JNIEnv* env,
    jclass,
    jdouble kind,
    jstring participantPhoneTokenHex,
    jdouble participantSequence,
    jstring participantHpkePublicKeyHex,
    jdouble afterCursor,
    jdouble issuedAt,
    jdouble expiresAt,
    jstring participantContactPrivateKeyHex) {
  try {
    std::string contactPrivate =
        toStdString(env, participantContactPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard privateGuard(
        contactPrivate);
    const auto poll =
        tex8::wallet::fast_wallet_protocol_bridge::
            signPrivatePhoneAskMailboxPoll(
                toUnsignedByte(kind, "kind"),
                toStdString(env, participantPhoneTokenHex),
                toExactUInt64(participantSequence, "participantSequence"),
                toStdString(env, participantHpkePublicKeyHex),
                toExactUInt64(afterCursor, "afterCursor"),
                toExactUInt64(issuedAt, "issuedAt"),
                toExactUInt64(expiresAt, "expiresAt"), contactPrivate);
    return toJavaByteArray(env, poll);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeRevokePrivatePhoneContact(
    JNIEnv* env,
    jclass,
    jstring publisherPhoneTokenHex,
    jstring recipientPhoneTokenHex,
    jdouble issuedAt,
    jdouble expiresAt,
    jdouble sequence,
    jstring contactPrivateKeyHex) {
  try {
    std::string contactPrivate = toStdString(env, contactPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard privateGuard(
        contactPrivate);
    const auto output =
        tex8::wallet::fast_wallet_protocol_bridge::revokePrivatePhoneContact(
            toStdString(env, publisherPhoneTokenHex),
            toStdString(env, recipientPhoneTokenHex),
            toExactUInt64(issuedAt, "issuedAt"),
            toExactUInt64(expiresAt, "expiresAt"),
            toExactUInt64(sequence, "sequence"), contactPrivate);
    return toJavaByteArray(env, output);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeRevokePrivatePhoneParticipant(
    JNIEnv* env,
    jclass,
    jstring phoneTokenHex,
    jdouble issuedAt,
    jdouble expiresAt,
    jdouble cooldownUntil,
    jdouble sequence,
    jstring contactPrivateKeyHex) {
  try {
    std::string contactPrivate = toStdString(env, contactPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard privateGuard(
        contactPrivate);
    const auto output =
        tex8::wallet::fast_wallet_protocol_bridge::
            revokePrivatePhoneParticipant(
                toStdString(env, phoneTokenHex),
                toExactUInt64(issuedAt, "issuedAt"),
                toExactUInt64(expiresAt, "expiresAt"),
                toExactUInt64(cooldownUntil, "cooldownUntil"),
                toExactUInt64(sequence, "sequence"), contactPrivate);
    return toJavaByteArray(env, output);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeFindPrivatePhoneSnapshotParticipant(
    JNIEnv* env,
    jclass,
    jbyteArray snapshot,
    jstring expectedDirectoryPublicKeyHex,
    jstring expectedVerificationPublicKeyHex,
    jdouble now,
    jstring phoneTokenHex) {
  try {
    const auto snapshotBytes =
        toByteVector(env, snapshot, 137, 256 * 1024 * 1024);
    const auto result = tex8::wallet::fast_wallet_protocol_bridge::
        findPrivatePhoneSnapshotParticipant(
            snapshotBytes.data(), snapshotBytes.size(),
            toStdString(env, expectedDirectoryPublicKeyHex),
            toStdString(env, expectedVerificationPublicKeyHex),
            toExactUInt64(now, "now"),
            toStdString(env, phoneTokenHex));
    return toJavaString(
        env,
        result.contactSigningPublicKeyHex + "|" + result.hpkePublicKeyHex +
            "|" + std::to_string(result.participantExpiresAt) + "|" +
            std::to_string(result.participantSequence) + "|" +
            std::to_string(result.snapshotGeneration) + "|" +
            std::to_string(result.snapshotIssuedAt) + "|" +
            std::to_string(result.snapshotExpiresAt));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeDecodePrivatePhoneMoneroAddress(
    JNIEnv* env,
    jclass,
    jstring address,
    jstring network) {
  try {
    const auto result =
        tex8::wallet::fast_wallet_protocol_bridge::
            verifiedMoneroPublicAddressParts(
                walletEngine(), toStdString(env, address),
                parseNetwork(toStdString(env, network)));
    return toJavaString(
        env,
        std::to_string(result.addressKind) + "|" +
            result.publicSpendKeyHex + "|" + result.publicViewKeyHex);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeOpenPrivatePhoneSnapshotContact(
    JNIEnv* env,
    jclass,
    jstring snapshotHex,
    jstring expectedDirectoryPublicKeyHex,
    jstring expectedVerificationPublicKeyHex,
    jdouble now,
    jstring pairIdHex,
    jstring publisherPhoneTokenHex,
    jstring recipientPrivateKeyHex,
    jstring recipientPublicKeyHex,
    jstring expectedNetwork) {
  try {
    const auto result =
        tex8::wallet::fast_wallet_protocol_bridge::openPrivatePhoneSnapshotContact(
            walletEngine(),
            toStdString(env, snapshotHex),
            toStdString(env, expectedDirectoryPublicKeyHex),
            toStdString(env, expectedVerificationPublicKeyHex),
            toUInt64(now, "now"),
            toStdString(env, pairIdHex),
            toStdString(env, publisherPhoneTokenHex),
            toStdString(env, recipientPrivateKeyHex),
            toStdString(env, recipientPublicKeyHex),
            parseNetwork(toStdString(env, expectedNetwork)));
    return toJavaString(
        env,
        result.policy + "|" + networkName(result.network) + "|" +
            result.address + "|" + std::to_string(result.issuedAt) + "|" +
            std::to_string(result.expiresAt) + "|" +
            std::to_string(result.sequence));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeOpenPrivatePhoneSnapshotContactBytes(
    JNIEnv* env,
    jclass,
    jbyteArray snapshot,
    jstring expectedDirectoryPublicKeyHex,
    jstring expectedVerificationPublicKeyHex,
    jdouble now,
    jstring pairIdHex,
    jstring publisherPhoneTokenHex,
    jstring recipientPrivateKeyHex,
    jstring recipientPublicKeyHex,
    jstring expectedNetwork) {
  try {
    const auto snapshotBytes =
        toByteVector(env, snapshot, 137, 256 * 1024 * 1024);
    const auto result = tex8::wallet::fast_wallet_protocol_bridge::
        openPrivatePhoneSnapshotContactBytes(
            walletEngine(), snapshotBytes.data(), snapshotBytes.size(),
            toStdString(env, expectedDirectoryPublicKeyHex),
            toStdString(env, expectedVerificationPublicKeyHex),
            toUInt64(now, "now"),
            toStdString(env, pairIdHex),
            toStdString(env, publisherPhoneTokenHex),
            toStdString(env, recipientPrivateKeyHex),
            toStdString(env, recipientPublicKeyHex),
            parseNetwork(toStdString(env, expectedNetwork)));
    return toJavaString(
        env,
        result.policy + "|" + networkName(result.network) + "|" +
            result.address + "|" + std::to_string(result.issuedAt) + "|" +
            std::to_string(result.expiresAt) + "|" +
            std::to_string(result.sequence));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCreateSubaddress(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jdouble accountIndex,
    jstring label) {
  try {
    return toJavaMap(
        env,
        walletEngine().createSubaddress(
            toStdString(env, walletId),
            toUInt32(accountIndex, "accountIndex"),
            toStdString(env, label)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeListSubaddresses(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jdouble accountIndex) {
  try {
    return toJavaSubaddressList(
        env,
        walletEngine().listSubaddresses(
            toStdString(env, walletId),
            toUInt32(accountIndex, "accountIndex")));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeGetSeed(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jstring seedOffset) {
  try {
    auto seed = walletEngine().getSeed(
        toStdString(env, walletId),
        toStdString(env, seedOffset));
    auto* result = toJavaString(env, seed);
    tex8::wallet::secureClear(seed);
    return result;
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSetWalletPassword(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jstring newPassword) {
  try {
    walletEngine().setWalletPassword(
        toStdString(env, walletId), toStdString(env, newPassword));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeGetBalance(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jdouble accountIndex) {
  try {
    return toJavaString(
        env,
        std::to_string(walletEngine().getBalance(
            toStdString(env, walletId),
            toUInt32(accountIndex, "accountIndex"))));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeGetUnlockedBalance(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jdouble accountIndex) {
  try {
    return toJavaString(
        env,
        std::to_string(walletEngine().getUnlockedBalance(
            toStdString(env, walletId),
            toUInt32(accountIndex, "accountIndex"))));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSnapshot(
    JNIEnv* env,
    jclass,
    jstring walletId) {
  try {
    return toJavaMap(env, walletEngine().snapshot(toStdString(env, walletId)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeGetTransactions(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jdouble limit) {
  try {
    return toJavaTransactionList(
        env,
        walletEngine().getTransactions(
            toStdString(env, walletId),
            toUInt32(limit, "limit")));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeGetOwnedOutputKeyImages(
    JNIEnv* env,
    jclass,
    jstring walletId) {
  try {
    return toJavaStringList(
        env,
        walletEngine().getOwnedOutputKeyImages(toStdString(env, walletId)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeSyncLedgerKeyImagesToViewWallet(
    JNIEnv* env,
    jclass,
    jstring hardwareWalletId,
    jstring viewOnlyWalletId) {
  try {
    return toJavaMap(
        env,
        walletEngine().syncLedgerKeyImagesToViewWallet(
            toStdString(env, hardwareWalletId),
            toStdString(env, viewOnlyWalletId)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativePrepareTransaction(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jstring address,
    jstring amountAtomic,
    jstring paymentId,
    jstring priority,
    jdouble accountIndex) {
  try {
    PrepareTransactionRequest request;
    request.walletId = toStdString(env, walletId);
    request.address = toStdString(env, address);
    request.amountAtomic = toStdString(env, amountAtomic);
    request.paymentId = toStdString(env, paymentId);
    request.priority = toStdString(env, priority);
    request.accountIndex = toUInt32(accountIndex, "accountIndex");
    return toJavaMap(env, walletEngine().prepareTransaction(request));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativePrepareMfwNameRegistration(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jstring name,
    jstring address,
    jstring network,
    jstring registryAddress,
    jstring priority,
    jdouble accountIndex) {
  try {
    const auto nameValue = toStdString(env, name);
    const auto addressValue = toStdString(env, address);
    const auto networkValue = parseNetwork(toStdString(env, network));
    auto material =
        tex8::wallet::fast_wallet_protocol_bridge::
            generateMfwNameRegistrationMaterial(
                walletEngine(), nameValue, addressValue, networkValue);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        ownerPrivateKeyGuard(material.ownerPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        commitSaltGuard(material.commitSaltHex);

    PrepareTransactionRequest request;
    request.walletId = toStdString(env, walletId);
    request.address = toStdString(env, registryAddress);
    request.amountAtomic = "1";
    request.priority = toStdString(env, priority);
    request.accountIndex = toUInt32(accountIndex, "accountIndex");
    request.mfwNameExtraNonce = material.commitExtraNonce;
    const auto prepared = walletEngine().prepareTransaction(request);
    std::fill(
        material.commitExtraNonce.begin(),
        material.commitExtraNonce.end(),
        0);

    jobject map = toJavaMap(env, prepared);
    const jmethodID putMethod = hashMapPutMethod(env);
    putMapString(
        env,
        map,
        putMethod,
        "ownerPrivateKeyHex",
        material.ownerPrivateKeyHex);
    putMapString(
        env,
        map,
        putMethod,
        "ownerPublicKeyHex",
        material.ownerPublicKeyHex);
    putMapString(
        env,
        map,
        putMethod,
        "commitSaltHex",
        material.commitSaltHex);
    return map;
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativePrepareMfwNameClaim(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jstring name,
    jstring address,
    jstring network,
    jstring registryAddress,
    jdouble years,
    jstring priority,
    jdouble accountIndex,
    jstring ownerPrivateKeyHex,
    jstring commitSaltHex) {
  try {
    auto ownerPrivateKeyValue = toStdString(env, ownerPrivateKeyHex);
    auto commitSaltValue = toStdString(env, commitSaltHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        ownerPrivateKeyGuard(ownerPrivateKeyValue);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        commitSaltGuard(commitSaltValue);
    const uint32_t termYears = toUInt32(years, "years");
    if (termYears < 1 || termYears > kMfwNameMaximumTermYears) {
      throw WalletEngineError("MFW name term must be between 1 and 1000 years");
    }
    auto record =
        tex8::wallet::fast_wallet_protocol_bridge::prepareMfwNameClaimRecord(
            walletEngine(),
            toStdString(env, name),
            toStdString(env, address),
            parseNetwork(toStdString(env, network)),
            ownerPrivateKeyValue,
            commitSaltValue);

    PrepareTransactionRequest request;
    request.walletId = toStdString(env, walletId);
    request.address = toStdString(env, registryAddress);
    request.amountAtomic =
        std::to_string(kMfwNameAnnualFeeAtomic * static_cast<uint64_t>(termYears));
    request.priority = toStdString(env, priority);
    request.accountIndex = toUInt32(accountIndex, "accountIndex");
    request.mfwNameExtraNonce = record.extraNonce;
    const auto prepared = walletEngine().prepareTransaction(request);
    std::fill(record.extraNonce.begin(), record.extraNonce.end(), 0);

    jobject map = toJavaMap(env, prepared);
    putMapString(
        env,
        map,
        hashMapPutMethod(env),
        "ownerPublicKeyHex",
        record.ownerPublicKeyHex);
    return map;
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativePrepareMfwNameTransition(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jstring operation,
    jstring name,
    jstring address,
    jstring network,
    jstring registryAddress,
    jdouble years,
    jstring predecessorRecordHex,
    jstring predecessorSigningOwnerPublicKeyHex,
    jstring priority,
    jdouble accountIndex,
    jstring ownerPrivateKeyHex) {
  try {
    const auto operationValue = toStdString(env, operation);
    const unsigned char operationCode =
        operationValue == "update" ? 3
        : operationValue == "renew" ? 4
        : operationValue == "revoke" ? 5
                                     : 0;
    if (operationCode == 0) {
      throw WalletEngineError("MFW name transition operation is invalid");
    }
    const uint32_t termYears = toUInt32(years, "years");
    if (termYears < 1 || termYears > kMfwNameMaximumTermYears) {
      throw WalletEngineError("MFW name term must be between 1 and 1000 years");
    }
    auto ownerPrivateKeyValue = toStdString(env, ownerPrivateKeyHex);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        ownerPrivateKeyGuard(ownerPrivateKeyValue);
    auto record = tex8::wallet::fast_wallet_protocol_bridge::
        prepareMfwNameTransitionRecord(
            walletEngine(),
            operationCode,
            toStdString(env, name),
            toStdString(env, address),
            parseNetwork(toStdString(env, network)),
            ownerPrivateKeyValue,
            toStdString(env, predecessorRecordHex),
            toStdString(env, predecessorSigningOwnerPublicKeyHex));

    PrepareTransactionRequest request;
    request.walletId = toStdString(env, walletId);
    request.address = operationCode == 4
                          ? toStdString(env, registryAddress)
                          : toStdString(env, address);
    request.amountAtomic =
        operationCode == 4
            ? std::to_string(
                  kMfwNameAnnualFeeAtomic * static_cast<uint64_t>(termYears))
            : "1";
    request.priority = toStdString(env, priority);
    request.accountIndex = toUInt32(accountIndex, "accountIndex");
    request.mfwNameExtraNonce = record.extraNonce;
    const auto prepared = walletEngine().prepareTransaction(request);
    std::fill(record.extraNonce.begin(), record.extraNonce.end(), 0);
    return toJavaMap(env, prepared);
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeExportMfwNameRecovery(
    JNIEnv* env,
    jclass,
    jstring name,
    jstring network,
    jstring ownerPrivateKeyHex,
    jstring passphrase) {
  try {
    auto ownerPrivateKeyValue = toStdString(env, ownerPrivateKeyHex);
    auto passphraseValue = toStdString(env, passphrase);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        ownerPrivateKeyGuard(ownerPrivateKeyValue);
    const auto encoded =
        tex8::wallet::fast_wallet_protocol_bridge::exportMfwNameRecovery(
            toStdString(env, name),
            parseNetwork(toStdString(env, network)),
            ownerPrivateKeyValue,
            passphraseValue);
    return env->NewStringUTF(encoded.c_str());
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeImportMfwNameRecovery(
    JNIEnv* env,
    jclass,
    jstring bundleHex,
    jstring expectedName,
    jstring expectedNetwork,
    jstring passphrase) {
  try {
    auto passphraseValue = toStdString(env, passphrase);
    auto recovered =
        tex8::wallet::fast_wallet_protocol_bridge::importMfwNameRecovery(
            toStdString(env, bundleHex),
            toStdString(env, expectedName),
            parseNetwork(toStdString(env, expectedNetwork)),
            passphraseValue);
    tex8::wallet::fast_wallet_protocol_bridge::SecretStringGuard
        ownerPrivateKeyGuard(recovered.ownerPrivateKeyHex);
    jobject map = newHashMap(env);
    jmethodID putMethod = hashMapPutMethod(env);
    putMapString(
        env,
        map,
        putMethod,
        "ownerPrivateKeyHex",
        recovered.ownerPrivateKeyHex);
    putMapString(
        env,
        map,
        putMethod,
        "ownerPublicKeyHex",
        recovered.ownerPublicKeyHex);
    return map;
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCommitTransaction(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jstring pendingId) {
  try {
    return toJavaMap(
        env,
        walletEngine().commitTransaction(
            toStdString(env, walletId),
            toStdString(env, pendingId)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeGetHardwareWalletStatus(
    JNIEnv* env,
    jclass,
    jstring walletId) {
  try {
    return toJavaMap(
        env,
        walletEngine().getHardwareWalletStatus(toStdString(env, walletId)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeReconnectHardwareWallet(
    JNIEnv* env,
    jclass,
    jstring walletId) {
  try {
    return toJavaMap(
        env,
        walletEngine().reconnectHardwareWallet(toStdString(env, walletId)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jobject JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeShowHardwareWalletAddress(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jdouble accountIndex,
    jdouble addressIndex,
    jstring paymentId) {
  try {
    return toJavaMap(
        env,
        walletEngine().showHardwareWalletAddress(
            toStdString(env, walletId),
            toUInt32(accountIndex, "accountIndex"),
            toUInt32(addressIndex, "addressIndex"),
            toStdString(env, paymentId)));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
  }
}
