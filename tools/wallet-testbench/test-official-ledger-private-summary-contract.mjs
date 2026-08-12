import assert from 'node:assert/strict';
import test from 'node:test';
import {parsePrivateReferenceSummary} from './official-ledger-private-summary.mjs';

const address0 = '4'.repeat(95);
const address1 = '8'.repeat(95);

function output({firstBalance = '4', secondBalance = '9'} = {}) {
  return [
    'reference_private_summary_begin',
    'account_index=0',
    `address=${address0}`,
    `balance_atomic=${firstBalance}`,
    'unlocked_balance_atomic=3',
    '---',
    'account_index=1',
    `address=${address1}`,
    `balance_atomic=${secondBalance}`,
    'unlocked_balance_atomic=7',
    '---',
    'reference_private_summary_end',
  ].join('\n');
}

test('private reference summary retains only both addresses and exact balances', () => {
  const summary = parsePrivateReferenceSummary(output());
  assert.equal(summary.schema, 'tex8.official-ledger-reference-private-summary.v1');
  assert.deepEqual(summary.accounts.map(account => account.account_index), [0, 1]);
  assert.equal(summary.accounts[0].address, address0);
  assert.equal(summary.accounts[1].address, address1);
  assert.equal(summary.total_balance_atomic, '13');
  assert.equal(summary.total_unlocked_balance_atomic, '10');
  assert.doesNotMatch(JSON.stringify(summary), /seed|key|transaction|txid|password/i);
});

test('private reference summary fails closed for malformed or incomplete data', () => {
  assert.throws(() => parsePrivateReferenceSummary('reference_private_summary_begin\n'));
  assert.throws(() => parsePrivateReferenceSummary(output().replace(address1, 'invalid')));
  assert.throws(() => parsePrivateReferenceSummary(output({secondBalance: '9x'})));
});
