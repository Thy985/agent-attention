module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  testPathIgnorePatterns: ['<rootDir>/node_modules', '<rootDir>/../TeamMind'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: 'coverage',
};
