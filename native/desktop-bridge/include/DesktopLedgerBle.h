#pragma once

#include <string>

namespace tex8::desktop {

// Scans for a nearby Ledger Nano X/Flex/Stax on macOS, selects it for the
// native Monero core, and returns a sanitized transport-status JSON object.
// APDUs and Bluetooth identifiers never cross into the Tauri renderer.
std::string ledgerBleTransportStatus();

}  // namespace tex8::desktop
