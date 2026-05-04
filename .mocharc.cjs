'use strict';
module.exports = {
  spec: 'tests/**/*.test.ts',
  timeout: 10000,
  require: ['tsx/esm', 'tests/setup.ts'],
};
