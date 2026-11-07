const mockReceipt = JSON.stringify({
  id: 'fixture-plan',
  phase: 'prepared',
  amountAtomic: '1191306669968',
  feeAtomic: '200000',
  txCount: 2,
});
const mockNativePlanModule = {
  prepareSendPlan: jest.fn(async (_inputJson: string) => mockReceipt),
  commitSendPlan: jest.fn(async (_planId: string) => mockReceipt),
  sendPlanStatus: jest.fn(async (_planId: string) => mockReceipt),
  listSendPlans: jest.fn(async () => `[${mockReceipt}]`),
  discardSendPlan: jest.fn(async (_planId: string) => undefined),
  prepareTransaction: jest.fn(),
  commitTransaction: jest.fn(),
};
jest.mock('react-native', () => ({
  TurboModuleRegistry: { get: jest.fn(() => mockNativePlanModule) },
}));

describe('NativeMoneroWallet shared payment plans', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends one plan request and preserves exact native review amounts', async () => {
    const { requireNativeMoneroWallet } = require('../NativeMoneroWallet') as
      typeof import('../NativeMoneroWallet');
    const input = JSON.stringify({
      sources: [{ walletId: 'native-wallet-a' }, { walletId: 'native-wallet-b' }],
      address: 'fixture-recipient', amountAtomic: '', priority: 'low',
    });
    await expect(requireNativeMoneroWallet().prepareSendPlan(input)).resolves.toBe(mockReceipt);
    expect(mockNativePlanModule.prepareSendPlan).toHaveBeenCalledWith(input);
    expect(mockNativePlanModule.prepareSendPlan).toHaveBeenCalledTimes(1);
    expect(mockNativePlanModule.prepareTransaction).not.toHaveBeenCalled();
    expect(mockNativePlanModule.commitTransaction).not.toHaveBeenCalled();
  });

  it('requests native confirmation using only the plan id and exposes no claim API', async () => {
    const { requireNativeMoneroWallet } = require('../NativeMoneroWallet') as
      typeof import('../NativeMoneroWallet');
    const wallet = requireNativeMoneroWallet();
    await wallet.commitSendPlan('fixture-plan');
    expect(mockNativePlanModule.commitSendPlan).toHaveBeenCalledWith('fixture-plan');
    expect(wallet).not.toHaveProperty('claimSendPlan');
    expect(wallet).not.toHaveProperty('releaseSendPlan');
    expect(mockNativePlanModule.commitTransaction).not.toHaveBeenCalled();
  });

  it('recovers receipts, checks status and cancels without requesting a commit', async () => {
    const { requireNativeMoneroWallet } = require('../NativeMoneroWallet') as
      typeof import('../NativeMoneroWallet');
    const wallet = requireNativeMoneroWallet();
    await expect(wallet.listSendPlans()).resolves.toBe(`[${mockReceipt}]`);
    await expect(wallet.sendPlanStatus('fixture-plan')).resolves.toBe(mockReceipt);
    await expect(wallet.discardSendPlan('fixture-plan')).resolves.toBeUndefined();
    expect(mockNativePlanModule.commitSendPlan).not.toHaveBeenCalled();
    expect(mockNativePlanModule.commitTransaction).not.toHaveBeenCalled();
  });

  it('keeps native commit failures visible without falling back to a single-account payment', async () => {
    const { requireNativeMoneroWallet } = require('../NativeMoneroWallet') as
      typeof import('../NativeMoneroWallet');
    mockNativePlanModule.commitSendPlan.mockRejectedValueOnce(new Error('native source changed'));
    await expect(requireNativeMoneroWallet().commitSendPlan('fixture-plan'))
      .rejects.toThrow('native source changed');
    expect(mockNativePlanModule.commitSendPlan).toHaveBeenCalledTimes(1);
    expect(mockNativePlanModule.prepareTransaction).not.toHaveBeenCalled();
    expect(mockNativePlanModule.commitTransaction).not.toHaveBeenCalled();
  });
});
