export type SendSourceRef = { kind: 'registered' | 'fast'; id: string };
export type SendSource = {
  source: SendSourceRef;
  label: string;
  network: string;
  balanceAtomic: string;
  unlockedBalanceAtomic: string;
  ready: boolean;
  reason?: string;
  activePlanId?: string;
  activePlanPhase?: string;
};

export type SendPlan = {
  id: string;
  status: 'ok' | 'partial' | 'uncertain' | 'error';
  phase?: 'preparing' | 'prepared' | 'cleanup_failed' | 'authorizing' | 'broadcasting' | 'complete' | 'discarded' | 'interrupted';
  error?: string;
  address?: string;
  sources?: SendSourceRef[];
  amountAtomic?: string | null;
  feeAtomic?: string | null;
  totalAtomic?: string | null;
  dustAtomic?: string;
  txCount: number;
  txIds: string[];
  sourceLabels?: string[];
  broadcastedTxIds?: string[];
  uncertainTxIds?: string[];
  remainingTxIds?: string[];
  broadcastedAmountAtomic?: string | null;
  broadcastedFeeAtomic?: string | null;
  broadcastedTotalsKnown?: boolean;
  broadcastAttempted?: boolean;
  leaseHeld?: boolean;
};

export type PreparedSendPlan = SendPlan & { amountAtomic: string; feeAtomic: string };

export function isPreparedSendPlan(plan: SendPlan): plan is PreparedSendPlan {
  return plan.status === 'ok' && plan.phase === 'prepared' && Boolean(plan.id)
    && typeof plan.amountAtomic === 'string' && /^[0-9]+$/.test(plan.amountAtomic) && BigInt(plan.amountAtomic) > 0n
    && typeof plan.feeAtomic === 'string' && /^[0-9]+$/.test(plan.feeAtomic) && BigInt(plan.feeAtomic) > 0n
    && Number.isInteger(plan.txCount) && plan.txCount > 0 && Array.isArray(plan.txIds) && plan.txIds.length === plan.txCount;
}

export function sendSourceKey(source: SendSourceRef): string {
  return `${source.kind}:${source.id}`;
}

/** Backend enumerates physical wallets; never add a second source implicitly. */
export function sendSourceOptions(sources: SendSource[], network: string, primary: SendSourceRef): SendSource[] {
  const seen = new Set([sendSourceKey(primary)]);
  return sources.filter(item => {
    const key = sendSourceKey(item.source);
    if (item.network !== network || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectedSendAvailable(
  primaryAvailable: string,
  additional: SendSourceRef[],
  sources: SendSource[],
): string | undefined {
  const seen = new Set<string>();
  let total = BigInt(primaryAvailable);
  for (const ref of additional) {
    const key = sendSourceKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const source = sources.find(item => sendSourceKey(item.source) === key);
    if (!source || !source.ready) return undefined;
    total += BigInt(source.unlockedBalanceAtomic);
  }
  return total.toString();
}

export function sendPlanOutcome(plan: SendPlan): 'complete' | 'partial' | 'uncertain' | 'not-sent' {
  if (plan.broadcastAttempted === false && plan.phase !== 'broadcasting'
    && (plan.broadcastedTxIds?.length ?? 0) === 0 && (plan.uncertainTxIds?.length ?? 0) === 0
    && BigInt(plan.broadcastedAmountAtomic ?? '0') === 0n && BigInt(plan.broadcastedFeeAtomic ?? '0') === 0n) return 'not-sent';
  if (plan.status === 'uncertain' || plan.phase === 'authorizing' || plan.phase === 'broadcasting'
    || plan.broadcastedTotalsKnown === false || (plan.uncertainTxIds?.length ?? 0) > 0) return 'uncertain';
  if (plan.status === 'partial') return 'partial';
  if (plan.status === 'ok' && plan.phase === 'complete') return 'complete';
  if ((plan.broadcastedTxIds?.length ?? 0) > 0 || BigInt(plan.broadcastedAmountAtomic ?? '0') > 0n) return 'partial';
  return 'not-sent';
}

export function sendPlanTransactionIds(plan: SendPlan): string[] {
  return [...new Set([
    ...(plan.broadcastedTxIds ?? []),
    ...(plan.uncertainTxIds ?? []),
    ...(plan.remainingTxIds ?? []),
    ...(plan.txIds ?? []),
  ])];
}

export type SendPlanStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function rememberSendPlan(storage: SendPlanStorage, sources: SendSourceRef[], planId: string | null): void {
  for (const source of sources) {
    const key = `mfw.send-plan.${sendSourceKey(source)}`;
    if (planId === null) storage.removeItem(key);
    else storage.setItem(key, planId);
  }
}

export function recalledSendPlan(storage: SendPlanStorage, source: SendSourceRef): string | undefined {
  return storage.getItem(`mfw.send-plan.${sendSourceKey(source)}`) || undefined;
}

/** A failed release keeps its lease queued and prevents a replacement plan. */
export class SendPlanReleaseGate {
  private pending = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  requireDiscard(planId: string): void {
    this.pending.add(planId);
  }

  discardPending(discard: (planId: string) => Promise<SendPlan>): Promise<void> {
    const operation = this.tail.catch(() => undefined).then(async () => {
      for (const planId of this.pending) {
        const result = await discard(planId);
        if (result.phase !== 'discarded') throw new Error('The previous transaction preview could not be released. Check its status before preparing another payment.');
        this.pending.delete(planId);
      }
    });
    this.tail = operation;
    return operation;
  }
}
