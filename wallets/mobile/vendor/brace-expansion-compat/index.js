'use strict';

const {expand} = require('brace-expansion-v5');

// minimatch 3 expects `require("brace-expansion")` to be callable, while
// minimatch 10 expects an object with an `expand` member. A function can
// safely satisfy both contracts without carrying vulnerable legacy code.
module.exports = expand;
module.exports.expand = expand;
