/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

jest.mock('../src/data/priceService', () => ({
  useXmrPrice: () => ({ price: 100, change24h: 0, loading: false }),
  useXmrChart: () => ({ points: [99, 100, 101], loading: false }),
  xmrToUsd: (xmr: number, price: number) => (xmr * price).toFixed(2),
}));

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
