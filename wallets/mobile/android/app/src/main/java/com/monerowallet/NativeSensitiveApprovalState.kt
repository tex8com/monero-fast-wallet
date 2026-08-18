package com.monerowallet

internal data class NativeTransactionApproval(
  val walletId: String,
  val pendingId: String,
  val address: String,
  val amountAtomic: String,
  val feeAtomic: String,
  val expiresAtMs: Long,
)

/**
 * Native, process-local approval state. React Native can prepare a transaction,
 * but it cannot manufacture or persist the single-use approval required by the
 * native commit path.
 */
internal object NativeSensitiveApprovalState {
  private val transactionApprovals = mutableMapOf<String, NativeTransactionApproval>()

  @Synchronized
  fun put(approval: NativeTransactionApproval) {
    transactionApprovals.clear()
    transactionApprovals[approval.pendingId] = approval
  }

  @Synchronized
  fun consume(walletId: String, pendingId: String): NativeTransactionApproval? {
    val approval = transactionApprovals.remove(pendingId) ?: return null
    return approval.takeIf {
      it.walletId == walletId && it.expiresAtMs >= System.currentTimeMillis()
    }
  }

  @Synchronized
  fun clear() {
    transactionApprovals.clear()
  }
}
