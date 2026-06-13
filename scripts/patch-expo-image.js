const fs = require('fs');
const path = require('path');

// expo-image ships with main=src/index.ts which breaks Node.js (expo config).
// It has a compiled build/ directory so we can point main there.
// expo-modules-core intentionally uses src/index.ts for Metro — do NOT patch it.
const pkgPath = path.join(__dirname, '..', 'node_modules', 'expo-image', 'package.json');
if (!fs.existsSync(pkgPath)) process.exit(0);

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.main === 'src/index.ts') {
  pkg.main = 'build/index.js';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log('[patch] expo-image: main patched to build/index.js');
}
