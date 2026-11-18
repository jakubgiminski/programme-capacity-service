const fs = require('node:fs');

const swc = JSON.parse(fs.readFileSync(`${__dirname}/.swcrc`, 'utf8'));
const transform = { '^.+\\.ts$': ['@swc/jest', { ...swc, swcrc: false }] };

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      transform,
      rootDir: __dirname,
      roots: ['<rootDir>/src'],
      testMatch: ['**/*.spec.ts'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      transform,
      rootDir: __dirname,
      roots: ['<rootDir>/test'],
      testMatch: ['**/*.int-spec.ts', '**/*.e2e-spec.ts'],
      globalSetup: '<rootDir>/test/support/global-setup.ts',
      globalTeardown: '<rootDir>/test/support/global-teardown.ts',
      testTimeout: 60_000,
      slowTestThreshold: 30,
    },
  ],
};
