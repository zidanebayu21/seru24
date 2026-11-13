// Hermes belum tentu menyediakan TextDecoder; shared/crypto.ts dan shared/transport.ts memakainya untuk UTF-8.
if (typeof globalThis.TextDecoder === 'undefined') {
  class Utf8Decoder {
    decode(input?: Uint8Array): string {
      if (!input) return '';
      let out = '';
      for (let i = 0; i < input.length; ) {
        const byte = input[i++]!;
        let code = byte;
        if (byte >= 0xf0) {
          code = ((byte & 0x07) << 18) | ((input[i++]! & 0x3f) << 12) | ((input[i++]! & 0x3f) << 6) | (input[i++]! & 0x3f);
        } else if (byte >= 0xe0) {
          code = ((byte & 0x0f) << 12) | ((input[i++]! & 0x3f) << 6) | (input[i++]! & 0x3f);
        } else if (byte >= 0xc0) {
          code = ((byte & 0x1f) << 6) | (input[i++]! & 0x3f);
        }
        out += String.fromCodePoint(code);
      }
      return out;
    }
  }
  (globalThis as unknown as { TextDecoder: unknown }).TextDecoder = Utf8Decoder;
}
