#!/bin/bash
# Assemble Sésame.app (barre des menus) à partir du produit SwiftPM. Usage : scripts/make-app.sh [debug|release]
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG="${1:-debug}"
swift build -c "$CONFIG"
BIN="$(swift build -c "$CONFIG" --show-bin-path)/SesameBar"
APP="build/Sésame.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/SesameBar"
cp Sources/SesameBar/Resources/Info.plist "$APP/Contents/Info.plist"

# L'icône est dessinée par l'app elle-même (graine + trou de serrure).
ICONSET="build/Sesame.iconset"
rm -rf "$ICONSET"
if "$BIN" --export-iconset "$ICONSET" >/dev/null 2>&1; then
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Sesame.icns"
fi
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "note: signature ad hoc impossible"
echo "construit : $APP"
