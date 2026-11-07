import {presentBalanceAvailability} from '../../../../../packages/wallet-shared/src/balanceAvailability';

describe('canonical whole-wallet balance availability', () => {
  it('subtracts exact atomic amounts above Number precision', () => {
    expect(presentBalanceAvailability({
      balanceAtomic: '9007199254740993000', unlockedBalanceAtomic: '9007199254740992999',
      lockedBalanceAtomic: '1', unlockState: 'blocks', unlockBlocksRemaining: 7,
      unlockTimeRemainingSeconds: 0,
    })).toEqual({
      availableAtomic: '9007199254740992999', lockedAtomic: '1', state: 'blocks', blocksRemaining: 7,
    });
  });

  it('uses the native full-release maximum instead of a usual confirmation interval', () => {
    expect(presentBalanceAvailability({
      balanceAtomic: '1191306869968', unlockedBalanceAtomic: '468911040000',
      lockedBalanceAtomic: '722395829968', unlockState: 'blocks', unlockBlocksRemaining: 63,
    })).toMatchObject({lockedAtomic: '722395829968', state: 'blocks', blocksRemaining: 63});
  });

  it('keeps pending arrivals or change pending even when a partial block count exists', () => {
    expect(presentBalanceAvailability({
      balanceAtomic: '100', unlockedBalanceAtomic: '30',
      unlockState: 'pending', unlockBlocksRemaining: 0, unlockTimeRemainingSeconds: 0,
    })).toEqual({availableAtomic: '30', lockedAtomic: '70', state: 'pending'});
    expect(presentBalanceAvailability({
      balanceAtomic: '100', unlockedBalanceAtomic: '30',
      unlockState: 'pending', unlockBlocksRemaining: 7,
    }).blocksRemaining).toBeUndefined();
  });

  it('does not turn a time lock into zero-block availability', () => {
    expect(presentBalanceAvailability({
      balanceAtomic: '100', unlockedBalanceAtomic: '30', unlockState: 'timestamp',
      unlockBlocksRemaining: 0, unlockTimeRemainingSeconds: 3600,
    })).toEqual({availableAtomic: '30', lockedAtomic: '70', state: 'timestamp', secondsRemaining: 3600});
    expect(presentBalanceAvailability({
      balanceAtomic: '100', unlockedBalanceAtomic: '30', unlockState: 'mixed',
      unlockBlocksRemaining: 12, unlockTimeRemainingSeconds: 3600,
    })).toMatchObject({state: 'mixed', blocksRemaining: 12, secondsRemaining: 3600});
  });

  it('keeps timing unknown for legacy or contradictory snapshots while retaining valid amounts', () => {
    const base = {balanceAtomic: '100', unlockedBalanceAtomic: '30'};
    for (const metadata of [
      {},
      {unlockState: 'unlocked', unlockBlocksRemaining: 0},
      {unlockState: 'blocks', unlockBlocksRemaining: 0},
      {unlockState: 'blocks', unlockBlocksRemaining: -1},
      {unlockState: 'blocks', unlockBlocksRemaining: Number.MAX_SAFE_INTEGER + 1},
      {unlockState: 'blocks', unlockBlocksRemaining: 3.5},
      {unlockState: 'blocks', unlockBlocksRemaining: 7, lockedBalanceAtomic: '69'},
      {unlockState: 'timestamp', unlockTimeRemainingSeconds: 0},
    ]) expect(presentBalanceAvailability({...base, ...metadata})).toEqual({
      availableAtomic: '30', lockedAtomic: '70', state: 'unknown',
    });
  });

  it('shows fully available funds only when no positive locked amount remains', () => {
    expect(presentBalanceAvailability({balanceAtomic: '100', unlockedBalanceAtomic: '100'}))
      .toEqual({availableAtomic: '100', lockedAtomic: '0', state: 'unlocked'});
    expect(presentBalanceAvailability({balanceAtomic: '0', unlockedBalanceAtomic: '0', unlockState: 'unlocked'}))
      .toEqual({availableAtomic: '0', lockedAtomic: '0', state: 'unlocked'});
  });

  it.each([
    undefined,
    {balanceAtomic: '100'},
    {balanceAtomic: '-1', unlockedBalanceAtomic: '0'},
    {balanceAtomic: '100', unlockedBalanceAtomic: '101'},
    {balanceAtomic: '100', unlockedBalanceAtomic: '1.5'},
    {balanceAtomic: '18446744073709551616', unlockedBalanceAtomic: '0'},
  ])('does not fabricate available or locked funds from invalid input', source => {
    expect(presentBalanceAvailability(source)).toEqual({state: 'unknown'});
  });
});
