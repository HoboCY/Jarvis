/* eslint-disable @typescript-eslint/no-require-imports */
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('node:path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const workspaceRoot = path.resolve(__dirname, '../../..');
const config = {
  watchFolders: [
    path.join(workspaceRoot, 'node_modules'),
    path.join(workspaceRoot, 'packages')
  ],
  resolver: {
    // Keep package exports enabled so @openai/agents-realtime receives its
    // react-native condition.
    unstable_enablePackageExports: true,
    nodeModulesPaths: [
      path.join(__dirname, 'node_modules'),
      path.join(workspaceRoot, 'node_modules')
    ]
  }
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
