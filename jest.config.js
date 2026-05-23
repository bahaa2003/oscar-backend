/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.js', '**/src/tests/**/*.test.js'],
    testTimeout: 60000, // mongodb-memory-server can be slow on first run
    // Let Jest handle the global setup/teardown
    globalSetup: './src/tests/globalSetup.js',
    globalTeardown: './src/tests/globalTeardown.js',
    // Each test file gets fresh module state
    clearMocks: true,
    resetModules: false,
    // Verbose output for financial test cases
    verbose: true,
};
