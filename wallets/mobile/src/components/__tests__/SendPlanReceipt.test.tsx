import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import Clipboard from '@react-native-clipboard/clipboard';
import SendPlanReceipt from '../SendPlanReceipt';
import type { SendPlan } from '../../services/WalletSendPlan';

jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const accepted = 'a'.repeat(64);
const uncertain = 'b'.repeat(64);
const remaining = 'c'.repeat(64);
const receipt = (overrides: Partial<SendPlan> = {}): SendPlan => ({
  id: 'fixture-plan', status: 'partial', phase: 'complete',
  address: 'fixture-recipient', amountAtomic: '1000000000000',
  feeAtomic: '3000000000', txCount: 3, txIds: [accepted, uncertain, remaining],
  broadcastAttempted: true, broadcastedTxIds: [accepted], uncertainTxIds: [],
  remainingTxIds: [uncertain, remaining], broadcastedAmountAtomic: '400000000000',
  broadcastedFeeAtomic: '1000000000', broadcastedTotalsKnown: true,
  leaseHeld: false, ...overrides,
});
const text = (renderer: ReactTestRenderer.ReactTestRenderer) => renderer.root
  .findAllByType(Text).flatMap(node => node.props.children).join(' ');
const buttonLabels = (renderer: ReactTestRenderer.ReactTestRenderer) => renderer.root
  .findAllByType(TouchableOpacity)
  .map(button => button.findAllByType(Text).flatMap(node => node.props.children).join(' '));

async function render(plan: SendPlan, extra: Partial<React.ComponentProps<typeof SendPlanReceipt>> = {}) {
  const callbacks = { onStatus: jest.fn(), onDiscard: jest.fn(), onClose: jest.fn() };
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<SendPlanReceipt plan={plan} checking={false} {...callbacks} {...extra} />);
  });
  return { renderer, ...callbacks };
}

describe('payment receipts preserve transmission evidence', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows every accepted, uncertain and remaining full TX ID exactly once and copies each one', async () => {
    const { renderer } = await render(receipt({ status: 'uncertain', uncertainTxIds: [uncertain] }));
    const content = text(renderer);
    for (const hash of [accepted, uncertain, remaining]) {
      expect(content.split(hash).length - 1).toBe(1);
    }
    expect(content).toContain('send.planTxAccepted');
    expect(content).toContain('send.planTxUncertain');
    expect(content).toContain('send.planTxRemaining');
    const copyButtons = renderer.root.findAllByType(TouchableOpacity)
      .filter(button => button.findAllByType(Text).some(node => node.props.children === 'transactions.copyId'));
    for (const button of copyButtons) {
      await ReactTestRenderer.act(async () => { button.props.onPress(); });
    }
    expect((Clipboard.setString as jest.Mock).mock.calls.map(call => call[0]))
      .toEqual([accepted, uncertain, remaining]);
  });

  it.each(['partial', 'uncertain'] as const)('%s receipts offer status and close, with no repeat-payment action', async status => {
    const { renderer, onStatus, onDiscard, onClose } = await render(receipt({
      status, uncertainTxIds: status === 'uncertain' ? [uncertain] : [], leaseHeld: true,
    }));
    expect(buttonLabels(renderer).filter(label => label !== 'transactions.copyId'))
      .toEqual(['send.planCheckStatus', 'action.close']);
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ testID: 'send-plan-refresh' }).props.onPress();
    });
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    { broadcastedAmountAtomic: null, broadcastedFeeAtomic: null },
    { broadcastedAmountAtomic: '0', broadcastedFeeAtomic: '0', broadcastedTotalsKnown: false },
    { broadcastedAmountAtomic: undefined, broadcastedFeeAtomic: undefined },
  ])('keeps unverified totals visibly unknown instead of inventing zero: %j', async fields => {
    const { renderer } = await render(receipt({ status: 'uncertain', ...fields }));
    const content = text(renderer);
    expect(content.split('send.planAmountUnknown').length - 1).toBe(2);
    expect(content).not.toContain('0 XMR');
  });

  it('can discard a proven unattempted held draft only through its explicit button', async () => {
    const { renderer, onStatus, onDiscard } = await render(receipt({
      status: 'error', phase: 'cleanup_failed', amountAtomic: null, feeAtomic: null,
      broadcastAttempted: false, broadcastedTxIds: [], uncertainTxIds: [],
      broadcastedAmountAtomic: '0', broadcastedFeeAtomic: '0', leaseHeld: true,
    }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => {
      renderer.root.findByProps({ testID: 'send-plan-discard' }).props.onPress();
    });
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it.each([
    { broadcastAttempted: undefined },
    { broadcastAttempted: true },
    { broadcastAttempted: false, phase: 'broadcasting' as const },
  ])('never offers discard without definite proof that relay did not start: %j', async fields => {
    const { renderer } = await render(receipt({
      status: 'error', broadcastedTxIds: [], uncertainTxIds: [], leaseHeld: true,
      broadcastedAmountAtomic: '0', broadcastedFeeAtomic: '0', ...fields,
    }));
    expect(renderer.root.findAllByProps({ testID: 'send-plan-discard' })).toHaveLength(0);
  });

  it('disables status and discard during a status request and keeps native errors visible', async () => {
    const { renderer } = await render(receipt({
      status: 'error', phase: 'cleanup_failed', broadcastAttempted: false,
      broadcastedTxIds: [], uncertainTxIds: [], broadcastedAmountAtomic: '0',
      broadcastedFeeAtomic: '0', leaseHeld: true,
    }), { checking: true, error: 'Fixture status unavailable' });
    expect(renderer.root.findByProps({ testID: 'send-plan-refresh' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ testID: 'send-plan-discard' }).props.disabled).toBe(true);
    expect(text(renderer)).toContain('Fixture status unavailable');
  });
});
