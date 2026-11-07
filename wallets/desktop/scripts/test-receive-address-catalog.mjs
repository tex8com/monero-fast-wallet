import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseReceiveAddressCatalog,
  receiveCatalogAddresses,
  selectedReceiveAddress,
} from '../src/receiveAddressCatalog.ts';
import { SendSnapshotLoader } from '../src/sendSnapshotLoader.ts';

const address = (accountIndex, addressIndex, label = '') => ({ accountIndex, addressIndex, address: `fixture-${accountIndex}-${addressIndex}`, label });
const account = (accountIndex, label = '', addresses = [address(accountIndex, 0)]) => ({ accountIndex, label, balanceAtomic: '0', unlockedBalanceAtomic: '0', addresses });
const catalog = () => parseReceiveAddressCatalog({ accounts: [
  account(19, 'Savings', [address(19, 3, 'Invoice'), address(19, 0, 'Savings')]),
  account(0, 'Primary', [address(0, 1), address(0, 0, 'Primary')]),
  account(2, '', [address(2, 0)]),
] });

// These fixtures intentionally include empty accounts that have never appeared in history.
test('every native account and primary address remains visible, including the selected row', () => {
  const value = catalog();
  assert.deepEqual(value.accounts.map(group => group.accountIndex), [0, 2, 19]);
  const all = receiveCatalogAddresses(value);
  assert.equal(all.length, 5);
  assert.equal(value.accounts[2].label, 'Savings');
  assert.deepEqual(value.accounts.map(group => group.addresses[0].addressIndex), [0, 0, 0]);
  const selected = selectedReceiveAddress(value, { accountIndex: 19, addressIndex: 3 });
  assert.equal(selected?.address, 'fixture-19-3');
  assert.equal(all.filter(row => row === selected).length, 1);
});

test('selection identifies an address by its account and address index together', () => {
  const value = catalog();
  assert.equal(selectedReceiveAddress(value, { accountIndex: 2, addressIndex: 0 })?.address, 'fixture-2-0');
  assert.equal(selectedReceiveAddress(value, { accountIndex: 19, addressIndex: 0 })?.address, 'fixture-19-0');
  assert.equal(selectedReceiveAddress(value, { accountIndex: 19, addressIndex: 999 })?.address, 'fixture-19-0');
  assert.equal(selectedReceiveAddress(value, { accountIndex: 999, addressIndex: 3 })?.address, 'fixture-0-0');
  assert.equal(selectedReceiveAddress(null, { accountIndex: 0, addressIndex: 0 }), undefined);
});

test('refresh preserves an exact selected address while discovering additional accounts', () => {
  const value = catalog();
  const preferred = { accountIndex: 19, addressIndex: 3 };
  const refreshed = parseReceiveAddressCatalog({ accounts: [...value.accounts, account(25)] });
  assert.equal(selectedReceiveAddress(refreshed, preferred)?.address, selectedReceiveAddress(value, preferred)?.address);
  assert.equal(receiveCatalogAddresses(refreshed).length, 6);
});

test('a malformed or incomplete account cannot produce a deceptively partial catalog', () => {
  for (const accounts of [
    [], [account(0), account(0)], [account(0, '', [])],
    [account(0, '', [address(1, 0)])],
    [account(0, '', [address(0, 1)])],
    [account(0, '', [address(0, 0), address(0, 0)])],
    [{ ...account(0), unlockedBalanceAtomic: '1' }],
    [{ ...account(0), balanceAtomic: '18446744073709551616' }],
  ]) assert.throws(() => parseReceiveAddressCatalog({ accounts }));
});

test('an in-flight old wallet catalog cannot overwrite the newly selected wallet', async () => {
  const loader = new SendSnapshotLoader();
  loader.setScope('wallet-a');
  let release;
  const old = loader.load(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  loader.setScope('wallet-b');
  const next = loader.load(async () => parseReceiveAddressCatalog({ accounts: [account(5)] }));
  release(catalog());
  assert.equal(await old, undefined);
  assert.deepEqual((await next).accounts.map(group => group.accountIndex), [5]);
});

test('switching away and back still rejects a catalog from an earlier wallet generation', async () => {
  const loader = new SendSnapshotLoader();
  loader.setScope('wallet-a');
  let release;
  const old = loader.load(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  loader.setScope('wallet-b');
  loader.setScope('wallet-a');
  const next = loader.load(async () => parseReceiveAddressCatalog({ accounts: [account(7)] }));
  release(catalog());
  assert.equal(await old, undefined);
  assert.deepEqual((await next).accounts.map(group => group.accountIndex), [7]);
});
