const fs = require('fs');
const path = require('path');

const patches = [
  { pkg: 'expo-image', from: 'src/index.ts', to: 'build/index.js' },
  { pkg: 'expo-modules-core', from: 'src/index.ts', to: 'build/index.js' },
];

for (const { pkg, from, to } of patches) {
  const pkgPath = path.join(__dirname, '..', 'node_modules', pkg, 'package.json');
  if (!fs.existsSync(pkgPath)) continue;
  const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkgJson.main === from) {
    pkgJson.main = to;
    fs.writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2));
    console.log(`[patch] ${pkg}: main patched to ${to}`);
  }
}
