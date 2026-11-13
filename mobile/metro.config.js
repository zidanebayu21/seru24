const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// Kode bersama web dan mobile (kripto, transport, sesi, akun, E2EE) ada di ../web/shared.
const sharedDir = path.resolve(__dirname, '../web/shared');

/**
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [sharedDir],
  resolver: {
    // dependensi file di ../web/shared (@noble/*) diambil dari node_modules mobile
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
    blockList: [/web[\\/]shared[\\/].*\.test\.ts$/],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
