'use strict';

const assert = require('node:assert/strict');
const braces = require('braces');

const isControlledDepthError = error =>
  /exceeds max depth/u.test(String(error && error.message));

assert.throws(
  () => braces.parse('('.repeat(101) + 'wallet' + ')'.repeat(101)),
  isControlledDepthError,
);

let ast = {type: 'text', value: 'wallet'};
for (let depth = 0; depth < 101; depth += 1) {
  ast = {type: 'brace', nodes: [ast]};
}
ast = {type: 'root', nodes: [ast]};

assert.throws(() => braces.compile(ast), isControlledDepthError);
assert.throws(() => braces.stringify(ast), isControlledDepthError);
assert.throws(() => braces.expand(ast), isControlledDepthError);

const cyclic = {type: 'paren', nodes: [{type: 'text', value: 'wallet'}]};
cyclic.parent = cyclic;
assert.throws(
  () => braces.expand(cyclic),
  error => /parent chain contains a cycle/u.test(String(error && error.message)),
);

assert.deepEqual(braces.expand('wallet-{one,two}'), ['wallet-one', 'wallet-two']);
