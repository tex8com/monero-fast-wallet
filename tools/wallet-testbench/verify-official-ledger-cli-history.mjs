#!/usr/bin/env node

import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const evidence = resolve(
  root,
  'docs/reference-evidence/ledger-nano-x-official-gui-2026-08-09',
);

function usage() {
  console.error(
    'usage: verify-official-ledger-cli-history.mjs <account-index> <bridge-output> <sanitized-report>',
  );
  process.exit(2);
}

if (process.argv.length !== 5) usage();

const [accountIndex, outputFile, reportFile] = process.argv.slice(2);
assert.match(accountIndex, /^(?:0|[1-9][0-9]*)$/);

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

function rowsForAccount() {
  const reference = JSON.parse(readFileSync(resolve(evidence, 'reference.json'), 'utf8'));
  const exportRecord = reference.official_transaction_exports.find(
    record => String(record.account_index) === accountIndex,
  );
  assert.ok(exportRecord, `no official export for account ${accountIndex}`);
  const lines = readFileSync(resolve(evidence, exportRecord.file), 'utf8')
    .trim()
    .split(/\r?\n/);
  const columns = parseCsvRow(lines.shift());
  return lines.map(line => Object.fromEntries(
    columns.map((column, index) => [column, parseCsvRow(line)[index]]),
  ));
}

function bridgeTransactions() {
  const values = [];
  let current = {};
  const metadata = {};
  for (const line of readFileSync(outputFile, 'utf8').split(/\r?\n/)) {
    if (line === '---') {
      if (Object.keys(current).length > 0) values.push(current);
      current = {};
      continue;
    }
    const delimiter = line.indexOf('=');
    if (delimiter < 1) continue;
    const key = line.slice(0, delimiter);
    const value = line.slice(delimiter + 1);
    if (/^(txid|direction|amount_atomic|fee_atomic|block_height|account_index)$/.test(key)) {
      current[key] = value;
    } else if (key.startsWith('refresh_')) {
      metadata[key] = value;
    }
  }
  return {metadata, values};
}

const expected = rowsForAccount().map(row => ({
  txid: row.txid,
  direction: row.direction,
  amount_atomic: row.atomicAmount,
  fee_atomic: row.fee === '' ? '0' : (
    BigInt(row.fee.replace('.', '')).toString()
  ),
  block_height: row.blockHeight,
})).sort((left, right) => left.txid.localeCompare(right.txid));

const {metadata, values} = bridgeTransactions();
const actual = values.map(transaction => ({
  txid: transaction.txid,
  direction: transaction.direction,
  amount_atomic: transaction.amount_atomic,
  fee_atomic: transaction.fee_atomic,
  block_height: transaction.block_height,
})).sort((left, right) => left.txid.localeCompare(right.txid));

assert.equal(metadata.refresh_synchronized, 'true', 'bridge refresh did not synchronize');
assert.deepEqual(actual, expected, `account ${accountIndex} CLI history differs from official export`);

// The retained report intentionally contains no transaction identifiers,
// addresses, keys, seeds or transport identifiers.  Full details stay in the
// encrypted/private test directory and in the integrity-pinned reference CSV.
const report = {
  schema: 'tex8.official-ledger-cli-history-verification.v1',
  official_account_index: Number(accountIndex),
  expected_transaction_count: expected.length,
  actual_transaction_count: actual.length,
  transactions_exact_match: true,
  refresh: metadata,
};
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, {mode: 0o600});
console.log(`official_ledger_cli_history_verified=account_${accountIndex}`);
