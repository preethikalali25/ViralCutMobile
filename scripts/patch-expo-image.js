const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'node_modules', 'expo-image', 'package.json');
if (!fs.existsSync(pkgPath)) process.exit(0);

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.main === 'src/index.ts') {
  pkg.main = 'build/index.js';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log('[patch] expo-image: main patched to build/index.js');
}
