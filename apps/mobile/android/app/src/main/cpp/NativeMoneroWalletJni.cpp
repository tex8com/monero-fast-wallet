#include "WalletEngine.h"

#include <jni.h>

#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>

namespace {

using tex8::wallet::CreateWalletRequest;
using tex8::wallet::DaemonConfig;
using tex8::wallet::NetworkType;
using tex8::wallet::OpenWalletRequest;
using tex8::wallet::RestoreWalletRequest;
using tex8::wallet::WalletEngine;
using tex8::wallet::WalletEngineError;
using tex8::wallet::WalletSnapshot;

WalletEngine& walletEngine() {
  static WalletEngine engine;
  return engine;
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

jstring toJavaString(JNIEnv* env, const std::string& value) {
  return env->NewStringUTF(value.c_str());
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

uint64_t toUInt64(jdouble value, const char* fieldName) {
  if (value < 0 ||
      value > static_cast<jdouble>(std::numeric_limits<uint64_t>::max())) {
    throw WalletEngineError(std::string(fieldName) + " is out of range");
  }
  return static_cast<uint64_t>(value);
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
  putMapBoolean(env, map, putMethod, "synchronized", snapshot.synchronized);

  return map;
}

} // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeLinkedWithMonero(
    JNIEnv*,
    jclass) {
  return WalletEngine::linkedWithMonero();
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
    jstring network) {
  try {
    OpenWalletRequest request;
    request.path = toStdString(env, path);
    request.password = toStdString(env, password);
    request.network = parseNetwork(toStdString(env, network));
    return toJavaString(env, walletEngine().openWallet(request));
  } catch (const std::exception& error) {
    throwJavaError(env, error);
    return nullptr;
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
