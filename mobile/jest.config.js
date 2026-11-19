module.exports = {
  preset: '@react-native/jest-preset',
  moduleDirectories: ['node_modules', '<rootDir>/node_modules'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble|@supabase)/)',
  ],
  // Test mobile ada di __tests__/ (dibaca SonarQube lewat sonar.tests); laporan lcov untuk coverage.
  testMatch: ['<rootDir>/__tests__/**/*.test.[jt]s?(x)'],
  collectCoverageFrom: ['src/lib/**/*.ts'],
  coverageReporters: ['text-summary', 'lcov'],
};
