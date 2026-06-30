const path = require('path');
const fs = require('fs');

// Fix pnpm hoisting: find babel-plugin-syntax-hermes-parser in nested locations
function findBabelPlugin(pluginName) {
  const candidates = [
    path.resolve(__dirname, 'node_modules', pluginName),
    path.resolve(__dirname, 'node_modules/.pnpm/node_modules', pluginName),
  ];

  // Search inside babel-preset-expo's own node_modules
  try {
    const presetDir = path.dirname(require.resolve('babel-preset-expo/package.json'));
    candidates.unshift(path.resolve(presetDir, 'node_modules', pluginName));
    candidates.unshift(path.resolve(presetDir, '..', pluginName));
  } catch (_) {}

  // Search inside hermes-parser's node_modules
  try {
    const hermesDir = path.dirname(require.resolve('hermes-parser/package.json'));
    candidates.unshift(path.resolve(hermesDir, 'node_modules', pluginName));
    candidates.unshift(path.resolve(hermesDir, '..', pluginName));
  } catch (_) {}

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return null;
}

module.exports = function (api) {
  api.cache(false);

  // Patch require so babel-preset-expo can find babel-plugin-syntax-hermes-parser
  const pluginPath = findBabelPlugin('babel-plugin-syntax-hermes-parser');
  if (pluginPath) {
    try {
      const Module = require('module');
      const originalLoad = Module._load;
      Module._load = function (request, parent, isMain) {
        if (request === 'babel-plugin-syntax-hermes-parser' ||
            request.endsWith('/babel-plugin-syntax-hermes-parser/index.js')) {
          return originalLoad(pluginPath, parent, isMain);
        }
        return originalLoad(request, parent, isMain);
      };
    } catch (_) {}
  }

  return {
    presets: ['babel-preset-expo'],
  };
};
