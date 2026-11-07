#ifndef MFW_SEND_PLAN_H
#define MFW_SEND_PLAN_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Synchronous, trusted native host only. No callback or input is retained.
 * call returns an owned NUL-terminated UTF-8 JSON envelope:
 * {"ok":true,"value":...} or {"ok":false,"error":"..."}.
 * release is called exactly once on every non-NULL callback result.
 * Secrets and payment payloads MUST NOT enter the diagnostic recorder.
 *
 * Host operations and input -> value:
 * authorization.check: null -> true (current native app session unlocked)
 * validate: Binding -> null (recheck physical identity/network/open sessions)
 * accounts: {walletId} -> Account[]
 * prepare: {walletId,address,amountAtomic,priority,accountIndex} -> Prepared
 * discard: {walletId,pendingId} -> null
 * commit: {walletId,pendingId} -> CommitReport (one-shot native report)
 * history: Binding -> HistoryTransaction[] (positive native outgoing evidence;
 *          resolve current session by physical identity after process restart)
 * journal.load: null -> Plan[] (absent encrypted key means [])
 * journal.save: Plan[] -> null (atomic durable encrypted write + readback)
 *
 * Binding, Account, Prepared, CommitReport, Plan and HistoryTransaction use the
 * camelCase JSON contract in product-core/src/send_plan.rs. Bindings MUST be
 * constructed by the native engine; renderer labels/physical IDs are untrusted.
 *
 * Commands to execute:
 * {op:"prepare",bindings:Binding[],address,amountAtomic:""|fixed,priority}
 * {op:"adopt",binding:Binding,accountIndex,prepared:Prepared,address}
 *   -> public receipt; PRIVATE native legacy-review adoption, no prepare/relay.
 *   The host supplies its own tracked unexpired native request/preview only.
 * {op:"claim",planId} -> {plan:<public receipt>,claimToken:<opaque string>}
 * {op:"commit",planId,claimToken} -> public receipt
 * {op:"release",planId,claimToken} -> null (native dialog/auth cancellation)
 * {op:"status",planId} -> public receipt; NEVER transmits
 * {op:"list"} -> public receipt[] (live and saved, no executable claim tokens)
 * {op:"discard",planId} -> null; NEVER transmits
 * {op:"leases",walletId,physicalId} -> bool (live AND saved holds)
 * {op:"invalidate"} -> null (invalidate claims; preserve uncertain receipts)
 *
 * claim/commit/release and their token are PRIVATE native interfaces. The
 * renderer only gets public receipts and requests commit by planId. The native
 * platform must claim before its trusted aggregate confirmation, perform fresh
 * biometric/password authorization, then call commit using the private token.
 * Native single-transaction/MFW prepare paths must consult leases. Internal
 * planner callbacks may bypass that lease check only in trusted native code.
 * Calls on a context are serialized; callbacks MUST NOT reenter that context.
 */
typedef struct MfwSendPlanHostV1 {
  uint32_t struct_size;
  void *user_data;
  char *(*call)(void *user_data, const char *operation, const char *input_json);
  void (*release)(void *user_data, char *result_json);
} MfwSendPlanHostV1;

void *mfw_send_plan_context_create_v1(void);
void mfw_send_plan_context_destroy_v1(void *context);
/* Owned UTF-8 envelope, same {ok,value|error} shape. */
char *mfw_send_plan_execute_v1(void *context, const MfwSendPlanHostV1 *host,
                              const char *command_json);
void mfw_send_plan_string_free_v1(char *result_json);
/* Trusted native engine values only; result value is wallet:<network>:SHA256.
 * Release the owned envelope with mfw_send_plan_string_free_v1. */
char *mfw_send_plan_physical_id_v1(const char *network, const char *primary_address);

#ifdef __cplusplus
}
#endif
#endif
