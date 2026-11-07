import type { MoneroNetwork, PreparedTransaction } from './NativeMoneroWallet';
import type {
  PreparedSendPlan,
  SendPlan,
} from '../../../../packages/wallet-shared/src/sendPlan';
export {
  isPreparedSendPlan,
  sendPlanOutcome,
  sendPlanTransactionIds,
} from '../../../../packages/wallet-shared/src/sendPlan';
export type {
  SendPlan,
  PreparedSendPlan,
} from '../../../../packages/wallet-shared/src/sendPlan';

export type ReviewedWalletTransaction = PreparedTransaction & {
  sendPlan?: PreparedSendPlan;
};

export function physicalSendSourceIdentity(
  network: MoneroNetwork,
  primaryAddress: string,
): string {
  if (typeof primaryAddress !== 'string' || !primaryAddress.trim()) {
    throw new Error('The native wallet did not return its primary address.');
  }
  return `${network}:${primaryAddress.trim()}`;
}

/** Preserve explicit source order, with the primary physical wallet first. */
export function distinctPhysicalSendSourceIndexes(
  identities: readonly string[],
): number[] {
  const seen = new Set<string>();
  const result: number[] = [];
  identities.forEach((identity, index) => {
    if (!identity)
      throw new Error('The physical payment source could not be verified.');
    if (!seen.has(identity)) {
      seen.add(identity);
      result.push(index);
    }
  });
  return result;
}

/** Validate bridge data before rendering or interpreting any monetary values. */
export function parseWalletSendPlan(value: unknown): SendPlan {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid native payment status.');
  const plan = value as SendPlan;
  if (
    typeof plan.id !== 'string' ||
    !plan.id ||
    !['ok', 'partial', 'uncertain', 'error'].includes(plan.status) ||
    !Number.isSafeInteger(plan.txCount) ||
    plan.txCount < 0
  ) {
    throw new Error('Invalid native payment status.');
  }
  for (const ids of [
    plan.txIds,
    plan.broadcastedTxIds,
    plan.uncertainTxIds,
    plan.remainingTxIds,
  ]) {
    if (
      ids !== undefined &&
      (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id))
    ) {
      throw new Error('Invalid native transaction identifiers.');
    }
  }
  if (!Array.isArray(plan.txIds))
    throw new Error('Invalid native transaction identifiers.');
  for (const amount of [
    plan.amountAtomic,
    plan.feeAtomic,
    plan.totalAtomic,
    plan.broadcastedAmountAtomic,
    plan.broadcastedFeeAtomic,
  ]) {
    if (
      amount != null &&
      (typeof amount !== 'string' || !/^[0-9]+$/.test(amount))
    ) {
      throw new Error('Invalid native payment amount.');
    }
  }
  return plan;
}

export function reviewedWalletSendPlan(
  plan: PreparedSendPlan,
): ReviewedWalletTransaction {
  return {
    id: plan.id,
    status: plan.status,
    error: '',
    amountAtomic: plan.amountAtomic,
    feeAtomic: plan.feeAtomic,
    dustAtomic: plan.dustAtomic ?? '0',
    txCount: plan.txCount,
    txIds: [...plan.txIds],
    subaddrAccounts: [],
    subaddrIndices: [],
    sendPlan: plan,
  };
}
