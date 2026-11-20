// Verifikator arah balik (Rust -> TypeScript) untuk Gerbang 1.
// Menerima JSON lewat stdin berisi ciphertext, backup, & amplop transport buatan Rust,
// lalu memverifikasi semuanya dengan modul asli web/shared/*.ts.

import {
  decryptMessage,
  deriveConversationKey,
  derivePasswordSecrets,
  fromBase64,
  openKeyBackup,
  toBase64,
} from '../../../web/shared/crypto.ts';
import { openRequest, sealResponse, transportKeyId } from '../../../web/shared/transport.ts';
import { openBackup } from '../../../web/shared/backup-core.ts';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const aliceSecret = fromBase64(input.alice_secret_b64);
const bobPub = fromBase64(input.bob_public_b64);
const serverSecret = fromBase64(input.server_secret_b64);
const serverPub = fromBase64(input.server_public_b64);

// 1. Verifikasi auth_secret & wrap_key buatan Rust identik dengan TS
const pw = await derivePasswordSecrets(input.password_raw, input.auth_salt_b64);
if (pw.authSecret !== input.rust_auth_secret) {
  throw new Error(`authSecret mismatch: ts=${pw.authSecret} rust=${input.rust_auth_secret}`);
}
if (toBase64(pw.wrapKey) !== input.rust_wrap_key_b64) {
  throw new Error('wrapKey mismatch');
}

// 2. Dekripsi pesan teks buatan Rust memakai deriveConversationKey TS
const convKey = deriveConversationKey(
  aliceSecret,
  bobPub,
  input.conversation_id,
  { userId: input.alice_id, keyVersion: 1 },
  { userId: input.bob_id, keyVersion: 2 },
);
const plain = decryptMessage(convKey, input.rust_encrypted_text, input.text_msg_ctx);
if (plain.t !== input.text_expected) {
  throw new Error(`decrypted text mismatch: ${JSON.stringify(plain)}`);
}

// 3. Buka KeyBackup buatan Rust memakai openKeyBackup TS
const restored = openKeyBackup(input.rust_key_backup, pw.wrapKey, input.alice_id);
if (toBase64(restored['1']) !== input.alice_secret_b64) {
  throw new Error('restored key_backup version 1 mismatch');
}

// 4. Buka ChatBackup buatan Rust memakai openBackup TS
const openedChatBackup = openBackup({ 2: aliceSecret }, input.alice_id, input.rust_chat_backup);
if (openedChatBackup.conversations.length !== 1 || openedChatBackup.conversations[0].id !== input.conversation_id) {
  throw new Error('opened chat_backup mismatch');
}

// 5. Buka Request Envelope buatan Rust memakai openRequest TS & balas dengan sealResponse TS
const keyId = transportKeyId(serverPub);
const openedReq = openRequest(input.rust_transport_compact, serverSecret, keyId);
if (openedReq.payload.identifier !== 'rina_uji') {
  throw new Error(`opened transport payload mismatch: ${JSON.stringify(openedReq.payload)}`);
}
const replyCompact = sealResponse({ status: 'ok', echo: openedReq.payload.identifier }, openedReq.keyRes, openedReq.requestId);

console.log(JSON.stringify({ ok: true, server_reply_compact: replyCompact, request_id: openedReq.requestId }));
