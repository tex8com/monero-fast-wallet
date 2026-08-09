import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const evidence = resolve(
  root,
  'docs/reference-evidence/ledger-nano-x-official-gui-2026-08-09',
);
const reference = JSON.parse(readFileSync(resolve(evidence, 'reference.json'), 'utf8'));

const requiredColumns = [
  'blockHeight',
  'epoch',
  'date',
  'direction',
  'amount',
  'atomicAmount',
  'fee',
  'txid',
  'label',
  'subaddrAccount',
  'paymentId',
  'description',
];

function parseCsvRow(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      cells.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  assert.equal(quoted, false, 'CSV must not end inside a quoted cell');
  cells.push(value);
  return cells;
}

function readExport(file) {
  const lines = readFileSync(resolve(evidence, file), 'utf8')
    .trim()
    .split(/\r?\n/);
  const columns = parseCsvRow(lines.shift());
  assert.deepEqual(columns, requiredColumns, 'official CSV header drifted');
  return lines.map(line => Object.fromEntries(
    columns.map((column, index) => [column, parseCsvRow(line)[index]]),
  ));
}

function toAtomic(amount) {
  const [whole, fraction = ''] = amount.split('.');
  return (BigInt(whole) * 1_000_000_000_000n) +
    BigInt((fraction + '000000000000').slice(0, 12));
}

function expectedTransactions(accountIndex) {
  return reference.transactions
    .filter(transaction => transaction.account_index === accountIndex)
    .map(transaction => ({
      direction: transaction.direction === 'received' ? 'in' : 'out',
      atomicAmount: toAtomic(transaction.amount_xmr_visible).toString(),
    }))
    .sort((left, right) =>
      `${left.direction}:${left.atomicAmount}`.localeCompare(
        `${right.direction}:${right.atomicAmount}`,
      ));
}

function actualTransactions(rows) {
  return rows
    .map(row => ({direction: row.direction, atomicAmount: row.atomicAmount}))
    .sort((left, right) =>
      `${left.direction}:${left.atomicAmount}`.localeCompare(
        `${right.direction}:${right.atomicAmount}`,
      ));
}

function expectedBalance(accountIndex) {
  return toAtomic(reference.accounts.find(account => account.index === accountIndex).balance_xmr);
}

function calculatedBalance(rows) {
  return rows.reduce((total, row) => {
    const signedAmount = row.direction === 'in'
      ? toAtomic(row.amount)
      : -(toAtomic(row.amount) + toAtomic(row.fee));
    return total + signedAmount;
  }, 0n);
}

test('official Nano Ledger X CSV exports are complete and integrity-pinned', () => {
  assert.equal(reference.schema, 'tex8.official-ledger-gui-reference.v2');
  assert.equal(reference.source.application, 'Official Monero GUI');
  assert.equal(reference.source.network, 'mainnet');
  assert.equal(reference.official_transaction_exports.length, 2);

  for (const exportRecord of reference.official_transaction_exports) {
    const rows = readExport(exportRecord.file);
    assert.equal(rows.length, exportRecord.data_rows);
    assert.equal(rows.length, reference.accounts.find(
      account => account.index === exportRecord.account_index,
    ).transactions_visible);
    for (const row of rows) {
      assert.match(row.blockHeight, /^[1-9][0-9]*$/);
      assert.match(row.epoch, /^[1-9][0-9]*$/);
      assert.match(row.date, /\S/);
      assert.match(row.direction, /^(?:in|out)$/);
      assert.match(row.amount, /^[0-9]+\.[0-9]{12}$/);
      assert.equal(row.atomicAmount, toAtomic(row.amount).toString());
      assert.match(row.fee, /^[0-9]+\.[0-9]{12}$/);
      assert.match(row.txid, /^[a-f0-9]{64}$/);
      assert.equal(row.subaddrAccount, String(exportRecord.account_index));
    }
  }
});

test('official exports match every screenshot-visible transaction and balance', () => {
  for (const exportRecord of reference.official_transaction_exports) {
    const rows = readExport(exportRecord.file);
    assert.deepEqual(
      actualTransactions(rows),
      expectedTransactions(exportRecord.account_index),
      `account ${exportRecord.account_index} export differs from the screenshot baseline`,
    );
    assert.equal(
      calculatedBalance(rows),
      expectedBalance(exportRecord.account_index),
      `account ${exportRecord.account_index} exported history does not reproduce its balance`,
    );
  }
});

test('all 15 official transaction rows form one complete comparison fixture', () => {
  const rows = reference.official_transaction_exports.reduce(
    (total, exportRecord) => total + readExport(exportRecord.file).length,
    0,
  );
  assert.equal(rows, 15);
  assert.equal(
    reference.official_transaction_exports.reduce(
      (total, exportRecord) => total + exportRecord.data_rows,
      0,
    ),
    reference.transactions.length,
  );
});
