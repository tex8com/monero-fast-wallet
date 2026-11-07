/**
 * Presentation for a failed PREPARATION only. Never use this classifier for
 * commit/broadcast failures or saved receipts: those may already be partial
 * or uncertain and must retain their native outcome/recovery flow.
 */
export type SendPreparationError = {
  kind: "ledger-cancelled" | "node-output-distribution" | "ledger-output-verification" | "unknown";
  messageKey:
    | "send.preparationCancelledLedger"
    | "send.preparationNodeFailed"
    | "send.preparationLedgerVerificationFailed"
    | "send.preparationUnknownFailed";
  cancelled: boolean;
};

function preparationErrorText(reason: unknown): string {
  // Do not stringify native objects: they may carry request/wallet metadata.
  const message = typeof reason === "string"
    ? reason
    : reason && typeof reason === "object" && "message" in reason &&
        typeof reason.message === "string"
    ? reason.message
    : "";
  if (message.length > 4_096) return "";
  let result = message.trim();
  // These are the wrappers used by the native bridges and WalletImpl. Do
  // not strip arbitrary prefixes or accept a denial buried in other text.
  const wrapper = /^(?:Error|WalletEngineError|unexpected error|prepareTransaction|prepareSendPlan|prepare_send_plan):\s*/i;
  for (let depth = 0; depth < 6 && wrapper.test(result); depth += 1) {
    result = result.replace(wrapper, "").trim();
  }
  return result;
}

export function classifySendPreparationError(reason: unknown): SendPreparationError {
  const message = preparationErrorText(reason);
  // Pinned device_ledger.cpp uses Transaction denied for the output/amount
  // confirmation as well as Fee denied for the fee confirmation. A denial
  // is deliberate user input, not a device or transport failure.
  if (message === "Fee denied on device." || message === "Transaction denied on device.") {
    return {kind: "ledger-cancelled", messageKey: "send.preparationCancelledLedger", cancelled: true};
  }
  // Core may embed the operation in a C++ mangled type name, e.g.
  // N5tools5error23get_output_distributionE. Word boundaries would miss
  // precisely that native RPC failure and expose only a generic error.
  if (message.includes("get_output_distribution") ||
      message.includes("Could not obtain output distribution.")) {
    return {kind: "node-output-distribution", messageKey: "send.preparationNodeFailed", cancelled: false};
  }
  if (/(?:^|: )(?:Ledger scan-state source has an unverified owned output at index |Ledger could not verify owned output |Ledger output binding failed at index |Ledger Key Image does not match the companion at index |Ledger-derived ephemeral public key does not match owned output |Ledger failed to derive the key image for owned output )[0-9]+$/.test(message)) {
    return {kind: "ledger-output-verification", messageKey: "send.preparationLedgerVerificationFailed", cancelled: false};
  }
  return {kind: "unknown", messageKey: "send.preparationUnknownFailed", cancelled: false};
}
