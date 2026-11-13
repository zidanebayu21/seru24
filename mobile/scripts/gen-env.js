// Membuat src/env.ts dari .env (React Native tidak membaca .env sendiri). src/env.ts tidak ikut git.
// Hanya nilai publik yang boleh ada di sini karena ikut masuk ke APK.
const fs = require('fs');
const path = require('path');

const KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'API_BASE_URL'];
// opsional, dengan nilai bawaan (OWASP ASVS V2.1.1: minimal 12)
const DEFAULTS = { PASSWORD_MIN_LENGTH: '12' };
const envFile = path.join(__dirname, '..', '.env');

const values = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line.replace(/^﻿/, ''));
    if (match) values[match[1]] = match[2].trim();
  }
}

const missing = KEYS.filter(key => !values[key]);
if (missing.length) {
  console.error(`gen-env: nilai kosong di mobile/.env: ${missing.join(', ')}`);
  process.exit(1);
}

const strings = KEYS.map(key => `export const ${key} = ${JSON.stringify(values[key])};`);
const numbers = Object.entries(DEFAULTS).map(
  ([key, fallback]) => `export const ${key} = ${Number(values[key] || fallback)};`,
);
const body = [...strings, ...numbers].join('\n');
fs.writeFileSync(path.join(__dirname, '..', 'src', 'env.ts'), `// Dibuat otomatis oleh scripts/gen-env.js. Jangan diedit.\n${body}\n`);
console.log('gen-env: src/env.ts diperbarui');
