#pragma once

#include "WalletEngine.h"
#include "fast_wallet_protocol.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <iterator>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace tex8::wallet {

namespace fast_wallet_protocol_bridge {

inline unsigned char networkCode(NetworkType network) {
  switch (network) {
    case NetworkType::Mainnet:
      return 0;
    case NetworkType::Testnet:
      return 1;
    case NetworkType::Stagenet:
      return 2;
  }
  throw WalletEngineError("unknown Fast Wallet network");
}

inline unsigned char hexNibble(char value) {
  if (value >= '0' && value <= '9') {
    return static_cast<unsigned char>(value - '0');
  }
  if (value >= 'a' && value <= 'f') {
    return static_cast<unsigned char>(value - 'a' + 10);
  }
  throw WalletEngineError("Fast Wallet protocol data must be lowercase hex");
}

inline std::vector<unsigned char> decodeHex(const std::string& value,
                                            std::size_t minimum,
                                            std::size_t maximum) {
  if (value.size() % 2 != 0 || value.size() / 2 < minimum ||
      value.size() / 2 > maximum) {
    throw WalletEngineError("Fast Wallet protocol data has an invalid length");
  }
  std::vector<unsigned char> output(value.size() / 2);
  for (std::size_t index = 0; index < output.size(); ++index) {
    output[index] = static_cast<unsigned char>(
        (hexNibble(value[index * 2]) << 4) |
        hexNibble(value[index * 2 + 1]));
  }
  return output;
}

inline std::string encodeHex(const unsigned char* bytes, std::size_t length) {
  static constexpr char alphabet[] = "0123456789abcdef";
  std::string output(length * 2, '0');
  for (std::size_t index = 0; index < length; ++index) {
    output[index * 2] = alphabet[bytes[index] >> 4];
    output[index * 2 + 1] = alphabet[bytes[index] & 0x0f];
  }
  return output;
}

// The Rust protocol API emits one complete Monero tx_extra nonce field:
// tag 0x02, canonical varint length, then the nonce. Monero's wallet API
// expects only the inner nonce, so mobile and desktop normalize it here.
inline bool extractCanonicalExtraNonceField(
    const unsigned char* field,
    std::size_t fieldLength,
    std::vector<unsigned char>& nonce) {
  nonce.clear();
  if (field == nullptr || fieldLength < 3 || field[0] != 0x02) {
    return false;
  }
  std::size_t cursor = 1;
  const unsigned char firstLengthByte = field[cursor++];
  std::size_t nonceLength = 0;
  if ((firstLengthByte & 0x80) == 0) {
    nonceLength = firstLengthByte;
  } else {
    if (cursor >= fieldLength) {
      return false;
    }
    const unsigned char secondLengthByte = field[cursor++];
    nonceLength = static_cast<std::size_t>(firstLengthByte & 0x7f) |
        (static_cast<std::size_t>(secondLengthByte & 0x7f) << 7);
    if ((secondLengthByte & 0x80) != 0 || secondLengthByte == 0 ||
        nonceLength < 128) {
      return false;
    }
  }
  if (nonceLength == 0 || nonceLength > 255 ||
      cursor + nonceLength != fieldLength) {
    return false;
  }
  nonce.assign(field + cursor, field + fieldLength);
  return true;
}

class SecretStringGuard {
 public:
  explicit SecretStringGuard(std::string& value) : value_(value) {}
  ~SecretStringGuard() { secureClear(value_); }

  SecretStringGuard(const SecretStringGuard&) = delete;
  SecretStringGuard& operator=(const SecretStringGuard&) = delete;

 private:
  std::string& value_;
};

struct PrivatePhoneIdentity {
  std::string privateKeyHex;
  std::string publicKeyHex;
};

struct PrivatePhoneRegistrationIdentity {
  std::string contactPrivateKeyHex;
  std::string contactPublicKeyHex;
  std::string hpkePrivateKeyHex;
  std::string hpkePublicKeyHex;
};

struct VerifiedPhoneParticipant {
  std::string phoneTokenHex;
  uint64_t expiresAt;
  uint64_t sequence;
};

struct PrivatePhoneBlindResult {
  std::string stateHandleHex;
  std::string requestHex;
};

struct PrivatePhoneContactResult {
  std::string policy;
  NetworkType network;
  std::string address;
  uint64_t issuedAt;
  uint64_t expiresAt;
  uint64_t sequence;
};

struct PrivatePhoneAskCreation {
  std::string requestIdHex;
  std::vector<unsigned char> requestState;
  std::vector<unsigned char> envelope;
};

struct PrivatePhoneAskEnvelopeHeader {
  unsigned char kind;
  std::string pairIdHex;
  std::string requestIdHex;
  std::string senderPhoneTokenHex;
  std::string recipientPhoneTokenHex;
  uint64_t issuedAt;
  uint64_t expiresAt;
  uint64_t sequence;
};

struct PrivatePhoneAskRequestDetails {
  NetworkType network;
  std::string pairIdHex;
  std::string requestIdHex;
  std::string requesterPhoneTokenHex;
  std::string targetPhoneTokenHex;
  uint64_t issuedAt;
  uint64_t expiresAt;
  uint64_t sequence;
};

struct PrivatePhoneAskResponseResult {
  bool approved;
  NetworkType network;
  std::string address;
  uint64_t issuedAt;
  uint64_t expiresAt;
  uint64_t sequence;
};

struct PrivatePhoneParticipantResult {
  std::string contactSigningPublicKeyHex;
  std::string hpkePublicKeyHex;
  uint64_t participantExpiresAt;
  uint64_t participantSequence;
  uint64_t snapshotGeneration;
  uint64_t snapshotIssuedAt;
  uint64_t snapshotExpiresAt;
};

struct MoneroPublicAddressParts {
  unsigned char addressKind;
  std::string publicSpendKeyHex;
  std::string publicViewKeyHex;
};

struct MfwNameRegistrationMaterial {
  std::string ownerPrivateKeyHex;
  std::string ownerPublicKeyHex;
  std::string commitSaltHex;
  std::vector<unsigned char> commitExtraNonce;
  std::string claimRecordHex;
};

struct MfwNamePreparedRecord {
  std::string ownerPublicKeyHex;
  std::string recordHex;
  std::vector<unsigned char> extraNonce;
};

inline std::string sealWatch(WalletEngine& engine,
                             const std::string& identityId,
                             const std::string& path,
                             const std::string& password,
                             NetworkType network,
                             uint64_t restoreHeight,
                             const std::string& workerDescriptorHex,
                             const std::string& assignmentHandleHex,
                             uint64_t assignmentEpoch,
                             uint64_t issuedAt,
                             uint64_t expiresAt,
                             uint64_t now) {
  auto payload = engine.fastReceiveRegistrationPayload(
      identityId, path, password, network, restoreHeight);
  SecretStringGuard privateViewKeyGuard(payload.privateViewKey);
  auto descriptor = decodeHex(workerDescriptorHex, 1, 4096);
  auto handle = decodeHex(assignmentHandleHex, 32, 32);
  auto privateViewKey = decodeHex(payload.privateViewKey, 32, 32);
  std::vector<unsigned char> output(
      TEX8_FAST_WALLET_PROTOCOL_WATCH_ENVELOPE_SIZE);
  const auto status = tex8_fast_wallet_protocol_seal_watch_v1(
      descriptor.data(), descriptor.size(), networkCode(network), handle.data(),
      assignmentEpoch, issuedAt, expiresAt, now,
      reinterpret_cast<const unsigned char*>(payload.identity.address.data()),
      payload.identity.address.size(), privateViewKey.data(), restoreHeight,
      output.data(), output.size());
  std::fill(privateViewKey.begin(), privateViewKey.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    std::fill(output.begin(), output.end(), 0);
    throw WalletEngineError("native Fast Wallet watch encryption failed");
  }
  const auto encoded = encodeHex(output.data(), output.size());
  std::fill(output.begin(), output.end(), 0);
  return encoded;
}

inline std::string sealAccountWatch(
    WalletEngine& engine,
    const std::string& walletId,
    const std::string& identityId,
    uint32_t accountIndex,
    uint64_t restoreHeight,
    NetworkType network,
    const std::string& workerDescriptorHex,
    const std::string& assignmentHandleHex,
    uint64_t assignmentEpoch,
    uint64_t issuedAt,
    uint64_t expiresAt,
    uint64_t now) {
  auto payload = engine.accountRegistrationPayload(
      walletId, identityId, accountIndex, restoreHeight);
  SecretStringGuard privateViewKeyGuard(payload.privateViewKey);
  if (payload.identity.network != network) {
    throw WalletEngineError("Ledger Fast Wallet network does not match");
  }
  auto descriptor = decodeHex(workerDescriptorHex, 1, 4096);
  auto handle = decodeHex(assignmentHandleHex, 32, 32);
  auto privateViewKey = decodeHex(payload.privateViewKey, 32, 32);
  std::vector<unsigned char> output(
      TEX8_FAST_WALLET_PROTOCOL_WATCH_ENVELOPE_SIZE);
  const auto status = tex8_fast_wallet_protocol_seal_watch_v1(
      descriptor.data(), descriptor.size(), networkCode(network), handle.data(),
      assignmentEpoch, issuedAt, expiresAt, now,
      reinterpret_cast<const unsigned char*>(payload.identity.address.data()),
      payload.identity.address.size(), privateViewKey.data(),
      payload.identity.restoreHeight, output.data(), output.size());
  std::fill(privateViewKey.begin(), privateViewKey.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    std::fill(output.begin(), output.end(), 0);
    throw WalletEngineError(
        "native Ledger Fast Wallet watch encryption failed");
  }
  const auto encoded = encodeHex(output.data(), output.size());
  std::fill(output.begin(), output.end(), 0);
  return encoded;
}

inline std::string verifiedRelayOrigin(const std::string& workerDescriptorHex,
                                       NetworkType network,
                                       uint64_t now) {
  auto descriptor = decodeHex(workerDescriptorHex, 1, 4096);
  std::vector<unsigned char> output(200);
  std::size_t outputLength = output.size();
  const auto status =
      tex8_fast_wallet_protocol_descriptor_relay_origin_v1(
          descriptor.data(), descriptor.size(), networkCode(network), now,
          output.data(), &outputLength);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK || outputLength == 0 ||
      outputLength > output.size()) {
    throw WalletEngineError("Fast Wallet Worker descriptor is invalid");
  }
  return std::string(reinterpret_cast<const char*>(output.data()),
                     outputLength);
}

inline std::string verifiedWorkerRootId(
    const std::string& workerDescriptorHex,
    NetworkType network,
    uint64_t now) {
  auto descriptor = decodeHex(workerDescriptorHex, 1, 4096);
  std::array<unsigned char, 32> output{};
  const auto status =
      tex8_fast_wallet_protocol_descriptor_worker_root_id_v1(
          descriptor.data(), descriptor.size(), networkCode(network), now,
          output.data(), output.size());
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    throw WalletEngineError("Fast Wallet Worker descriptor is invalid");
  }
  return encodeHex(output.data(), output.size());
}

inline uint32_t verifiedWorkerAdmission(
    const std::string& workerDescriptorHex,
    const std::string& admissionCertificateHex,
    const std::string& directoryPublicKeyHex,
    NetworkType network,
    uint64_t now) {
  auto descriptor = decodeHex(workerDescriptorHex, 1, 4096);
  auto certificate = decodeHex(admissionCertificateHex, 1, 4096);
  auto directoryPublicKey = decodeHex(directoryPublicKeyHex, 32, 32);
  uint32_t maximumAssignments = 0;
  const auto status = tex8_fast_wallet_protocol_verify_worker_admission_v1(
      descriptor.data(), descriptor.size(), networkCode(network), now,
      certificate.data(), certificate.size(), directoryPublicKey.data(),
      directoryPublicKey.size(), &maximumAssignments);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK || maximumAssignments == 0) {
    throw WalletEngineError(
        "Fast Wallet Community Worker admission is invalid");
  }
  return maximumAssignments;
}

inline std::string verifiedNameAddress(
    WalletEngine& engine,
    const std::string& recordPayloadHex,
    const std::string& expectedName,
    NetworkType network,
    const std::string& signingOwnerPublicKeyHex) {
  std::array<unsigned char, TEX8_MFW_MONERO_ADDRESS_SIZE> output{};
  int32_t status = TEX8_FAST_WALLET_PROTOCOL_INVALID_ARGUMENT;
  if (signingOwnerPublicKeyHex.empty()) {
    const auto record = decodeHex(recordPayloadHex, 89, 152);
    status = tex8_mfw_verify_and_encode_legacy_name_address_v1(
        record.data(), record.size(),
        reinterpret_cast<const unsigned char*>(expectedName.data()),
        expectedName.size(), networkCode(network), output.data(), output.size());
  } else {
    const auto record = decodeHex(recordPayloadHex, 189, 251);
    const auto ownerPublicKey =
        decodeHex(signingOwnerPublicKeyHex, 32, 32);
    status = tex8_mfw_verify_and_encode_name_address_v1(
        record.data(), record.size(),
        reinterpret_cast<const unsigned char*>(expectedName.data()),
        expectedName.size(), networkCode(network), ownerPublicKey.data(),
        ownerPublicKey.size(), output.data(), output.size());
  }
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    throw WalletEngineError("MFW name record is invalid");
  }
  const std::string address(reinterpret_cast<const char*>(output.data()),
                            output.size());
  // A second, independently implemented Monero Core check binds the encoded
  // address to the selected wallet network before React can use it.
  return engine.validateRecipientAddress(address, network);
}

inline MoneroPublicAddressParts verifiedMoneroPublicAddressParts(
    WalletEngine& engine,
    const std::string& address,
    NetworkType network) {
  const auto validated = engine.validateRecipientAddress(address, network);
  std::array<unsigned char, 32> publicSpendKey{};
  std::array<unsigned char, 32> publicViewKey{};
  unsigned char addressKind = 0xff;
  const auto status = tex8_mfw_decode_monero_address_v1(
      reinterpret_cast<const unsigned char*>(validated.data()),
      validated.size(), networkCode(network), &addressKind,
      publicSpendKey.data(), publicSpendKey.size(), publicViewKey.data(),
      publicViewKey.size());
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK || addressKind > 1) {
    throw WalletEngineError("private contact address is invalid");
  }
  return {
      addressKind,
      encodeHex(publicSpendKey.data(), publicSpendKey.size()),
      encodeHex(publicViewKey.data(), publicViewKey.size()),
  };
}

inline MfwNameRegistrationMaterial generateMfwNameRegistrationMaterial(
    WalletEngine& engine,
    const std::string& name,
    const std::string& address,
    NetworkType network) {
  const auto parts =
      verifiedMoneroPublicAddressParts(engine, address, network);
  auto spendKey = decodeHex(parts.publicSpendKeyHex, 32, 32);
  auto viewKey = decodeHex(parts.publicViewKeyHex, 32, 32);
  std::array<unsigned char, TEX8_MFW_NAME_OWNER_KEY_SIZE> ownerPrivateKey{};
  std::array<unsigned char, TEX8_MFW_NAME_OWNER_KEY_SIZE> ownerPublicKey{};
  std::array<unsigned char, TEX8_MFW_NAME_COMMIT_SALT_SIZE> commitSalt{};
  std::array<unsigned char, TEX8_MFW_NAME_EXTRA_MAX_SIZE> commitExtra{};
  std::size_t commitExtraLength = 0;
  std::array<unsigned char, TEX8_MFW_NAME_RECORD_MAX_SIZE> claimRecord{};
  std::size_t claimRecordLength = 0;
  std::array<unsigned char, TEX8_MFW_NAME_EXTRA_MAX_SIZE> claimExtra{};
  std::size_t claimExtraLength = 0;

  const auto status = tex8_mfw_generate_name_registration_v1(
      reinterpret_cast<const unsigned char*>(name.data()), name.size(),
      networkCode(network), parts.addressKind, spendKey.data(),
      spendKey.size(), viewKey.data(), viewKey.size(), ownerPrivateKey.data(),
      ownerPrivateKey.size(), ownerPublicKey.data(), ownerPublicKey.size(),
      commitSalt.data(), commitSalt.size(), commitExtra.data(),
      commitExtra.size(), &commitExtraLength, claimRecord.data(),
      claimRecord.size(), &claimRecordLength, claimExtra.data(),
      claimExtra.size(), &claimExtraLength);
  std::fill(spendKey.begin(), spendKey.end(), 0);
  std::fill(viewKey.begin(), viewKey.end(), 0);
  std::fill(claimExtra.begin(), claimExtra.end(), 0);
  std::vector<unsigned char> commitExtraNonce;
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK ||
      commitExtraLength == 0 || commitExtraLength > commitExtra.size() ||
      claimRecordLength == 0 || claimRecordLength > claimRecord.size() ||
      claimExtraLength == 0 || claimExtraLength > claimExtra.size() ||
      !extractCanonicalExtraNonceField(
          commitExtra.data(), commitExtraLength, commitExtraNonce)) {
    std::fill(ownerPrivateKey.begin(), ownerPrivateKey.end(), 0);
    std::fill(ownerPublicKey.begin(), ownerPublicKey.end(), 0);
    std::fill(commitSalt.begin(), commitSalt.end(), 0);
    std::fill(commitExtra.begin(), commitExtra.end(), 0);
    std::fill(claimRecord.begin(), claimRecord.end(), 0);
    throw WalletEngineError("MFW name registration material is invalid");
  }

  MfwNameRegistrationMaterial material{
      encodeHex(ownerPrivateKey.data(), ownerPrivateKey.size()),
      encodeHex(ownerPublicKey.data(), ownerPublicKey.size()),
      encodeHex(commitSalt.data(), commitSalt.size()),
      std::move(commitExtraNonce),
      encodeHex(claimRecord.data(), claimRecordLength),
  };
  std::fill(ownerPrivateKey.begin(), ownerPrivateKey.end(), 0);
  std::fill(ownerPublicKey.begin(), ownerPublicKey.end(), 0);
  std::fill(commitSalt.begin(), commitSalt.end(), 0);
  std::fill(commitExtra.begin(), commitExtra.end(), 0);
  std::fill(claimRecord.begin(), claimRecord.end(), 0);
  return material;
}

inline MfwNamePreparedRecord prepareMfwNameClaimRecord(
    WalletEngine& engine,
    const std::string& name,
    const std::string& address,
    NetworkType network,
    const std::string& ownerPrivateKeyHex,
    const std::string& commitSaltHex) {
  const auto parts =
      verifiedMoneroPublicAddressParts(engine, address, network);
  auto spendKey = decodeHex(parts.publicSpendKeyHex, 32, 32);
  auto viewKey = decodeHex(parts.publicViewKeyHex, 32, 32);
  auto ownerPrivateKey = decodeHex(ownerPrivateKeyHex, 32, 32);
  auto commitSalt = decodeHex(commitSaltHex, 16, 16);
  std::array<unsigned char, TEX8_MFW_NAME_OWNER_KEY_SIZE> ownerPublicKey{};
  std::array<unsigned char, TEX8_MFW_NAME_RECORD_MAX_SIZE> claimRecord{};
  std::size_t claimRecordLength = 0;
  std::array<unsigned char, TEX8_MFW_NAME_EXTRA_MAX_SIZE> claimExtra{};
  std::size_t claimExtraLength = 0;

  const auto status = tex8_mfw_prepare_name_claim_v1(
      reinterpret_cast<const unsigned char*>(name.data()), name.size(),
      networkCode(network), parts.addressKind, spendKey.data(),
      spendKey.size(), viewKey.data(), viewKey.size(), ownerPrivateKey.data(),
      ownerPrivateKey.size(), commitSalt.data(), commitSalt.size(),
      ownerPublicKey.data(), ownerPublicKey.size(), claimRecord.data(),
      claimRecord.size(), &claimRecordLength, claimExtra.data(),
      claimExtra.size(), &claimExtraLength);
  std::fill(spendKey.begin(), spendKey.end(), 0);
  std::fill(viewKey.begin(), viewKey.end(), 0);
  std::fill(ownerPrivateKey.begin(), ownerPrivateKey.end(), 0);
  std::fill(commitSalt.begin(), commitSalt.end(), 0);
  std::vector<unsigned char> claimExtraNonce;
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK ||
      claimRecordLength == 0 || claimRecordLength > claimRecord.size() ||
      claimExtraLength == 0 || claimExtraLength > claimExtra.size() ||
      !extractCanonicalExtraNonceField(
          claimExtra.data(), claimExtraLength, claimExtraNonce)) {
    std::fill(ownerPublicKey.begin(), ownerPublicKey.end(), 0);
    std::fill(claimRecord.begin(), claimRecord.end(), 0);
    std::fill(claimExtra.begin(), claimExtra.end(), 0);
    throw WalletEngineError("MFW name claim material is invalid");
  }
  MfwNamePreparedRecord result{
      encodeHex(ownerPublicKey.data(), ownerPublicKey.size()),
      encodeHex(claimRecord.data(), claimRecordLength),
      std::move(claimExtraNonce),
  };
  std::fill(ownerPublicKey.begin(), ownerPublicKey.end(), 0);
  std::fill(claimRecord.begin(), claimRecord.end(), 0);
  std::fill(claimExtra.begin(), claimExtra.end(), 0);
  return result;
}

inline MfwNamePreparedRecord prepareMfwNameTransitionRecord(
    WalletEngine& engine,
    unsigned char operation,
    const std::string& name,
    const std::string& address,
    NetworkType network,
    const std::string& ownerPrivateKeyHex,
    const std::string& predecessorRecordHex,
    const std::string& predecessorSigningOwnerPublicKeyHex) {
  const auto parts =
      verifiedMoneroPublicAddressParts(engine, address, network);
  auto spendKey = decodeHex(parts.publicSpendKeyHex, 32, 32);
  auto viewKey = decodeHex(parts.publicViewKeyHex, 32, 32);
  auto ownerPrivateKey = decodeHex(ownerPrivateKeyHex, 32, 32);
  auto predecessorRecord = decodeHex(predecessorRecordHex, 189, 251);
  auto predecessorSigner =
      decodeHex(predecessorSigningOwnerPublicKeyHex, 32, 32);
  std::array<unsigned char, TEX8_MFW_NAME_RECORD_MAX_SIZE> transitionRecord{};
  std::size_t transitionRecordLength = 0;
  std::array<unsigned char, TEX8_MFW_NAME_EXTRA_MAX_SIZE> transitionExtra{};
  std::size_t transitionExtraLength = 0;

  const auto status = tex8_mfw_prepare_name_transition_v1(
      operation, reinterpret_cast<const unsigned char*>(name.data()),
      name.size(), networkCode(network), parts.addressKind, spendKey.data(),
      spendKey.size(), viewKey.data(), viewKey.size(), ownerPrivateKey.data(),
      ownerPrivateKey.size(), predecessorRecord.data(),
      predecessorRecord.size(), predecessorSigner.data(),
      predecessorSigner.size(), transitionRecord.data(),
      transitionRecord.size(), &transitionRecordLength, transitionExtra.data(),
      transitionExtra.size(), &transitionExtraLength);
  std::fill(spendKey.begin(), spendKey.end(), 0);
  std::fill(viewKey.begin(), viewKey.end(), 0);
  std::fill(ownerPrivateKey.begin(), ownerPrivateKey.end(), 0);
  std::fill(predecessorRecord.begin(), predecessorRecord.end(), 0);
  std::fill(predecessorSigner.begin(), predecessorSigner.end(), 0);
  std::vector<unsigned char> transitionExtraNonce;
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK ||
      transitionRecordLength == 0 ||
      transitionRecordLength > transitionRecord.size() ||
      transitionExtraLength == 0 ||
      transitionExtraLength > transitionExtra.size() ||
      !extractCanonicalExtraNonceField(
          transitionExtra.data(), transitionExtraLength,
          transitionExtraNonce)) {
    std::fill(transitionRecord.begin(), transitionRecord.end(), 0);
    std::fill(transitionExtra.begin(), transitionExtra.end(), 0);
    throw WalletEngineError("MFW name transition material is invalid");
  }
  MfwNamePreparedRecord result{
      "",
      encodeHex(transitionRecord.data(), transitionRecordLength),
      std::move(transitionExtraNonce),
  };
  std::fill(transitionRecord.begin(), transitionRecord.end(), 0);
  std::fill(transitionExtra.begin(), transitionExtra.end(), 0);
  return result;
}

inline std::string exportMfwNameRecovery(
    const std::string& name,
    NetworkType network,
    const std::string& ownerPrivateKeyHex,
    std::string& passphrase) {
  SecretStringGuard passphraseGuard(passphrase);
  auto ownerPrivateKey = decodeHex(ownerPrivateKeyHex, 32, 32);
  std::array<unsigned char, TEX8_MFW_NAME_RECOVERY_MAX_SIZE> output{};
  std::size_t outputLength = 0;
  const auto status = tex8_mfw_export_name_recovery_v1(
      reinterpret_cast<const unsigned char*>(name.data()), name.size(),
      networkCode(network), ownerPrivateKey.data(), ownerPrivateKey.size(),
      reinterpret_cast<const unsigned char*>(passphrase.data()),
      passphrase.size(), output.data(), output.size(), &outputLength);
  std::fill(ownerPrivateKey.begin(), ownerPrivateKey.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK || outputLength < 131 ||
      outputLength > output.size()) {
    std::fill(output.begin(), output.end(), 0);
    throw WalletEngineError("MFW name recovery export failed");
  }
  const auto encoded = encodeHex(output.data(), outputLength);
  std::fill(output.begin(), output.end(), 0);
  return encoded;
}

struct MfwNameRecoveredOwner {
  std::string ownerPrivateKeyHex;
  std::string ownerPublicKeyHex;
};

inline MfwNameRecoveredOwner importMfwNameRecovery(
    const std::string& bundleHex,
    const std::string& expectedName,
    NetworkType expectedNetwork,
    std::string& passphrase) {
  SecretStringGuard passphraseGuard(passphrase);
  auto bundle = decodeHex(bundleHex, 131, TEX8_MFW_NAME_RECOVERY_MAX_SIZE);
  std::array<unsigned char, TEX8_MFW_NAME_OWNER_KEY_SIZE> ownerPrivateKey{};
  std::array<unsigned char, TEX8_MFW_NAME_OWNER_KEY_SIZE> ownerPublicKey{};
  const auto status = tex8_mfw_import_name_recovery_v1(
      bundle.data(), bundle.size(),
      reinterpret_cast<const unsigned char*>(expectedName.data()),
      expectedName.size(), networkCode(expectedNetwork),
      reinterpret_cast<const unsigned char*>(passphrase.data()),
      passphrase.size(), ownerPrivateKey.data(), ownerPrivateKey.size(),
      ownerPublicKey.data(), ownerPublicKey.size());
  std::fill(bundle.begin(), bundle.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    std::fill(ownerPrivateKey.begin(), ownerPrivateKey.end(), 0);
    std::fill(ownerPublicKey.begin(), ownerPublicKey.end(), 0);
    throw WalletEngineError("MFW name recovery import failed");
  }
  MfwNameRecoveredOwner result{
      encodeHex(ownerPrivateKey.data(), ownerPrivateKey.size()),
      encodeHex(ownerPublicKey.data(), ownerPublicKey.size()),
  };
  std::fill(ownerPrivateKey.begin(), ownerPrivateKey.end(), 0);
  std::fill(ownerPublicKey.begin(), ownerPublicKey.end(), 0);
  return result;
}

inline std::string normalizePrivatePhoneE164(const std::string& input) {
  std::array<unsigned char, 16> output{};
  std::size_t outputLength = output.size();
  const auto status = tex8_mfw_normalize_e164_v1(
      reinterpret_cast<const unsigned char*>(input.data()), input.size(),
      output.data(), &outputLength);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK || outputLength < 9 ||
      outputLength > output.size()) {
    throw WalletEngineError("phone number is not a valid international number");
  }
  return std::string(reinterpret_cast<const char*>(output.data()),
                     outputLength);
}

inline PrivatePhoneBlindResult blindPrivatePhone(
    const std::string& normalizedE164,
    uint64_t epoch) {
  std::array<unsigned char, TEX8_MFW_PHONE_SESSION_HANDLE_SIZE> handle{};
  std::array<unsigned char, TEX8_MFW_VOPRF_REQUEST_SIZE> request{};
  const auto status = tex8_mfw_voprf_blind_session_v1(
      reinterpret_cast<const unsigned char*>(normalizedE164.data()),
      normalizedE164.size(), epoch, handle.data(), handle.size(),
      request.data(), request.size());
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    throw WalletEngineError("private phone lookup could not be started");
  }
  return {
      encodeHex(handle.data(), handle.size()),
      encodeHex(request.data(), request.size()),
  };
}

inline std::string finalizePrivatePhone(
    const std::string& stateHandleHex,
    const std::string& evaluationHex,
    const std::string& expectedServerPublicKeyHex) {
  auto handle = decodeHex(stateHandleHex, 32, 32);
  auto evaluation = decodeHex(evaluationHex, 136, 136);
  auto publicKey = decodeHex(expectedServerPublicKeyHex, 32, 32);
  std::array<unsigned char, 64> output{};
  const auto status = tex8_mfw_voprf_finalize_session_v1(
      handle.data(), handle.size(), evaluation.data(), evaluation.size(),
      publicKey.data(), publicKey.size(), output.data(), output.size());
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    throw WalletEngineError("private phone proof could not be verified");
  }
  return encodeHex(output.data(), output.size());
}

inline void discardPrivatePhoneSession(const std::string& stateHandleHex) {
  auto handle = decodeHex(stateHandleHex, 32, 32);
  const auto status =
      tex8_mfw_voprf_discard_session_v1(handle.data(), handle.size());
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK &&
      status != TEX8_FAST_WALLET_PROTOCOL_PRIVATE_DIRECTORY_FAILED) {
    throw WalletEngineError("private phone lookup session is invalid");
  }
}

inline std::string combinePrivatePhoneToken(
    const std::string& firstServerPublicKeyHex,
    const std::string& firstOutputHex,
    const std::string& secondServerPublicKeyHex,
    const std::string& secondOutputHex) {
  auto firstKey = decodeHex(firstServerPublicKeyHex, 32, 32);
  auto firstOutput = decodeHex(firstOutputHex, 64, 64);
  auto secondKey = decodeHex(secondServerPublicKeyHex, 32, 32);
  auto secondOutput = decodeHex(secondOutputHex, 64, 64);
  std::array<unsigned char, TEX8_MFW_PHONE_TOKEN_SIZE> output{};
  const auto status = tex8_mfw_combine_phone_token_v1(
      firstKey.data(), firstOutput.data(), secondKey.data(),
      secondOutput.data(), output.data(), output.size());
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    throw WalletEngineError("private phone token could not be verified");
  }
  return encodeHex(output.data(), output.size());
}

inline std::string derivePrivatePhonePairId(
    const std::string& firstPhoneTokenHex,
    const std::string& secondPhoneTokenHex) {
  auto first = decodeHex(firstPhoneTokenHex, 32, 32);
  auto second = decodeHex(secondPhoneTokenHex, 32, 32);
  std::array<unsigned char, 32> output{};
  const auto status = tex8_mfw_derive_pair_id_v1(
      first.data(), second.data(), output.data(), output.size());
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    throw WalletEngineError("private phone pair is invalid");
  }
  return encodeHex(output.data(), output.size());
}

inline PrivatePhoneIdentity generatePrivatePhoneIdentity() {
  std::array<unsigned char, TEX8_MFW_PHONE_IDENTITY_KEY_SIZE> privateKey{};
  std::array<unsigned char, TEX8_MFW_PHONE_IDENTITY_KEY_SIZE> publicKey{};
  const auto status = tex8_mfw_generate_phone_identity_v1(
      privateKey.data(), privateKey.size(), publicKey.data(), publicKey.size());
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    throw WalletEngineError("private contact identity could not be created");
  }
  PrivatePhoneIdentity result{
      encodeHex(privateKey.data(), privateKey.size()),
      encodeHex(publicKey.data(), publicKey.size()),
  };
  std::fill(privateKey.begin(), privateKey.end(), 0);
  return result;
}

inline PrivatePhoneRegistrationIdentity
generatePrivatePhoneRegistrationIdentity() {
  std::array<unsigned char, 32> contactPrivate{};
  std::array<unsigned char, 32> contactPublic{};
  std::array<unsigned char, 32> hpkePrivate{};
  std::array<unsigned char, 32> hpkePublic{};
  const auto status = tex8_mfw_generate_phone_registration_identity_v1(
      contactPrivate.data(), contactPrivate.size(), contactPublic.data(),
      contactPublic.size(), hpkePrivate.data(), hpkePrivate.size(),
      hpkePublic.data(), hpkePublic.size());
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    throw WalletEngineError("private contact registration identity could not be created");
  }
  PrivatePhoneRegistrationIdentity result{
      encodeHex(contactPrivate.data(), contactPrivate.size()),
      encodeHex(contactPublic.data(), contactPublic.size()),
      encodeHex(hpkePrivate.data(), hpkePrivate.size()),
      encodeHex(hpkePublic.data(), hpkePublic.size()),
  };
  std::fill(contactPrivate.begin(), contactPrivate.end(), 0);
  std::fill(hpkePrivate.begin(), hpkePrivate.end(), 0);
  return result;
}

inline VerifiedPhoneParticipant verifyPrivatePhoneParticipant(
    const std::string& participantHex,
    const std::string& expectedVerificationPublicKeyHex,
    uint64_t expectedEpoch,
    const std::string& expectedContactPublicKeyHex,
    const std::string& expectedHpkePublicKeyHex,
    uint64_t now) {
  auto participant = decodeHex(
      participantHex, TEX8_MFW_PHONE_PARTICIPANT_SIZE,
      TEX8_MFW_PHONE_PARTICIPANT_SIZE);
  auto verificationKey =
      decodeHex(expectedVerificationPublicKeyHex, 32, 32);
  auto contactKey = decodeHex(expectedContactPublicKeyHex, 32, 32);
  auto hpkeKey = decodeHex(expectedHpkePublicKeyHex, 32, 32);
  std::array<unsigned char, TEX8_MFW_PHONE_TOKEN_SIZE> phoneToken{};
  uint64_t expiresAt = 0;
  uint64_t sequence = 0;
  const auto status = tex8_mfw_verify_phone_participant_v1(
      participant.data(), participant.size(), verificationKey.data(),
      verificationKey.size(), expectedEpoch, contactKey.data(),
      contactKey.size(), hpkeKey.data(), hpkeKey.size(), now,
      phoneToken.data(), phoneToken.size(), &expiresAt, &sequence);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    throw WalletEngineError("private phone verification grant is invalid");
  }
  return VerifiedPhoneParticipant{
      encodeHex(phoneToken.data(), phoneToken.size()),
      expiresAt,
      sequence,
  };
}

inline std::vector<unsigned char> signPrivatePhonePermitRefresh(
    uint64_t epoch,
    const std::string& phoneTokenHex,
    uint64_t participantSequence,
    uint64_t issuedAt,
    uint64_t expiresAt,
    const std::string& contactPrivateKeyHex) {
  auto phoneToken = decodeHex(phoneTokenHex, 32, 32);
  auto contactPrivate = decodeHex(contactPrivateKeyHex, 32, 32);
  std::vector<unsigned char> output(
      TEX8_MFW_PHONE_PERMIT_REFRESH_REQUEST_SIZE);
  const auto status = tex8_mfw_sign_phone_permit_refresh_v1(
      epoch, phoneToken.data(), participantSequence, issuedAt, expiresAt,
      contactPrivate.data(), output.data(), output.size());
  std::fill(contactPrivate.begin(), contactPrivate.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    std::fill(output.begin(), output.end(), 0);
    throw WalletEngineError(
        "private phone evaluation permits could not be renewed");
  }
  return output;
}

inline std::vector<unsigned char> sealPrivatePhoneContact(
    const std::string& publisherPhoneTokenHex,
    const std::string& recipientPhoneTokenHex,
    unsigned char policy,
    NetworkType network,
    uint64_t issuedAt,
    uint64_t expiresAt,
    uint64_t sequence,
    unsigned char addressKind,
    const std::string& publicSpendKeyHex,
    const std::string& publicViewKeyHex,
    const std::string& contactPrivateKeyHex,
    const std::string& recipientHpkePublicKeyHex) {
  auto publisher = decodeHex(publisherPhoneTokenHex, 32, 32);
  auto recipient = decodeHex(recipientPhoneTokenHex, 32, 32);
  auto contactPrivate = decodeHex(contactPrivateKeyHex, 32, 32);
  auto recipientHpke = decodeHex(recipientHpkePublicKeyHex, 32, 32);
  const bool hasAddress = !publicSpendKeyHex.empty() || !publicViewKeyHex.empty();
  auto spend = hasAddress ? decodeHex(publicSpendKeyHex, 32, 32)
                          : std::vector<unsigned char>{};
  auto view = hasAddress ? decodeHex(publicViewKeyHex, 32, 32)
                         : std::vector<unsigned char>{};
  std::vector<unsigned char> output(TEX8_MFW_CONTACT_ENVELOPE_SIZE);
  const auto status = tex8_mfw_seal_phone_contact_v1(
      publisher.data(), recipient.data(), policy, networkCode(network),
      issuedAt, expiresAt, sequence, hasAddress ? 1 : 0, addressKind,
      hasAddress ? spend.data() : nullptr, spend.size(),
      hasAddress ? view.data() : nullptr, view.size(), contactPrivate.data(),
      recipientHpke.data(), output.data(), output.size());
  std::fill(contactPrivate.begin(), contactPrivate.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    std::fill(output.begin(), output.end(), 0);
    throw WalletEngineError("private contact card could not be protected");
  }
  return output;
}

inline PrivatePhoneAskCreation sealPrivatePhoneAskRequest(
    const std::string& requesterPhoneTokenHex,
    const std::string& targetPhoneTokenHex,
    NetworkType network,
    uint64_t issuedAt,
    uint64_t expiresAt,
    uint64_t sequence,
    const std::string& contactPrivateKeyHex,
    const std::string& targetHpkePublicKeyHex) {
  auto requester = decodeHex(requesterPhoneTokenHex, 32, 32);
  auto target = decodeHex(targetPhoneTokenHex, 32, 32);
  auto contactPrivate = decodeHex(contactPrivateKeyHex, 32, 32);
  auto targetHpke = decodeHex(targetHpkePublicKeyHex, 32, 32);
  std::array<unsigned char, 32> requestId{};
  std::vector<unsigned char> requestState(TEX8_MFW_ASK_MESSAGE_SIZE);
  std::vector<unsigned char> envelope(TEX8_MFW_ASK_ENVELOPE_SIZE);
  const auto status = tex8_mfw_seal_phone_ask_request_v1(
      requester.data(), target.data(), networkCode(network), issuedAt,
      expiresAt, sequence, contactPrivate.data(), targetHpke.data(),
      requestId.data(), requestId.size(), requestState.data(),
      requestState.size(), envelope.data(), envelope.size());
  std::fill(contactPrivate.begin(), contactPrivate.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    std::fill(requestState.begin(), requestState.end(), 0);
    std::fill(envelope.begin(), envelope.end(), 0);
    throw WalletEngineError("private address request could not be protected");
  }
  return {
      encodeHex(requestId.data(), requestId.size()),
      std::move(requestState),
      std::move(envelope),
  };
}

inline uint64_t decodePrivatePhoneU64(const unsigned char* bytes) {
  uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) {
    value = (value << 8) | bytes[index];
  }
  return value;
}

inline PrivatePhoneAskEnvelopeHeader inspectPrivatePhoneAskEnvelope(
    const unsigned char* envelope,
    std::size_t envelopeLength) {
  static constexpr unsigned char magic[] = {
      'M', 'F', 'W', 'A', 'S', 'K', 'E', '1'};
  if (envelope == nullptr || envelopeLength != TEX8_MFW_ASK_ENVELOPE_SIZE ||
      !std::equal(std::begin(magic), std::end(magic), envelope) ||
      envelope[8] != 1 || (envelope[9] != 1 && envelope[9] != 2) ||
      !std::all_of(envelope + 210, envelope + 224,
                   [](unsigned char value) { return value == 0; })) {
    throw WalletEngineError("private address message is invalid");
  }
  return {
      envelope[9],
      encodeHex(envelope + 10, 32),
      encodeHex(envelope + 42, 32),
      encodeHex(envelope + 74, 32),
      encodeHex(envelope + 106, 32),
      decodePrivatePhoneU64(envelope + 186),
      decodePrivatePhoneU64(envelope + 194),
      decodePrivatePhoneU64(envelope + 202),
  };
}

inline PrivatePhoneAskRequestDetails inspectPrivatePhoneAskRequest(
    const unsigned char* request,
    std::size_t requestLength) {
  static constexpr unsigned char magic[] = {
      'M', 'F', 'W', 'A', 'S', 'K', 'R', '1'};
  if (request == nullptr || requestLength != TEX8_MFW_ASK_MESSAGE_SIZE ||
      !std::equal(std::begin(magic), std::end(magic), request) ||
      request[8] != 1 ||
      !std::all_of(request + 10, request + 16,
                   [](unsigned char value) { return value == 0; }) ||
      !std::all_of(request + 168, request + requestLength,
                   [](unsigned char value) { return value == 0; })) {
    throw WalletEngineError("private address request state is invalid");
  }
  NetworkType network;
  switch (request[9]) {
    case 0:
      network = NetworkType::Mainnet;
      break;
    case 1:
      network = NetworkType::Testnet;
      break;
    case 2:
      network = NetworkType::Stagenet;
      break;
    default:
      throw WalletEngineError("private address request network is invalid");
  }
  const uint64_t issuedAt = decodePrivatePhoneU64(request + 144);
  const uint64_t expiresAt = decodePrivatePhoneU64(request + 152);
  const uint64_t sequence = decodePrivatePhoneU64(request + 160);
  if (issuedAt > 9007199254740991ULL ||
      expiresAt > 9007199254740991ULL ||
      sequence > 9007199254740991ULL) {
    throw WalletEngineError("private address request state is invalid");
  }
  return {
      network,
      encodeHex(request + 16, 32),
      encodeHex(request + 48, 32),
      encodeHex(request + 80, 32),
      encodeHex(request + 112, 32),
      issuedAt,
      expiresAt,
      sequence,
  };
}

inline std::vector<unsigned char> openPrivatePhoneAskRequest(
    const unsigned char* envelope,
    std::size_t envelopeLength,
    const std::string& expectedRequesterPublicKeyHex,
    const std::string& targetHpkePrivateKeyHex,
    const std::string& targetHpkePublicKeyHex,
    uint64_t now) {
  auto requesterPublic = decodeHex(expectedRequesterPublicKeyHex, 32, 32);
  auto targetPrivate = decodeHex(targetHpkePrivateKeyHex, 32, 32);
  auto targetPublic = decodeHex(targetHpkePublicKeyHex, 32, 32);
  std::vector<unsigned char> request(TEX8_MFW_ASK_MESSAGE_SIZE);
  const auto status = tex8_mfw_open_phone_ask_request_v1(
      envelope, envelopeLength, requesterPublic.data(), targetPrivate.data(),
      targetPublic.data(), now, request.data(), request.size());
  std::fill(targetPrivate.begin(), targetPrivate.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    std::fill(request.begin(), request.end(), 0);
    throw WalletEngineError("private address request could not be verified");
  }
  return request;
}

inline std::vector<unsigned char> sealPrivatePhoneAskResponse(
    const unsigned char* request,
    std::size_t requestLength,
    bool approved,
    uint64_t issuedAt,
    uint64_t expiresAt,
    uint64_t sequence,
    unsigned char addressKind,
    const std::string& publicSpendKeyHex,
    const std::string& publicViewKeyHex,
    const std::string& responderContactPrivateKeyHex,
    const std::string& requesterHpkePublicKeyHex) {
  auto contactPrivate = decodeHex(responderContactPrivateKeyHex, 32, 32);
  auto requesterHpke = decodeHex(requesterHpkePublicKeyHex, 32, 32);
  const bool hasAddress = !publicSpendKeyHex.empty() || !publicViewKeyHex.empty();
  auto spend = hasAddress ? decodeHex(publicSpendKeyHex, 32, 32)
                          : std::vector<unsigned char>{};
  auto view = hasAddress ? decodeHex(publicViewKeyHex, 32, 32)
                         : std::vector<unsigned char>{};
  std::vector<unsigned char> envelope(TEX8_MFW_ASK_ENVELOPE_SIZE);
  const auto status = tex8_mfw_seal_phone_ask_response_v1(
      request, requestLength, approved ? 2 : 1, issuedAt, expiresAt, sequence,
      hasAddress ? 1 : 0, addressKind, hasAddress ? spend.data() : nullptr,
      spend.size(), hasAddress ? view.data() : nullptr, view.size(),
      contactPrivate.data(), requesterHpke.data(), envelope.data(),
      envelope.size());
  std::fill(contactPrivate.begin(), contactPrivate.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    std::fill(envelope.begin(), envelope.end(), 0);
    throw WalletEngineError("private address response could not be protected");
  }
  return envelope;
}

inline PrivatePhoneAskResponseResult openPrivatePhoneAskResponse(
    WalletEngine& engine,
    const unsigned char* envelope,
    std::size_t envelopeLength,
    const std::string& expectedResponderPublicKeyHex,
    const std::string& requesterHpkePrivateKeyHex,
    const std::string& requesterHpkePublicKeyHex,
    uint64_t now,
    const unsigned char* expectedRequest,
    std::size_t expectedRequestLength,
    NetworkType expectedNetwork) {
  auto responderPublic = decodeHex(expectedResponderPublicKeyHex, 32, 32);
  auto requesterPrivate = decodeHex(requesterHpkePrivateKeyHex, 32, 32);
  auto requesterPublic = decodeHex(requesterHpkePublicKeyHex, 32, 32);
  unsigned char decision = 0;
  unsigned char network = 0xff;
  std::array<unsigned char, TEX8_MFW_MONERO_ADDRESS_SIZE> address{};
  std::size_t addressLength = address.size();
  uint64_t issuedAt = 0;
  uint64_t expiresAt = 0;
  uint64_t sequence = 0;
  const auto status = tex8_mfw_open_phone_ask_response_v1(
      envelope, envelopeLength, responderPublic.data(), requesterPrivate.data(),
      requesterPublic.data(), now, expectedRequest, expectedRequestLength,
      &decision, &network, address.data(), &addressLength, &issuedAt,
      &expiresAt, &sequence);
  std::fill(requesterPrivate.begin(), requesterPrivate.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK ||
      network != networkCode(expectedNetwork) || (decision != 1 && decision != 2) ||
      issuedAt > 9007199254740991ULL || expiresAt > 9007199254740991ULL ||
      sequence > 9007199254740991ULL ||
      (decision == 1 && addressLength != 0) ||
      (decision == 2 && addressLength != address.size())) {
    throw WalletEngineError("private address response is invalid");
  }
  std::string validatedAddress;
  if (decision == 2) {
    validatedAddress = engine.validateRecipientAddress(
        std::string(reinterpret_cast<const char*>(address.data()),
                    addressLength),
        expectedNetwork);
  }
  return {
      decision == 2,
      expectedNetwork,
      validatedAddress,
      issuedAt,
      expiresAt,
      sequence,
  };
}

inline std::vector<unsigned char> signPrivatePhoneAskMailboxPoll(
    unsigned char kind,
    const std::string& participantPhoneTokenHex,
    uint64_t participantSequence,
    const std::string& participantHpkePublicKeyHex,
    uint64_t afterCursor,
    uint64_t issuedAt,
    uint64_t expiresAt,
    const std::string& participantContactPrivateKeyHex) {
  auto phoneToken = decodeHex(participantPhoneTokenHex, 32, 32);
  auto hpkePublic = decodeHex(participantHpkePublicKeyHex, 32, 32);
  auto contactPrivate = decodeHex(participantContactPrivateKeyHex, 32, 32);
  std::vector<unsigned char> poll(TEX8_MFW_ASK_MAILBOX_POLL_SIZE);
  const auto status = tex8_mfw_sign_phone_ask_mailbox_poll_v1(
      kind, phoneToken.data(), participantSequence, hpkePublic.data(),
      afterCursor, issuedAt, expiresAt, contactPrivate.data(), poll.data(),
      poll.size());
  std::fill(contactPrivate.begin(), contactPrivate.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    std::fill(poll.begin(), poll.end(), 0);
    throw WalletEngineError("private address inbox could not be authenticated");
  }
  return poll;
}

inline std::vector<unsigned char> revokePrivatePhoneContact(
    const std::string& publisherPhoneTokenHex,
    const std::string& recipientPhoneTokenHex,
    uint64_t issuedAt,
    uint64_t expiresAt,
    uint64_t sequence,
    const std::string& contactPrivateKeyHex) {
  auto publisher = decodeHex(publisherPhoneTokenHex, 32, 32);
  auto recipient = decodeHex(recipientPhoneTokenHex, 32, 32);
  auto contactPrivate = decodeHex(contactPrivateKeyHex, 32, 32);
  std::vector<unsigned char> output(TEX8_MFW_CONTACT_REVOCATION_SIZE);
  const auto status = tex8_mfw_revoke_phone_contact_v1(
      publisher.data(), recipient.data(), issuedAt, expiresAt, sequence,
      contactPrivate.data(), output.data(), output.size());
  std::fill(contactPrivate.begin(), contactPrivate.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    std::fill(output.begin(), output.end(), 0);
    throw WalletEngineError("private contact revocation could not be signed");
  }
  return output;
}

inline std::vector<unsigned char> revokePrivatePhoneParticipant(
    const std::string& phoneTokenHex,
    uint64_t issuedAt,
    uint64_t expiresAt,
    uint64_t cooldownUntil,
    uint64_t sequence,
    const std::string& contactPrivateKeyHex) {
  auto phoneToken = decodeHex(phoneTokenHex, 32, 32);
  auto contactPrivate = decodeHex(contactPrivateKeyHex, 32, 32);
  std::vector<unsigned char> output(TEX8_MFW_PARTICIPANT_REVOCATION_SIZE);
  const auto status = tex8_mfw_revoke_phone_participant_v1(
      phoneToken.data(), issuedAt, expiresAt, cooldownUntil, sequence,
      contactPrivate.data(), output.data(), output.size());
  std::fill(contactPrivate.begin(), contactPrivate.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK) {
    std::fill(output.begin(), output.end(), 0);
    throw WalletEngineError("private participant revocation could not be signed");
  }
  return output;
}

inline PrivatePhoneParticipantResult findPrivatePhoneSnapshotParticipant(
    const unsigned char* snapshotBytes,
    std::size_t snapshotLength,
    const std::string& expectedDirectoryPublicKeyHex,
    const std::string& expectedVerificationPublicKeyHex,
    uint64_t now,
    const std::string& phoneTokenHex) {
  if (snapshotBytes == nullptr || snapshotLength < 137 ||
      snapshotLength > 256 * 1024 * 1024) {
    throw WalletEngineError("private contact snapshot has an invalid length");
  }
  auto directoryKey = decodeHex(expectedDirectoryPublicKeyHex, 32, 32);
  auto verificationKey =
      decodeHex(expectedVerificationPublicKeyHex, 32, 32);
  auto phoneToken = decodeHex(phoneTokenHex, 32, 32);
  std::array<unsigned char, 32> contactPublicKey{};
  std::array<unsigned char, 32> hpkePublicKey{};
  uint64_t participantExpiresAt = 0;
  uint64_t participantSequence = 0;
  uint64_t snapshotGeneration = 0;
  uint64_t snapshotIssuedAt = 0;
  uint64_t snapshotExpiresAt = 0;
  const auto status = tex8_mfw_find_snapshot_participant_v1(
      snapshotBytes, snapshotLength, directoryKey.data(),
      verificationKey.data(), now, phoneToken.data(), contactPublicKey.data(),
      contactPublicKey.size(), hpkePublicKey.data(), hpkePublicKey.size(),
      &participantExpiresAt, &participantSequence, &snapshotGeneration,
      &snapshotIssuedAt, &snapshotExpiresAt);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK ||
      participantExpiresAt > 9007199254740991ULL ||
      participantSequence > 9007199254740991ULL ||
      snapshotGeneration > 9007199254740991ULL ||
      snapshotIssuedAt > 9007199254740991ULL ||
      snapshotExpiresAt > 9007199254740991ULL) {
    throw WalletEngineError("private contact participant is invalid");
  }
  return {
      encodeHex(contactPublicKey.data(), contactPublicKey.size()),
      encodeHex(hpkePublicKey.data(), hpkePublicKey.size()),
      participantExpiresAt,
      participantSequence,
      snapshotGeneration,
      snapshotIssuedAt,
      snapshotExpiresAt,
  };
}

inline PrivatePhoneContactResult openPrivatePhoneSnapshotContactBytes(
    WalletEngine& engine,
    const unsigned char* snapshotBytes,
    std::size_t snapshotLength,
    const std::string& expectedDirectoryPublicKeyHex,
    const std::string& expectedVerificationPublicKeyHex,
    uint64_t now,
    const std::string& pairIdHex,
    const std::string& publisherPhoneTokenHex,
    const std::string& recipientPrivateKeyHex,
    const std::string& recipientPublicKeyHex,
    NetworkType expectedNetwork) {
  if (snapshotBytes == nullptr || snapshotLength < 137 ||
      snapshotLength > 256 * 1024 * 1024) {
    throw WalletEngineError("private contact snapshot has an invalid length");
  }
  auto directoryKey = decodeHex(expectedDirectoryPublicKeyHex, 32, 32);
  auto verificationKey = decodeHex(expectedVerificationPublicKeyHex, 32, 32);
  auto pairId = decodeHex(pairIdHex, 32, 32);
  auto publisherToken = decodeHex(publisherPhoneTokenHex, 32, 32);
  auto privateKey = decodeHex(recipientPrivateKeyHex, 32, 32);
  auto publicKey = decodeHex(recipientPublicKeyHex, 32, 32);
  unsigned char policy = 0;
  unsigned char network = 0xff;
  std::array<unsigned char, TEX8_MFW_MONERO_ADDRESS_SIZE> address{};
  std::size_t addressLength = address.size();
  uint64_t issuedAt = 0;
  uint64_t expiresAt = 0;
  uint64_t sequence = 0;
  const auto status = tex8_mfw_open_snapshot_contact_metadata_v1(
      snapshotBytes, snapshotLength, directoryKey.data(),
      verificationKey.data(), now, pairId.data(), publisherToken.data(),
      privateKey.data(), publicKey.data(), &policy, &network, address.data(),
      &addressLength, &issuedAt, &expiresAt, &sequence);
  std::fill(privateKey.begin(), privateKey.end(), 0);
  if (status != TEX8_FAST_WALLET_PROTOCOL_OK ||
      network != networkCode(expectedNetwork) ||
      addressLength > address.size() ||
      issuedAt > 9007199254740991ULL ||
      expiresAt > 9007199254740991ULL ||
      sequence > 9007199254740991ULL) {
    throw WalletEngineError("private contact record is invalid");
  }
  std::string policyName;
  switch (policy) {
    case 1:
      policyName = "badge";
      break;
    case 2:
      policyName = "ask";
      break;
    case 3:
      policyName = "direct";
      break;
    default:
      throw WalletEngineError("private contact policy is invalid");
  }
  std::string validatedAddress;
  if (addressLength > 0) {
    if (policy != 3 || addressLength != address.size()) {
      throw WalletEngineError("private contact address is invalid");
    }
    validatedAddress = engine.validateRecipientAddress(
        std::string(reinterpret_cast<const char*>(address.data()),
                    addressLength),
        expectedNetwork);
  } else if (policy == 3) {
    throw WalletEngineError("private contact address is missing");
  }
  return {
      policyName,
      expectedNetwork,
      validatedAddress,
      issuedAt,
      expiresAt,
      sequence,
  };
}

inline PrivatePhoneContactResult openPrivatePhoneSnapshotContact(
    WalletEngine& engine,
    const std::string& snapshotHex,
    const std::string& expectedDirectoryPublicKeyHex,
    const std::string& expectedVerificationPublicKeyHex,
    uint64_t now,
    const std::string& pairIdHex,
    const std::string& publisherPhoneTokenHex,
    const std::string& recipientPrivateKeyHex,
    const std::string& recipientPublicKeyHex,
    NetworkType expectedNetwork) {
  auto snapshot = decodeHex(snapshotHex, 137, 256 * 1024 * 1024);
  return openPrivatePhoneSnapshotContactBytes(
      engine, snapshot.data(), snapshot.size(),
      expectedDirectoryPublicKeyHex, expectedVerificationPublicKeyHex, now,
      pairIdHex, publisherPhoneTokenHex, recipientPrivateKeyHex,
      recipientPublicKeyHex, expectedNetwork);
}

}  // namespace fast_wallet_protocol_bridge

}  // namespace tex8::wallet
