import Foundation

private func appendLittleEndian<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    var littleEndian = value.littleEndian
    withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
}

private func encodeGoldenEvent() -> Data {
    var output = Data("MFW1".utf8)
    appendLittleEndian(UInt16(MfwProductCoreContract.eventSchemaVersion), to: &output)
    appendLittleEndian(UInt16(MfwProductCoreContract.abiVersion), to: &output)
    appendLittleEndian(UInt64(42), to: &output)
    appendLittleEndian(UInt64(1_234_567_890_123), to: &output)
    appendLittleEndian(UInt64(987_654_321), to: &output)
    output.append(contentsOf: [1, 1, 2, 0])
    appendLittleEndian(UInt16(7), to: &output)
    appendLittleEndian(UInt16(16), to: &output)
    appendLittleEndian(UInt16(0), to: &output)
    appendLittleEndian(UInt16(1), to: &output)
    for id in UInt8(1)...UInt8(5) { output.append(Data(repeating: id, count: 16)) }
    appendLittleEndian(UInt16(8), to: &output)
    appendLittleEndian(UInt16(0), to: &output)
    appendLittleEndian(Int64(2_048), to: &output)
    precondition(output.count == 136)
    return output
}

let encoded = encodeGoldenEvent().map { String(format: "%02x", $0) }.joined()
precondition(encoded == MfwProductCoreContract.goldenEventV1Hex, "Swift ABI vector mismatch")
precondition(MfwWalletLifecycleContract.stateVersion == 1)
precondition(MfwWalletLifecycleContract.schemaSha256.count == 64)
precondition(MfwWalletLifecycleContract.wallet_preference_privacy_convenience == 2)
precondition(MfwWalletLifecycleContract.fast_wallet_override_default == 0)
precondition(MfwWalletLifecycleContract.send_event_submit == 5)
precondition(MfwWalletLifecycleContract.send_state_submitted == 5)
print("swift abi=\(MfwProductCoreContract.abiVersion) encoded_bytes=136 wallet_schema=\(MfwWalletLifecycleContract.schemaSha256)")
