# seru24

Aplikasi secure chat.

- `web/` — Nuxt (deploy ke Vercel, root directory: `web`)
- `mobile/` — React Native (Expo)
- Backend: Supabase (database chat, media storage, realtime events)

## Setup

```bash
cd web && cp .env.example .env && npm install && npm run dev
cd mobile && cp .env.example .env && npm install && npm start
```

Isi `.env` dengan URL dan anon key dari project Supabase. File `.env` tidak ikut git.
