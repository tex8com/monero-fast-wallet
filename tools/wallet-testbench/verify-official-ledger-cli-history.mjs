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
    'usage: verify-official-ledger-cli-history.mjs <account-index> <bridge-output> <sanitized-report>\n' +
    '   or: verify-official-ledger-cli-history.mjs all <account-0-bridge-output> <account-1-bridge-output> <sanitized-report>',
  );
  process.exit(2);
}

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

const reference = JSON.parse(readFileSync(resolve(evidence, 'reference.json'), 'utf8'));

function rowsForAccount(accountIndex) {
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

export function bridgeTransactionsText(output) {
  const values = [];
  let current = {};
  const metadata = {};
  for (const line of output.split(/\r?\n/)) {
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
    } else if (key === 'transaction_count' || key.startsWith('refresh_')) {
      metadata[key] = value;
    }
  }
  return {metadata, values};
}

function bridgeTransactions(outputFile) {
  return bridgeTransactionsText(readFileSync(outputFile, 'utf8'));
}

function atomicFromXmr(value) {
  assert.match(value, /^[0-9]+\.[0-9]{12}$/, 'reference balance must be an XMR decimal');
  return BigInt(value.replace('.', ''));
}

function balanceFromHistory(transactions, label) {
  return transactions.reduce((total, transaction) => {
    assert.match(transaction.direction, /^(?:in|out)$/, `${label} has invalid direction`);
    assert.match(transaction.amount_atomic, /^[0-9]+$/, `${label} has invalid atomic amount`);
    assert.match(transaction.fee_atomic, /^[0-9]+$/, `${label} has invalid atomic fee`);
    const amount = BigInt(transaction.amount_atomic);
    const fee = BigInt(transaction.fee_atomic);
    return transaction.direction === 'in' ? total + amount : total - amount - fee;
  }, 0n);
}

function requireSynchronizedRefresh(metadata, accountIndex) {
  assert.equal(metadata.refresh_synchronized, 'true',
    `account ${accountIndex} bridge refresh did not synchronize`);
  for (const field of [
    'refresh_elapsed_ms',
    'refresh_initial_wallet_height',
    'refresh_final_wallet_height',
    'refresh_daemon_height',
    'refresh_http_bytes_received',
  ]) {
    assert.match(metadata[field] ?? '', /^[0-9]+$/,
      `account ${accountIndex} is missing a valid ${field}`);
  }
  assert.ok(
    BigInt(metadata.refresh_final_wallet_height) >= BigInt(metadata.refresh_daemon_height),
    `account ${accountIndex} refresh ended below daemon height`,
  );
}

function expectedForAccount(accountIndex) {
  return rowsForAccount(accountIndex).map(row => ({
    txid: row.txid,
    direction: row.direction,
    amount_atomic: row.atomicAmount,
    fee_atomic: row.fee === '' ? '0' : BigInt(row.fee.replace('.', '')).toString(),
    block_height: row.blockHeight,
    account_index: accountIndex,
  })).sort((left, right) => left.txid.localeCompare(right.txid));
}

function expectedBalanceForAccount(accountIndex) {
  const account = reference.accounts.find(item => String(item.index) === accountIndex);
  assert.ok(account, `no official account balance for account ${accountIndex}`);
  return atomicFromXmr(account.balance_xmr);
}

export function compareAccountText(accountIndex, output) {
  assert.match(accountIndex, /^(?:0|[1-9][0-9]*)$/);
  const expected = expectedForAccount(accountIndex);
  const {metadata, values} = bridgeTransactionsText(output);
  const actual = values.map(transaction => ({
    txid: transaction.txid,
    direction: transaction.direction,
    amount_atomic: transaction.amount_atomic,
    fee_atomic: transaction.fee_atomic,
    block_height: transaction.block_height,
    account_index: transaction.account_index,
  })).sort((left, right) => left.txid.localeCompare(right.txid));

  requireSynchronizedRefresh(metadata, accountIndex);
  assert.match(metadata.transaction_count ?? '', /^[0-9]+$/,
    `account ${accountIndex} is missing transaction_count`);
  assert.equal(BigInt(metadata.transaction_count), BigInt(actual.length),
    `account ${accountIndex} bridge transaction_count differs from listed transactions`);
  assert.deepEqual(actual, expected,
    `account ${accountIndex} CLI history differs from official export`);

  const expectedBalance = expectedBalanceForAccount(accountIndex);
  assert.equal(balanceFromHistory(expected, `reference account ${accountIndex}`), expectedBalance,
    `account ${accountIndex} official history does not reproduce its official balance`);
  const actualBalance = balanceFromHistory(actual, `CLI account ${accountIndex}`);
  assert.equal(actualBalance, expectedBalance,
    `account ${accountIndex} CLI balance differs from official balance after reconciliation`);

  return {
    accountIndex: Number(accountIndex),
    transactionCount: actual.length,
    refresh: metadata,
    actualBalance,
  };
}

function accountDiagnostic(accountIndex, output) {
  const expected = expectedForAccount(accountIndex);
  const {metadata, values} = bridgeTransactionsText(output);
  const actual = values.map(transaction => ({
    txid: transaction.txid,
    direction: transaction.direction,
    amount_atomic: transaction.amount_atomic,
    fee_atomic: transaction.fee_atomic,
    block_height: transaction.block_height,
    account_index: transaction.account_index,
  })).sort((left, right) => (left.txid ?? '').localeCompare(right.txid ?? ''));
  const refreshComplete = metadata.refresh_synchronized === 'true' && [
    'refresh_elapsed_ms',
    'refresh_initial_wallet_height',
    'refresh_final_wallet_height',
    'refresh_daemon_height',
    'refresh_http_bytes_received',
  ].every(field => /^[0-9]+$/.test(metadata[field] ?? '')) &&
    /^[0-9]+$/.test(metadata.refresh_final_wallet_height ?? '') &&
    /^[0-9]+$/.test(metadata.refresh_daemon_height ?? '') &&
    BigInt(metadata.refresh_final_wallet_height) >= BigInt(metadata.refresh_daemon_height);
  const listedCountMatches = /^[0-9]+$/.test(metadata.transaction_count ?? '') &&
    BigInt(metadata.transaction_count) === BigInt(actual.length);
  const historyExact = JSON.stringify(actual) === JSON.stringify(expected);
  let balanceParity = false;
  let balanceDeltaDirection = 'unavailable';
  try {
    const actualBalance = balanceFromHistory(actual, `CLI account ${accountIndex}`);
    const expectedBalance = expectedBalanceForAccount(accountIndex);
    balanceParity = actualBalance === expectedBalance;
    balanceDeltaDirection = actualBalance === expectedBalance
      ? 'match'
      : actualBalance < expectedBalance
        ? 'below'
        : 'above';
  } catch {
    balanceParity = false;
  }
  const expectedByTxid = new Map(expected.map(transaction => [transaction.txid, transaction]));
  const actualByTxid = new Map(actual.map(transaction => [transaction.txid, transaction]));
  const diff = {
    missing_transactions: 0,
    missing_incoming_transactions: 0,
    missing_outgoing_transactions: 0,
    unexpected_transactions: 0,
    unexpected_incoming_transactions: 0,
    unexpected_outgoing_transactions: 0,
    field_mismatch_transactions: 0,
  };
  for (const [txid, expectedTransaction] of expectedByTxid) {
    const actualTransaction = actualByTxid.get(txid);
    if (!actualTransaction) {
      diff.missing_transactions += 1;
      if (expectedTransaction.direction === 'in') diff.missing_incoming_transactions += 1;
      if (expectedTransaction.direction === 'out') diff.missing_outgoing_transactions += 1;
    } else if (JSON.stringify(actualTransaction) !== JSON.stringify(expectedTransaction)) {
      diff.field_mismatch_transactions += 1;
    }
  }
  for (const [txid, actualTransaction] of actualByTxid) {
    if (!expectedByTxid.has(txid)) {
      diff.unexpected_transactions += 1;
      if (actualTransaction.direction === 'in') diff.unexpected_incoming_transactions += 1;
      if (actualTransaction.direction === 'out') diff.unexpected_outgoing_transactions += 1;
    }
  }
  return {
    account_index: Number(accountIndex),
    expected_transaction_count: expected.length,
    actual_transaction_count: actual.length,
    refresh_complete: refreshComplete,
    listed_transaction_count_matches: listedCountMatches,
    transactions_exact_match: historyExact,
    balance_parity: balanceParity,
    balance_delta_direction: balanceDeltaDirection,
    transaction_diff: diff,
  };
}

// This diagnostics object retains only booleans and aggregate direction/count
// differences. It is used after a fail-closed comparison to identify the
// failed invariant without retaining an exception, transaction identifier,
// amount or any key data.
export function diagnoseAggregateOutputText(account0Output, account1Output) {
  const account0 = accountDiagnostic('0', account0Output);
  const account1 = accountDiagnostic('1', account1Output);
  return {
    account_0: account0,
    account_1: account1,
    total_balance_parity: account0.balance_parity && account1.balance_parity,
  };
}

function compareAccount(accountIndex, outputFile) {
  return compareAccountText(accountIndex, readFileSync(outputFile, 'utf8'));
}

function safeRefresh(metadata) {
  const allowList = new Set([
    'transaction_count',
    'refresh_synchronized',
    'refresh_elapsed_ms',
    'refresh_initial_wallet_height',
    'refresh_final_wallet_height',
    'refresh_daemon_height',
    'refresh_http_bytes_received',
  ]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => allowList.has(key)));
}

export function writeSanitizedReport(reportFile, report) {
  // This retained report intentionally contains no balance values, transaction
  // identifiers, addresses, keys, seeds, wallet paths or transport identifiers.
  // Full details remain solely in the private bridge output and the
  // integrity-pinned local reference fixture.
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, {mode: 0o600});
}

function singleAccountReport(result) {
  return {
    schema: 'tex8.official-ledger-cli-history-verification.v2',
    scope: 'single-account',
    official_account_index: result.accountIndex,
    expected_transaction_count: result.transactionCount,
    actual_transaction_count: result.transactionCount,
    transactions_exact_match: true,
    account_balance_parity: true,
    refresh: safeRefresh(result.refresh),
  };
}

export function aggregateReport(account0, account1) {
  const expectedTotal = atomicFromXmr(reference.balance_all_xmr);
  const expectedAccountTotal = expectedBalanceForAccount('0') + expectedBalanceForAccount('1');
  assert.equal(expectedAccountTotal, expectedTotal,
    'official account 0 + account 1 balances do not reproduce the official total');
  assert.equal(account0.actualBalance + account1.actualBalance, expectedTotal,
    'CLI account 0 + account 1 balance differs from official total after reconciliation');

  return {
    schema: 'tex8.official-ledger-cli-history-verification.v2',
    scope: 'accounts-0-and-1',
    official_account_indexes: [0, 1],
    expected_transaction_count: account0.transactionCount + account1.transactionCount,
    actual_transaction_count: account0.transactionCount + account1.transactionCount,
    transactions_exact_match: true,
    account_0_balance_parity: true,
    account_1_balance_parity: true,
    total_balance_parity: true,
    refresh: {
      account_0: safeRefresh(account0.refresh),
      account_1: safeRefresh(account1.refresh),
    },
  };
}

export function verifyAggregateOutputText(account0Output, account1Output) {
  return aggregateReport(
    compareAccountText('0', account0Output),
    compareAccountText('1', account1Output),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 5) {
    const [accountIndex, outputFile, reportFile] = process.argv.slice(2);
    const result = compareAccount(accountIndex, outputFile);
    writeSanitizedReport(reportFile, singleAccountReport(result));
    console.log(`official_ledger_cli_history_verified=account_${accountIndex}`);
  } else if (process.argv.length === 6 && process.argv[2] === 'all') {
    const [, account0Output, account1Output, reportFile] = process.argv.slice(2);
    const account0 = compareAccount('0', account0Output);
    const account1 = compareAccount('1', account1Output);
    writeSanitizedReport(reportFile, aggregateReport(account0, account1));
    console.log('official_ledger_cli_history_verified=accounts_0_and_1');
  } else {
    usage();
  }
}
