import {
  parseVanityRecoveryBackup,
  stripVanityRecoverySecrets,
} from '../VanityServiceClient';

const SOURCE =
  '42XMRKeyontWE7QwjNqswz4K27f2FcQnxKHYwz3Usq1QfqikSwtE4qKQQeMs9bsPoEJf5rb2mWgcsdHo9o1Lqs3USmLqDUv';
const RESULT =
  '49indexNameRuJZKgFL42yi11NgwYn3pzgf45HvvbEpCZq29KfQknnUM6xaptUokNsjh8TRghjr94ioSN2ZNhePm1vzJLQJ';
const OFFSET = '12'.repeat(32);

function backup(overrides: Record<string, unknown> = {}) {
  return `MFW Vanity recovery v1\n${JSON.stringify({
    version: 1,
    kind: 'mfw-monero-vanity-split-recovery-v1',
    orderId: '12345678-1234-1234-1234-123456789abc',
    sourceWalletRegistrationId: 'wallet-1',
    sourcePublicAddress: SOURCE,
    results: [
      {
        matchedPrefix: '49i',
        resultAddress: RESULT,
        keyOffsetHex: '12'.repeat(32),
      },
    ],
    createdAt: 1_777_777_777_777,
    ...overrides,
  })}\n`;
}

describe('Vanity recovery backup', () => {
  it('removes key offsets before an order enters React state', () => {
    const order = {
      id: '12345678-1234-1234-1234-123456789abc',
      status: 'completed',
      prefixes: ['49'],
      price_atomic: '1',
      price_xmr: '0.000000000001',
      payment_address: RESULT,
      quote_expires_at: 1,
      observed_atomic: '1',
      confirmations: 1,
      required_confirmations: 1,
      active_prefix_slots: 1,
      maximum_prefix_slots: 2000,
      search_groups: [
        {
          id: 'group',
          status: 'completed',
          prefix_length: 2,
          prefixes: ['49'],
          price_atomic: '1',
          matched_prefix: '49',
          result_address: RESULT,
          result_key_offset: OFFSET,
          maximum_search_seconds: 60,
          candidates: [
            {
              id: 'candidate',
              prefix: '49',
              status: 'completed',
              result_address: RESULT,
              result_key_offset: OFFSET,
            },
          ],
        },
      ],
    } as const;
    const sanitized = stripVanityRecoverySecrets(order);
    expect(sanitized.search_groups[0].recovery_available).toBe(true);
    expect(sanitized.search_groups[0].result_key_offset).toBeUndefined();
    expect(
      sanitized.search_groups[0].candidates[0].result_key_offset,
    ).toBeUndefined();
  });
  it('round-trips the seed-bound public address and key offset', () => {
    expect(parseVanityRecoveryBackup(backup())).toMatchObject({
      sourcePublicAddress: SOURCE,
      results: [{ resultAddress: RESULT, keyOffsetHex: '12'.repeat(32) }],
    });
  });

  it('rejects zero offsets, mismatched prefixes, unknown fields, and malformed addresses', () => {
    const base = JSON.parse(backup().split('\n')[1]);
    for (const invalid of [
      {
        ...base,
        results: [{ ...base.results[0], keyOffsetHex: '00'.repeat(32) }],
      },
      { ...base, results: [{ ...base.results[0], matchedPrefix: '4MFW' }] },
      { ...base, sourcePublicAddress: 'not-an-address' },
      { ...base, unexpected: true },
    ]) {
      expect(() =>
        parseVanityRecoveryBackup(
          `MFW Vanity recovery v1\n${JSON.stringify(invalid)}\n`,
        ),
      ).toThrow('invalid');
    }
  });
});
