#include "WalletEngine.h"

#include <jni.h>

#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using tex8::wallet::CreateWalletRequest;
using tex8::wallet::CreateWalletFromDeviceRequest;
using tex8::wallet::CreateFastReceiveIdentityRequest;
using tex8::wallet::DaemonConfig;
using tex8::wallet::FastReceiveIdentity;
using tex8::wallet::HardwareWalletStatus;
using tex8::wallet::NetworkType;
using tex8::wallet::OpenWalletRequest;
using tex8::wallet::PreparedTransaction;
using tex8::wallet::PrepareTransactionRequest;
using tex8::wallet::RestoreWalletRequest;
using tex8::wallet::WalletEngine;
using tex8::wallet::WalletEngineError;
using tex8::wallet::WalletSnapshot;
using tex8::wallet::WalletTransaction;
using tex8::wallet::WalletTransactionTransfer;

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
  putMapBoolean(env, map, putMethod, "synchronized", snapshot.synchronized);

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

extern "C" JNIEXPORT jstring JNICALL
Java_com_monerowallet_NativeMoneroWalletJni_nativeCreateWalletFromDevice(
    JNIEnv* env,
    jclass,
    jstring path,
    jstring password,
    jstring network,
    jstring deviceName,
    jdouble restoreHeight,
    jstring subaddressLookahead) {
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
    return toJavaString(env, walletEngine().createWalletFromDevice(request));
  } catch (const std::exception& error) {
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
Java_com_monerowallet_NativeMoneroWalletJni_nativeGetSeed(
    JNIEnv* env,
    jclass,
    jstring walletId,
    jstring seedOffset) {
  try {
    return toJavaString(
        env,
        walletEngine().getSeed(
            toStdString(env, walletId),
            toStdString(env, seedOffset)));
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
