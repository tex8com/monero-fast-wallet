import {
  enrollFastWalletWatch,
  type EnrollFastWalletWatchInput,
} from '../FastWalletEnrollmentService';
import type { NativeMoneroWalletModule } from '../NativeMoneroWallet';

const descriptor = 'ab'.repeat(180);
const assignmentHandle = '11'.repeat(32);
const envelope = '22'.repeat(484);
const messageId = '33'.repeat(32);

function input(
  overrides: Partial<EnrollFastWalletWatchInput> = {},
): EnrollFastWalletWatchInput {
  return {
    identityId: 'fast-receive-v2-1',
    path: '/wallets/fast-receive-v2-1',
    credentialKey: 'secure.fast-receive-v2-1',
    network: 'stagenet',
    restoreHeight: 123,
    workerDescriptorHex: descriptor,
    now: 1_900_000_000,
    ...overrides,
  };
}

function nativeFixture() {
  const callOrder: string[] = [];
  const native = {
    loadOfficialFastWalletWorkerDescriptor: jest.fn(async () => descriptor),
    sponsorFastWalletAssignment: jest.fn(async () => {
      callOrder.push('sponsor');
      return {
        assignmentHandle,
        assignmentEpoch: 4,
        expiresAt: 1_902_592_000,
        status: 'active',
      };
    }),
    sealFastReceiveWatchWithStoredSecret: jest.fn(async () => {
      callOrder.push('seal');
      return envelope;
    }),
    submitFastWalletWatch: jest.fn(async () => {
      callOrder.push('submit');
      return messageId;
    }),
  } as unknown as NativeMoneroWalletModule;
  return { callOrder, native };
}

describe('FastWalletEnrollmentService', () => {
  it('sponsors, seals natively, then submits one canonical fixed-size envelope', async () => {
    const { callOrder, native } = nativeFixture();

    const result = await enrollFastWalletWatch(native, input());

    expect(callOrder).toEqual(['sponsor', 'seal', 'submit']);
    expect(native.sponsorFastWalletAssignment).toHaveBeenCalledWith({
      identityId: 'fast-receive-v2-1',
      workerDescriptorHex: descriptor,
      network: 'stagenet',
      assignmentExpiresAt: 1_902_592_000,
      now: 1_900_000_000,
    });
    expect(native.sealFastReceiveWatchWithStoredSecret).toHaveBeenCalledWith({
      identityId: 'fast-receive-v2-1',
      path: '/wallets/fast-receive-v2-1',
      secretKey: 'secure.fast-receive-v2-1',
      network: 'stagenet',
      restoreHeight: 123,
      workerDescriptorHex: descriptor,
      assignmentHandleHex: assignmentHandle,
      assignmentEpoch: 4,
      issuedAt: 1_900_000_000,
      expiresAt: 1_900_000_600,
      now: 1_900_000_000,
    });
    expect(native.submitFastWalletWatch).toHaveBeenCalledWith({
      workerDescriptorHex: descriptor,
      network: 'stagenet',
      now: 1_900_000_000,
      envelopeHex: envelope,
    });
    expect(result.assignment.assignmentHandle).toBe(assignmentHandle);
    expect(result.messageId).toBe(messageId);
  });

  it('loads the rotating official descriptor through the native pinned-root path', async () => {
    const { native } = nativeFixture();

    await enrollFastWalletWatch(
      native,
      input({ workerDescriptorHex: undefined }),
    );

    expect(
      native.loadOfficialFastWalletWorkerDescriptor,
    ).toHaveBeenCalledWith('stagenet', 1_900_000_000);
    expect(native.sponsorFastWalletAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ workerDescriptorHex: descriptor }),
    );
  });

  it('fails before native code for a non-canonical descriptor', async () => {
    const { native } = nativeFixture();

    await expect(
      enrollFastWalletWatch(native, input({ workerDescriptorHex: 'AA' })),
    ).rejects.toThrow('Worker descriptor is invalid');
    expect(native.sponsorFastWalletAssignment).not.toHaveBeenCalled();
  });

  it('does not expose or submit anything after assignment sponsorship fails', async () => {
    const { native } = nativeFixture();
    (native.sponsorFastWalletAssignment as jest.Mock).mockRejectedValueOnce(
      new Error('gateway unavailable'),
    );

    await expect(enrollFastWalletWatch(native, input())).rejects.toThrow(
      'gateway unavailable',
    );
    expect(native.sealFastReceiveWatchWithStoredSecret).not.toHaveBeenCalled();
    expect(native.submitFastWalletWatch).not.toHaveBeenCalled();
  });

  it('rejects a malformed native envelope before Relay submission', async () => {
    const { native } = nativeFixture();
    (
      native.sealFastReceiveWatchWithStoredSecret as jest.Mock
    ).mockResolvedValueOnce('22');

    await expect(enrollFastWalletWatch(native, input())).rejects.toThrow(
      'watchEnvelope is invalid',
    );
    expect(native.submitFastWalletWatch).not.toHaveBeenCalled();
  });
});
