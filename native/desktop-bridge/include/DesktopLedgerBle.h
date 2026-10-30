#pragma once

#include <string>

namespace tex8::desktop {

// Presence only; the wallet core still verifies the device's public identity.
bool ledgerUsbAvailable();

// Installs the macOS CoreBluetooth callbacks into the native Monero Ledger
// device. This is deliberately idempotent so every wallet open/reconnect can
// establish the required transport contract without depending on a prior UI
// discovery call.
void installLedgerBleTransportCallbacks();

// Scans for a nearby Ledger Nano X/Flex/Stax on macOS, selects it for the
// native Monero core, and returns a sanitized transport-status JSON object.
// APDUs and Bluetooth identifiers never cross into the Tauri renderer.
std::string ledgerBleTransportStatus();

// Performs one bounded BLE connection attempt after discovery and returns a
// sanitized status. It neither exchanges an APDU nor opens a wallet.
std::string ledgerBleConnectionPreflight();

// Returns the current, sanitized connection state after a transport attempt.
// It contains no peripheral identifier, name, APDU, address, or wallet data.
std::string ledgerBleConnectionStatus();

}  // namespace tex8::desktop
