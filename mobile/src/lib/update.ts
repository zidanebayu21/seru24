import { DeviceEventEmitter, NativeModules } from 'react-native';
import { isNewerRelease, parseAppRelease, type AppRelease } from '../../../web/shared/app-release';
import { API_BASE_URL, APP_VERSION_CODE } from '../env';

interface NativeUpdateModule {
  canInstall: () => Promise<boolean>;
  openInstallSettings: () => Promise<void>;
  downloadAndInstall: (url: string, sha256: string) => Promise<void>;
}

const native = NativeModules.Seru24Update as NativeUpdateModule | undefined;

/** Rilis yang lebih baru dari versi terpasang; null bila sudah terbaru atau gagal dicek. */
export const checkForUpdate = async (): Promise<AppRelease | null> => {
  try {
    const res = await fetch(`${API_BASE_URL}/api/app/latest`);
    if (!res.ok) return null;
    const latest = parseAppRelease(((await res.json()) as { latest?: unknown }).latest);
    return isNewerRelease(latest, APP_VERSION_CODE) ? latest : null;
  } catch {
    return null;
  }
};

export type InstallResult = 'started' | 'need_permission' | 'unsupported';

/**
 * Unduh APK baru lalu buka layar instal Android. Bila izin "Instal aplikasi tak dikenal" belum ada,
 * pengguna diarahkan ke pengaturannya dulu ('need_permission').
 */
export const installUpdate = async (
  release: AppRelease,
  onProgress?: (done: number, total: number) => void,
): Promise<InstallResult> => {
  if (!native) return 'unsupported';
  if (!(await native.canInstall())) {
    await native.openInstallSettings();
    return 'need_permission';
  }
  const subscription = DeviceEventEmitter.addListener('seru24UpdateProgress', (event: { done: number; total: number }) =>
    onProgress?.(event.done, event.total),
  );
  try {
    await native.downloadAndInstall(release.downloadUrl, release.sha256);
    return 'started';
  } finally {
    subscription.remove();
  }
};
