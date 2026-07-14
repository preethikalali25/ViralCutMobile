const path = require('path');
const Module = require('module');

// Patch Node's require to redirect babel-plugin-syntax-hermes-parser's
// absolute stub path to our actual stub file. This must run before Babel
// initialises so the SSR/web bundle worker can find the file.
const HERMES_STUB_PATH = path.resolve(__dirname, 'stubs/hermes-parser-plugin.js');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  // Only intercept the exact absolute stub path the plugin constructs
  if (request === HERMES_STUB_PATH || request.endsWith('stubs/hermes-parser-plugin.js')) {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
