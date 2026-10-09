const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withCpp20(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf-8');

      if (!contents.includes('CLANG_CXX_LANGUAGE_STANDARD')) {
        const injection = `
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |cfg|
      cfg.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++20'
    end
  end`;

        // Insert before the final `end` of the post_install block
        contents = contents.replace(
          /(post_install do \|installer\|[\s\S]*?)(^end)/m,
          `$1${injection}\nend`
        );
        fs.writeFileSync(podfilePath, contents);
      }

      return config;
    },
  ]);
};
