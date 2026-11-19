describe('mobile polyfills', () => {
  const originalDecoder = globalThis.TextDecoder;

  afterEach(() => {
    (globalThis as any).TextDecoder = originalDecoder;
  });

  it('memasang Utf8Decoder fallback saat TextDecoder tidak tersedia', () => {
    delete (globalThis as any).TextDecoder;
    jest.isolateModules(() => {
      require('../src/polyfills');
    });

    const Decoder = (globalThis as any).TextDecoder;
    expect(Decoder).toBeDefined();

    const decoder = new Decoder();
    expect(decoder.decode()).toBe('');
    expect(decoder.decode(new Uint8Array())).toBe('');

    const ascii = new Uint8Array([72, 101, 108, 108, 111]);
    expect(decoder.decode(ascii)).toBe('Hello');

    const twoByte = new Uint8Array([0xc3, 0xa9]);
    expect(decoder.decode(twoByte)).toBe('é');

    const threeByte = new Uint8Array([0xe4, 0xb8, 0xad]);
    expect(decoder.decode(threeByte)).toBe('中');

    const fourByte = new Uint8Array([0xf0, 0x9f, 0x91, 0x8b]);
    expect(decoder.decode(fourByte)).toBe('👋');
  });
});
