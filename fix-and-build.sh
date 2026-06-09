#!/bin/bash
set -e

PROJECT_DIR="/Users/havilahlali/Desktop/Fresh_MobileApp"
IOS_DIR="$PROJECT_DIR/ios"
FMT_DIR="$IOS_DIR/Pods/fmt"

echo "━━━ Step 1: Clean pod install ━━━"
cd "$IOS_DIR"
pod deintegrate
pod install

echo ""
echo "━━━ Step 2: Verify fmt files exist ━━━"
if [ ! -d "$FMT_DIR" ]; then
  echo "❌ ERROR: $FMT_DIR not found — pod install may have failed"
  exit 1
fi
echo "✅ fmt directory found"
find "$FMT_DIR" -name "*.h" -o -name "*.cc" | sort

echo ""
echo "━━━ Step 3: Check consteval BEFORE patch ━━━"
grep -rn "consteval" "$FMT_DIR" || echo "(none found)"

echo ""
echo "━━━ Step 4: Apply patch ━━━"
find "$FMT_DIR" -name "*.h" -print0 | xargs -0 sed -i '' 's/consteval/constexpr/g'
find "$FMT_DIR" -name "*.cc" -print0 | xargs -0 sed -i '' 's/consteval/constexpr/g'

echo ""
echo "━━━ Step 5: Check consteval AFTER patch (must be empty) ━━━"
REMAINING=$(grep -rn "consteval" "$FMT_DIR" || true)
if [ -n "$REMAINING" ]; then
  echo "❌ Patch FAILED — consteval still present:"
  echo "$REMAINING"
  exit 1
fi
echo "✅ Patch successful — no consteval remaining"

echo ""
echo "━━━ Step 6: Clear DerivedData ━━━"
rm -rf ~/Library/Developer/Xcode/DerivedData
echo "✅ DerivedData cleared"

echo ""
echo "━━━ Step 7: Build (direct xcodebuild — no pod install) ━━━"
cd "$IOS_DIR"
xcodebuild \
  -workspace ViralCut.xcworkspace \
  -scheme ViralCut \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED|Libtool|warning:"
