import { NativeModules } from 'react-native';
import { fromBase64, setScryptImplementation, toBase64, type ScryptFn } from '../../../web/shared/crypto';

interface Seru24ScryptModule {
  derive: (passwordB64: string, saltB64: string, n: number, r: number, p: number, dkLen: number) => Promise<string>;
}

const native = NativeModules.Seru24Scrypt as Seru24ScryptModule | undefined;

const nativeScrypt: ScryptFn = async (password, salt, { N, r, p, dkLen }) =>
  fromBase64(await native!.derive(toBase64(password), toBase64(salt), N, r, p, dkLen));

// RFC 7914 bagian 12, vektor ke-2: memastikan hasil native identik dengan standar (dan dengan web)
const VECTOR_EXPECTED =
  '/bq+HJ00cgB4VucZDQHp/nxq18vII3gw53N2Y0s3MWIurzDZLiKjiG/xCSedmDDaxyevuUqD7m2DYMvfoswGQA==';

/** Pasang scrypt native bila tersedia dan lolos vektor uji; bila tidak, tetap pakai versi JavaScript. */
export const installNativeScrypt = async () => {
  if (!native) return false;
  try {
    const out = await nativeScrypt(
      new TextEncoder().encode('password'),
      new TextEncoder().encode('NaCl'),
      { N: 1024, r: 8, p: 16, dkLen: 64 },
    );
    if (toBase64(out) !== VECTOR_EXPECTED) return false;
    setScryptImplementation(nativeScrypt);
    return true;
  } catch {
    return false;
  }
};
