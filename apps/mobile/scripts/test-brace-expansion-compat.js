'use strict';

const assert = require('node:assert/strict');
const braceExpansion = require('brace-expansion');

assert.equal(typeof braceExpansion, 'function');
assert.equal(braceExpansion.expand, braceExpansion);
assert.deepEqual(braceExpansion('wallet-{one,two}'), [
  'wallet-one',
  'wallet-two',
]);

const longInput = '{a,b}'.repeat(1500);
const expanded = braceExpansion.expand(longInput);
const totalLength = expanded.reduce((total, value) => total + value.length, 0);
assert.ok(totalLength <= 4_000_000);
