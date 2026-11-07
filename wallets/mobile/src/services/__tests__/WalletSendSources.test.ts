import {
  distinctPhysicalSendSourceIndexes,
  physicalSendSourceIdentity,
} from '../WalletSendPlan';

it('preserves the primary source and removes restored-seed aliases independently of registration or handle IDs', () => {
  const master = physicalSendSourceIdentity('mainnet', '4'.repeat(95));
  const other = physicalSendSourceIdentity('mainnet', '8'.repeat(95));
  const anotherNetwork = physicalSendSourceIdentity('testnet', '4'.repeat(95));
  expect(
    distinctPhysicalSendSourceIndexes([
      master,
      master,
      other,
      other,
      anotherNetwork,
    ]),
  ).toEqual([0, 2, 4]);
});

it('requires a real native primary address rather than manufacturing an identity', () => {
  expect(() => physicalSendSourceIdentity('mainnet', '')).toThrow(
    'primary address',
  );
  expect(() =>
    distinctPhysicalSendSourceIndexes(['mainnet:master', '']),
  ).toThrow('could not be verified');
});
