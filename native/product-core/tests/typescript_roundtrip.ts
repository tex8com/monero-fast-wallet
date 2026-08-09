import {
  MFW_PRODUCT_CORE_ABI_VERSION,
  MFW_PRODUCT_CORE_EVENT_SCHEMA_VERSION,
  MFW_PRODUCT_CORE_GOLDEN_EVENT_V1_HEX,
} from '../generated/typescript/mfwProductCoreContract';
import {
  MFW_FAST_WALLET_OVERRIDE_DEFAULT,
  MFW_SEND_EVENT_SUBMIT,
  MFW_SEND_STATE_SUBMITTED,
  MFW_WALLET_LIFECYCLE_SCHEMA_SHA256,
  MFW_WALLET_LIFECYCLE_STATE_VERSION,
  MFW_WALLET_PREFERENCE_PRIVACY_CONVENIENCE,
} from '../generated/typescript/mfwWalletLifecycleContract';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function encodeGoldenEvent(): Uint8Array {
  const output = new Uint8Array(136);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const value of [0x4d, 0x46, 0x57, 0x31]) output[offset++] = value;
  view.setUint16(offset, MFW_PRODUCT_CORE_EVENT_SCHEMA_VERSION, true); offset += 2;
  view.setUint16(offset, MFW_PRODUCT_CORE_ABI_VERSION, true); offset += 2;
  view.setBigUint64(offset, 42n, true); offset += 8;
  view.setBigUint64(offset, 1_234_567_890_123n, true); offset += 8;
  view.setBigUint64(offset, 987_654_321n, true); offset += 8;
  for (const value of [1, 1, 2, 0]) output[offset++] = value;
  view.setUint16(offset, 7, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;
  view.setUint16(offset, 0, true); offset += 2;
  view.setUint16(offset, 1, true); offset += 2;
  for (let id = 1; id <= 5; id += 1) {
    output.fill(id, offset, offset + 16);
    offset += 16;
  }
  view.setUint16(offset, 8, true); offset += 2;
  view.setUint16(offset, 0, true); offset += 2;
  view.setBigInt64(offset, 2_048n, true); offset += 8;
  if (offset !== output.length) throw new Error(`wrong encoded size: ${offset}`);
  return output;
}

if (hex(encodeGoldenEvent()) !== MFW_PRODUCT_CORE_GOLDEN_EVENT_V1_HEX) {
  throw new Error('TypeScript ABI vector mismatch');
}
if (MFW_WALLET_LIFECYCLE_STATE_VERSION !== 1 ||
    MFW_WALLET_LIFECYCLE_SCHEMA_SHA256.length !== 64 ||
    MFW_WALLET_PREFERENCE_PRIVACY_CONVENIENCE !== 2 ||
    MFW_FAST_WALLET_OVERRIDE_DEFAULT !== 0 ||
    MFW_SEND_EVENT_SUBMIT !== 5 ||
    MFW_SEND_STATE_SUBMITTED !== 5) {
  throw new Error('TypeScript wallet lifecycle contract mismatch');
}

console.log(`typescript abi=${MFW_PRODUCT_CORE_ABI_VERSION} encoded_bytes=136 wallet_schema=${MFW_WALLET_LIFECYCLE_SCHEMA_SHA256}`);
