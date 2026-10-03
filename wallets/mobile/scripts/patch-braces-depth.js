#!/usr/bin/env node

const {readFileSync, writeFileSync} = require('node:fs');
const {resolve} = require('node:path');

const root = resolve(__dirname, '../node_modules/braces/lib');

function patch(relativePath, replacements) {
  const file = resolve(root, relativePath);
  let source = readFileSync(file, 'utf8');
  for (const [before, after] of replacements) {
    if (source.includes(after)) continue;
    if (!source.includes(before)) {
      throw new Error(`Unsupported braces layout in ${relativePath}; review the depth patch.`);
    }
    source = source.replace(before, after);
  }
  writeFileSync(file, source);
}

patch('constants.js', [
  [
    "module.exports = {\n  MAX_LENGTH: 10000,",
    "module.exports = {\n  MAX_DEPTH: 100,\n  MAX_LENGTH: 10000,",
  ],
]);

patch('parse.js', [
  [
    "const {\n  MAX_LENGTH,",
    "const {\n  MAX_DEPTH,\n  MAX_LENGTH,",
  ],
  [
    "  const max = typeof opts.maxLength === 'number' ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;\n  if (input.length > max)",
    "  const max = typeof opts.maxLength === 'number' ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;\n  const maxDepth = Number.isFinite(opts.maxDepth) ? Math.min(MAX_DEPTH, opts.maxDepth) : MAX_DEPTH;\n  if (input.length > max)",
  ],
  [
    "  let depth = 0;\n  let value;",
    "  let depth = 0;\n  let nesting = 0;\n  let value;",
  ],
  [
    "    if (value === CHAR_LEFT_PARENTHESES) {\n      block = push({ type: 'paren', nodes: [] });",
    "    if (value === CHAR_LEFT_PARENTHESES) {\n      if (nesting + 1 > maxDepth) {\n        throw new SyntaxError(`Input depth (${nesting + 1}), exceeds max depth (${maxDepth})`);\n      }\n      nesting++;\n      block = push({ type: 'paren', nodes: [] });",
  ],
  [
    "      block = stack.pop();\n      push({ type: 'text', value });\n      block = stack[stack.length - 1];",
    "      block = stack.pop();\n      push({ type: 'text', value });\n      nesting--;\n      block = stack[stack.length - 1];",
  ],
  [
    "    if (value === CHAR_LEFT_CURLY_BRACE) {\n      depth++;",
    "    if (value === CHAR_LEFT_CURLY_BRACE) {\n      if (nesting + 1 > maxDepth) {\n        throw new SyntaxError(`Input depth (${nesting + 1}), exceeds max depth (${maxDepth})`);\n      }\n      nesting++;\n      depth++;",
  ],
  [
    "      push({ type, value });\n      depth--;\n\n      block = stack[stack.length - 1];",
    "      push({ type, value });\n      depth--;\n      nesting--;\n\n      block = stack[stack.length - 1];",
  ],
]);

patch('compile.js', [
  [
    "const utils = require('./utils');\n\nconst compile",
    "const utils = require('./utils');\nconst { MAX_DEPTH } = require('./constants');\n\nconst compile",
  ],
  [
    "const compile = (ast, options = {}) => {\n  const walk = (node, parent = {}) => {",
    "const compile = (ast, options = {}) => {\n  const maxDepth = Number.isFinite(options.maxDepth) ? Math.min(MAX_DEPTH, options.maxDepth) : MAX_DEPTH;\n\n  const walk = (node, parent = {}, depth = 0) => {\n    if (node.nodes && depth > maxDepth) {\n      throw new RangeError(`AST depth (${depth}), exceeds max depth (${maxDepth})`);\n    }",
  ],
  ["output += walk(child, node);", "output += walk(child, node, child.nodes ? depth + 1 : depth);"],
  ["  return walk(ast);", "  return walk(ast, {}, ast.type === 'root' ? 0 : 1);"],
]);

patch('stringify.js', [
  [
    "const utils = require('./utils');\n\nmodule.exports",
    "const utils = require('./utils');\nconst { MAX_DEPTH } = require('./constants');\n\nmodule.exports",
  ],
  [
    "module.exports = (ast, options = {}) => {\n  const stringify = (node, parent = {}) => {",
    "module.exports = (ast, options = {}) => {\n  const maxDepth = Number.isFinite(options.maxDepth) ? Math.min(MAX_DEPTH, options.maxDepth) : MAX_DEPTH;\n\n  const stringify = (node, parent = {}, depth = 0) => {\n    if (node.nodes && depth > maxDepth) {\n      throw new RangeError(`AST depth (${depth}), exceeds max depth (${maxDepth})`);\n    }",
  ],
  ["output += stringify(child);", "output += stringify(child, node, child.nodes ? depth + 1 : depth);"],
  ["  return stringify(ast);", "  return stringify(ast, {}, ast.type === 'root' ? 0 : 1);"],
]);

patch('expand.js', [
  [
    "const utils = require('./utils');\n\nconst append",
    "const utils = require('./utils');\nconst { MAX_DEPTH } = require('./constants');\n\nconst append",
  ],
  [
    "  return utils.flatten(result);\n};\n\nconst expand = (ast, options = {}) => {",
    "  return utils.flatten(result);\n};\n\nconst queueOwner = node => {\n  if (node.type === 'brace' || node.type === 'root' || !node.parent) return node;\n\n  const seen = new Set();\n  while (node.type !== 'brace' && node.type !== 'root' && node.parent) {\n    if (seen.has(node)) {\n      throw new RangeError('AST parent chain contains a cycle');\n    }\n    seen.add(node);\n    node = node.parent;\n  }\n  return node;\n};\n\nconst expand = (ast, options = {}) => {",
  ],
  [
    "const expand = (ast, options = {}) => {\n  const rangeLimit = options.rangeLimit === undefined ? 1000 : options.rangeLimit;\n\n  const walk = (node, parent = {}) => {",
    "const expand = (ast, options = {}) => {\n  const rangeLimit = options.rangeLimit === undefined ? 1000 : options.rangeLimit;\n  const maxDepth = Number.isFinite(options.maxDepth) ? Math.min(MAX_DEPTH, options.maxDepth) : MAX_DEPTH;\n\n  const walk = (node, parent = {}, depth = 0) => {\n    if (node.nodes && depth > maxDepth) {\n      throw new RangeError(`AST depth (${depth}), exceeds max depth (${maxDepth})`);\n    }",
  ],
  [
    "    let p = parent;\n    let q = parent.queue;\n\n    while (p.type !== 'brace' && p.type !== 'root' && p.parent) {\n      p = p.parent;\n      q = p.queue;\n    }",
    "    const q = queueOwner(parent).queue;",
  ],
  [
    "    let queue = node.queue;\n    let block = node;\n\n    while (block.type !== 'brace' && block.type !== 'root' && block.parent) {\n      block = block.parent;\n      queue = block.queue;\n    }",
    "    const queue = queueOwner(node).queue;",
  ],
  ["        walk(child, node);", "        walk(child, node, child.nodes ? depth + 1 : depth);"],
  ["  return utils.flatten(walk(ast));", "  return utils.flatten(walk(ast, {}, ast.type === 'root' ? 0 : 1));"],
]);
