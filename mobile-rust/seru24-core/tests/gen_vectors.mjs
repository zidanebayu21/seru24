// Generator vektor uji silang TypeScript -> Rust (Fase 1, Gerbang 1).
// Menggunakan nilai uji karangan (bukan rahasia produksi). Jalankan dari `mobile-rust/seru24-core`:
//   node tests/gen_vectors.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createKeyBackup,
  deriveConversationKey,
  derivePasswordSecrets,
  encryptMessage,
  safetyCode,
  toBase64,
  toBase64Url,
} from '../../../web/shared/crypto.ts';
import { x25519 } from '../../../web/node_modules/@noble/curves/ed25519.js';
import { transportKeyId, sealResponse, openRequest } from '../../../web/shared/transport.ts';
import { sealBackup } from '../../../web/shared/backup-core.ts';
import { buildEndpointName, contactTag } from '../../../web/shared/nearby-core.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const aliceSecret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const bobSecret = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const serverSecret = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 13) & 0xff);

const alicePub = x25519.getPublicKey(aliceSecret);
const bobPub = x25519.getPublicKey(bobSecret);
const serverPub = x25519.getPublicKey(serverSecret);

const conversationId = '11111111-2222-4333-8444-555555555555';
const aliceId = 'aaaaaaaa-0000-4000-8000-000000000001';
const bobId = 'bbbbbbbb-0000-4000-8000-000000000002';

const convKeyAlice = deriveConversationKey(
  aliceSecret,
  bobPub,
  conversationId,
  { userId: aliceId, keyVersion: 1 },
  { userId: bobId, keyVersion: 2 },
);
const convKeyBob = deriveConversationKey(
  bobSecret,
  alicePub,
  conversationId,
  { userId: bobId, keyVersion: 2 },
  { userId: aliceId, keyVersion: 1 },
);
if (toBase64(convKeyAlice) !== toBase64(convKeyBob)) {
  throw new Error('Kunci percakapan Alice dan Bob tidak identik!');
}

// Kata sandi sengaja mengandung karakter kompatibilitas NFKC (Fullwidth + ligature)
const passwordRaw = 'ｓｅｒｕ24-Ｋｕｎｃｉ-ﬁ-Ｕｊｉ-99!';
const authSaltB64 = toBase64(Uint8Array.from({ length: 16 }, (_, i) => i + 10));
const pwSecrets = await derivePasswordSecrets(passwordRaw, authSaltB64);

const msgCtx = {
  conversationId,
  senderId: aliceId,
  clientMsgId: 'cccccccc-0000-4000-8000-000000000003',
  kind: 'text',
};
const encryptedText = encryptMessage(convKeyAlice, { t: 'Halo Rust 🇮🇩 👍🏽 👨‍👩‍👧' }, msgCtx);

const fileCtx = {
  conversationId,
  senderId: bobId,
  clientMsgId: 'dddddddd-0000-4000-8000-000000000004',
  kind: 'file',
};
const fileBody = {
  id: 'eeeeeeee-0000-4000-8000-000000000005',
  name: 'laporan-uji.pdf',
  mime: 'application/pdf',
  size: 123456,
  key: toBase64(Uint8Array.from({ length: 32 }, (_, i) => i + 50)),
  iv: toBase64(Uint8Array.from({ length: 12 }, (_, i) => i + 90)),
};
const encryptedFile = encryptMessage(convKeyBob, { f: fileBody }, fileCtx);

const keyring = { 1: aliceSecret, 2: bobSecret };
const keyBackup = createKeyBackup(keyring, pwSecrets.wrapKey, aliceId, authSaltB64);

const chatBackupText = sealBackup(
  { 2: aliceSecret, 10: bobSecret },
  aliceId,
  {
    exportedAt: '2026-11-20T07:00:00.000Z',
    conversations: [
      {
        id: conversationId,
        status: 'accepted',
        requested_by: aliceId,
        last_message_at: '2026-11-20T07:00:00.000Z',
        unread: 0,
        muted: false,
        archived: false,
        pinned: true,
        peer_id: bobId,
        peer_username: 'budi_uji',
        peer_display_name: 'Budi Uji',
        peer_blocked: false,
      },
    ],
    messages: [],
  },
);

const keyId = transportKeyId(serverPub);
const serverReqKey = Uint8Array.from({ length: 32 }, (_, i) => 33 + i);
const sampleRespToken = sealResponse({ ok: true, ping: 'pong' }, serverReqKey, 'req-ts-1');
// Verifikasi internal agar openRequest ikut teruji
void openRequest;

const vectors = {
  alice_secret_b64: toBase64(aliceSecret),
  alice_public_b64: toBase64(alicePub),
  bob_secret_b64: toBase64(bobSecret),
  bob_public_b64: toBase64(bobPub),
  conversation_id: conversationId,
  alice_id: aliceId,
  bob_id: bobId,
  conversation_key_b64: toBase64(convKeyAlice),
  safety_code: safetyCode(alicePub, bobPub),
  password_raw: passwordRaw,
  auth_salt_b64: authSaltB64,
  auth_secret: pwSecrets.authSecret,
  wrap_key_b64: toBase64(pwSecrets.wrapKey),
  text_msg_ctx: msgCtx,
  encrypted_text: encryptedText,
  text_expected: 'Halo Rust 🇮🇩 👍🏽 👨‍👩‍👧',
  file_msg_ctx: fileCtx,
  encrypted_file: encryptedFile,
  file_expected: fileBody,
  key_backup: keyBackup,
  chat_backup_text: chatBackupText,
  server_secret_b64: toBase64(serverSecret),
  server_public_b64: toBase64(serverPub),
  server_public_b64url: toBase64Url(serverPub),
  transport_key_id: keyId,
  server_res_key_b64: toBase64(serverReqKey),
  sample_response_compact: sampleRespToken,
  sample_response_req_id: 'req-ts-1',
  nearby_contact_tag: contactTag(conversationId, aliceId),
  nearby_endpoint_name: buildEndpointName({
    alias: 'Anonim-AB12',
    id: 'deadbeef',
    tags: [contactTag(conversationId, aliceId)],
  }),
};

const outPath = path.join(__dirname, 'vectors.json');
fs.writeFileSync(outPath, JSON.stringify(vectors, null, 2));
console.log('Wrote', outPath);
