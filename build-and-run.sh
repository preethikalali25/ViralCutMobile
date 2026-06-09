#!/bin/bash
set -e

echo "Patching fmt..."
find /Users/havilahlali/Desktop/Fresh_MobileApp/ios/Pods/fmt -name "*.h" -exec sed -i '' 's/consteval/constexpr/g' {} +
find /Users/havilahlali/Desktop/Fresh_MobileApp/ios/Pods/fmt -name "*.cc" -exec sed -i '' 's/consteval/constexpr/g' {} +

echo "Building..."
xcodebuild \
  -workspace /Users/havilahlali/Desktop/Fresh_MobileApp/ios/ViralCut.xcworkspace \
  -scheme ViralCut -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=A6972603-649E-425F-B961-0148F04C3274' \
  build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"

echo "Installing and launching..."
xcrun simctl install booted "/Users/havilahlali/Library/Developer/Xcode/DerivedData/ViralCut-esgcgmtgtaapjifiypqrwnnqqrar/Build/Products/Debug-iphonesimulator/ViralCut.app"
xcrun simctl launch booted com.kalel.KalelViralCut
echo "Done!"
