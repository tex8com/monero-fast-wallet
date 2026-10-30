import { readFileSync } from 'fs';
import { resolve } from 'path';

const sendSource = readFileSync(
  resolve(__dirname, '..', '..', 'screens', 'SendScreen.tsx'),
  'utf8',
);

describe('Send amount UI contract', () => {
  it('uses a native editable amount field so XMR values can be pasted', () => {
    expect(sendSource).toContain('<TextInput');
    expect(sendSource).toContain('inputMode="decimal"');
    expect(sendSource).toContain('onChangeText={updateAmount}');
    expect(sendSource).toContain(
      'sanitizePaymentAmountInput(value, amountCurrency)',
    );
  });

  it('keeps the reviewed amount and XMR unit on one line', () => {
    expect(sendSource).toContain('adjustsFontSizeToFit');
    expect(sendSource).toContain('numberOfLines={1}');
    expect(sendSource).toContain('{reviewAmount} XMR');
  });
});
