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
};

// Find a package in pnpm-hoisted locations
function findPackage(pkgName) {
  const candidates = [
    path.resolve(__dirname, 'node_modules', pkgName),
    path.resolve(__dirname, 'node_modules/.pnpm/node_modules', pkgName),
  ];

  // Search alongside babel-preset-expo
  try {
    const presetDir = path.dirname(require.resolve('babel-preset-expo/package.json'));
    candidates.unshift(path.resolve(presetDir, 'node_modules', pkgName));
    candidates.unshift(path.resolve(presetDir, '..', pkgName));
  } catch (_) {}

  // Search alongside hermes-parser
  try {
    const hermesDir = path.dirname(require.resolve('hermes-parser/package.json'));
    candidates.unshift(path.resolve(hermesDir, 'node_modules', pkgName));
    candidates.unshift(path.resolve(hermesDir, '..', pkgName));
  } catch (_) {}

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

// Patch Node module resolution so Babel tools find pnpm-hoisted packages
function patchModuleResolution() {
  const pluginsToFix = ['babel-plugin-syntax-hermes-parser'];
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    for (const pluginName of pluginsToFix) {
      if (request === pluginName || request.includes(`/${pluginName}/index.js`) || request.includes(`/${pluginName}/index`)) {
        const resolved = findPackage(pluginName);
        if (resolved) {
          return originalLoad(resolved, parent, isMain);
        }
      }
    }
    return originalLoad(request, parent, isMain);
  };
}

try { patchModuleResolution(); } catch (_) {}

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
