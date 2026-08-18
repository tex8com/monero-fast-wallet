/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

jest.mock('../src/data/priceService', () => ({
  useXmrPrice: () => ({ price: 100, change24h: 0, loading: false }),
  useXmrChart: () => ({
    points: [
      { timestamp: 1_784_000_000_000, price: 99 },
      { timestamp: 1_784_003_600_000, price: 100 },
      { timestamp: 1_784_007_200_000, price: 101 },
    ],
    loading: false,
    error: false,
    refresh: jest.fn(),
  }),
  xmrToUsd: (xmr: number, price: number) => (xmr * price).toFixed(2),
}));

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
