import {
  fastWalletHostingNeedsRepair,
  freshFastWalletHostingView,
  parseFastWalletHostingView,
} from '../../../../../packages/wallet-shared/src/fastWalletHosting';

const hosted = {
  status: 'hosted', attemptedAt: 1000, checkedAt: 1000,
  verified: true, repairAttempted: false,
  assignmentHandle: '11'.repeat(32), assignmentEpoch: 1, workerRootId: 'aa'.repeat(32),
};

describe('Fast Wallet hosting proof boundaries', () => {
  it('rejects local admission metadata and unverified success', () => {
    expect(parseFastWalletHostingView({ assignmentHandle: 'fixture', workerReceiptVerified: true })).toBeUndefined();
    expect(parseFastWalletHostingView({ ...hosted, verified: false }, 1000)).toEqual(expect.objectContaining({ status: 'unknown', verified: false, errorCode: 'invalid_proof' }));
  });

  it('keeps dated persisted proof while rejecting it as a new live response', () => {
    expect(parseFastWalletHostingView(hosted, 2000)?.status).toBe('hosted');
    expect(freshFastWalletHostingView(hosted, 2000).status).toBe('unknown');
  });

  it('enforces the same five-second skew and sixty-second freshness limits', () => {
    expect(freshFastWalletHostingView({ ...hosted, checkedAt: 1005 }, 1000).status).toBe('hosted');
    expect(freshFastWalletHostingView({ ...hosted, checkedAt: 1006 }, 1000).status).toBe('unknown');
    expect(freshFastWalletHostingView({ ...hosted, checkedAt: 994 }, 1000).status).toBe('unknown');
    expect(freshFastWalletHostingView(hosted, 1061).status).toBe('unknown');
  });

  it('requires a fresh proof and an actual repair for rehosted', () => {
    expect(parseFastWalletHostingView({ ...hosted, status: 'rehosted' }, 1000)?.status).toBe('unknown');
    expect(parseFastWalletHostingView({ ...hosted, status: 'rehosted', repairAttempted: true }, 1000)?.status).toBe('rehosted');
  });

  it('repairs only authoritative missing or explicit native assignment states', () => {
    const base = { attemptedAt: 1000, verified: false, repairAttempted: false };
    for (const status of ['unknown', 'blocked', 'unsupported'] as const) {
      expect(fastWalletHostingNeedsRepair({ ...base, status, errorCode: 'network_error' })).toBe(false);
    }
    expect(fastWalletHostingNeedsRepair({ ...base, status: 'missing' })).toBe(false);
    expect(fastWalletHostingNeedsRepair({ ...base, status: 'missing', errorCode: 'no_assignment' })).toBe(true);
    expect(fastWalletHostingNeedsRepair({ ...base, status: 'missing', verified: true, checkedAt: 1000 })).toBe(true);
  });

  it('never persists arbitrary server response text as an error', () => {
    expect(parseFastWalletHostingView({ ...hosted, errorCode: 'HTTP error: secret fixture' }, 1000)?.errorCode).toBeUndefined();
  });
});
