// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const config = getDefaultConfig(__dirname);

// Resolve native-only packages to web stubs on web platform
const webStubs = {
  'expo-video-thumbnails': path.resolve(__dirname, 'modules/expo-video-thumbnails.web.ts'),
  'react-native-video-trim': path.resolve(__dirname, 'modules/react-native-video-trim.web.ts'),
  'expo-video': path.resolve(__dirname, 'modules/expo-video.web.ts'),
  'expo-web-browser': path.resolve(__dirname, 'modules/expo-web-browser.web.ts'),
  'expo-modules-core': path.resolve(__dirname, 'modules/expo-modules-core.web.ts'),
  'expo-apple-authentication': path.resolve(__dirname, 'modules/expo-apple-authentication.web.ts'),
  'expo-auth-session': path.resolve(__dirname, 'modules/expo-auth-session.web.ts'),
};

// Find the correct expo-modules-core path by walking up from the known expo package
function findExpoModulesCore() {
  const candidates = [
    path.resolve(__dirname, 'node_modules/expo-modules-core'),
    path.resolve(__dirname, 'node_modules/.pnpm/node_modules/expo-modules-core'),
  ];

  try {
    const expoDir = path.dirname(require.resolve('expo/package.json'));
    candidates.unshift(path.resolve(expoDir, 'node_modules/expo-modules-core'));
  } catch (_) {}

  for (const candidate of candidates) {
    const indexPath = path.join(candidate, 'build', 'index.js');
    if (fs.existsSync(indexPath)) return candidate;
  }
  return null;
}

const expoModulesCorePath = findExpoModulesCore();

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && webStubs[moduleName]) {
    return { filePath: webStubs[moduleName], type: 'sourceFile' };
  }
  if (moduleName === 'expo-modules-core' && expoModulesCorePath) {
    const indexFile = path.join(expoModulesCorePath, 'build', 'index.js');
    if (fs.existsSync(indexFile)) {
      return { filePath: indexFile, type: 'sourceFile' };
    }
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

config.resolver.unstable_enablePackageExports = false;

module.exports = config;
