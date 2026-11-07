import React from 'react';
import {StyleSheet, Text} from 'react-native';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';

import BalanceAvailability from '../BalanceAvailability';
import {colors} from '../../theme/colors';

jest.mock('../../i18n', () => ({
  useI18n: () => ({
    dateLocale: 'en-US',
    t: (key: string, params?: Record<string, string | number>) => `${key}${params ? ` ${JSON.stringify(params)}` : ''}`,
  }),
}));

describe('Home availability and release countdown', () => {
  let tree: ReactTestRenderer;
  afterEach(() => act(() => tree?.unmount()));
  const source = {
    balanceAtomic: '1191306869968', unlockedBalanceAtomic: '468911040000',
    lockedBalanceAtomic: '722395829968', unlockState: 'blocks', unlockBlocksRemaining: 7,
  };
  function render(snapshot: React.ComponentProps<typeof BalanceAvailability>['snapshot'] = source, live = true) {
    act(() => {tree = renderer.create(<BalanceAvailability snapshot={snapshot} live={live} />);});
  }
  function hint() {
    return tree.root.findByProps({testID: 'home-balance-unlock-hint'}).props.children;
  }

  it('shows available and locked amounts exactly and the canonical full-release count', () => {
    render();
    expect(tree.root.findByProps({testID: 'home-balance-available'}).props.children).toBe('0.46891104 XMR');
    expect(tree.root.findByProps({testID: 'home-balance-locked'}).props.children).toBe('0.722395829968 XMR');
    expect(hint()).toContain('home.unlockBlocks');
    expect(hint()).toContain('"count":"7"');
  });

  it('updates the countdown from fresh native snapshots and removes it when fully released', () => {
    render();
    act(() => tree.update(<BalanceAvailability snapshot={{...source, unlockBlocksRemaining: 1}} />));
    expect(hint()).toContain('"count":"1"');
    act(() => tree.update(<BalanceAvailability snapshot={{...source,
      unlockedBalanceAtomic: source.balanceAtomic, lockedBalanceAtomic: '0', unlockState: 'unlocked', unlockBlocksRemaining: 0,
    }} />));
    expect(tree.root.findByProps({testID: 'home-balance-locked'}).props.children).toBe('0 XMR');
    expect(tree.root.findAllByProps({testID: 'home-balance-unlock-hint'})).toHaveLength(0);
  });

  it('explains pending and time locks without promising zero-block release', () => {
    render({...source, unlockState: 'pending', unlockBlocksRemaining: 0});
    expect(hint()).toBe('home.unlockPending');
    act(() => tree.update(<BalanceAvailability snapshot={{...source,
      unlockState: 'timestamp', unlockBlocksRemaining: 0, unlockTimeRemainingSeconds: 120,
    }} />));
    expect(hint()).toContain('home.unlockTime');
    expect(hint()).not.toContain('home.unlockBlocks');
  });

  it('does not present cached block counts as a live release countdown', () => {
    render(source, false);
    expect(hint()).toBe('home.unlockUnknown');
    expect(tree.root.findByProps({testID: 'home-balance-locked'}).props.children).toBe('0.722395829968 XMR');
  });

  it('shows live provisional Ledger amounts and maturity without claiming verified spendability', () => {
    act(() => {tree = renderer.create(<BalanceAvailability snapshot={source} provisional />);});
    const available = tree.root.findByProps({testID: 'home-balance-available'});
    expect(available.props.children).toBe('0.46891104 XMR');
    expect(StyleSheet.flatten(available.props.style).color).not.toBe(colors.success);
    expect(tree.root.findByProps({testID: 'home-balance-locked'}).props.children).toBe('0.722395829968 XMR');
    expect(tree.root.findAllByType(Text).some(node => node.props.children === 'home.availableBalanceProvisional')).toBe(true);
    expect(tree.root.findAllByType(Text).some(node => node.props.children === 'home.lockedBalanceProvisional')).toBe(true);
    expect(hint()).toContain('home.unlockBlocksProvisional');
    expect(hint()).toContain('"count":"7"');
    expect(tree.root.findByProps({testID: 'home-balance-provisional-hint'}).props.children).toBe('home.ledgerAvailabilityProvisional');
    act(() => tree.update(<BalanceAvailability snapshot={source} provisional live={false} />));
    expect(hint()).toBe('home.unlockUnknown');
    expect(tree.root.findByProps({testID: 'home-balance-locked'}).props.children).toBe('0.722395829968 XMR');
  });

  it('keeps withheld or unavailable balances visibly unknown', () => {
    act(() => {tree = renderer.create(<BalanceAvailability />);});
    expect(tree.root.findByProps({testID: 'home-balance-available'}).props.children).toBe('— XMR');
    expect(tree.root.findByProps({testID: 'home-balance-locked'}).props.children).toBe('— XMR');
    expect(tree.root.findAllByType(Text).some(node => node.props.children === '0 XMR')).toBe(false);
  });
});
