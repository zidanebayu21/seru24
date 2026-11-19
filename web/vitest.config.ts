import { defineConfig } from 'vitest/config'

// Semua test web ada di test/, dengan struktur folder sama seperti kode yang diuji (test/shared -> shared,
// test/server/utils -> server/utils). Satu sumber ini juga yang dibaca SonarQube (sonar.tests).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['shared/**/*.ts', 'server/utils/**/*.ts'],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
})
