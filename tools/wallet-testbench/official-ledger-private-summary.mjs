function privateSummarySection(output) {
  const begin = 'reference_private_summary_begin\n';
  const end = 'reference_private_summary_end';
  const start = output.indexOf(begin);
  const finish = start < 0 ? -1 : output.indexOf(end, start);
  if (start < 0 || finish < 0) throw new Error('private summary unavailable or invalid');
  return output.slice(start + begin.length, finish);
}

export function parsePrivateReferenceSummary(output) {
  const body = privateSummarySection(output);
  const record = /account_index=([01])\naddress=([1-9A-HJ-NP-Za-km-z]{95})\nbalance_atomic=([0-9]+)\nunlocked_balance_atomic=([0-9]+)\n---\n/g;
  const accounts = [...body.matchAll(record)];
  if (accounts.length !== 2 || body.replace(record, '').trim() !== '') {
    throw new Error('private summary unavailable or invalid');
  }
  if (accounts[0][1] !== '0' || accounts[1][1] !== '1') {
    throw new Error('private summary unavailable or invalid');
  }
  const parsed = accounts.map(match => ({
    account_index: Number(match[1]),
    address: match[2],
    balance_atomic: match[3],
    unlocked_balance_atomic: match[4],
  }));
  const total = field => parsed.reduce((sum, account) => sum + BigInt(account[field]), 0n).toString();
  return {
    schema: 'tex8.official-ledger-reference-private-summary.v1',
    scope: 'accounts-0-and-1',
    accounts: parsed,
    total_balance_atomic: total('balance_atomic'),
    total_unlocked_balance_atomic: total('unlocked_balance_atomic'),
  };
}
