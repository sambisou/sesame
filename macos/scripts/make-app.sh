#!/bin/bash
# Assemble Sésame.app (barre des menus + assistant Trousseau) à partir du produit SwiftPM.
# Usage : scripts/make-app.sh [debug|release]
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG="${1:-debug}"
swift build -c "$CONFIG"
BIN_DIR="$(swift build -c "$CONFIG" --show-bin-path)"
APP="build/Sésame.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/SesameBar" "$APP/Contents/MacOS/SesameBar"
cp "$BIN_DIR/SesameKeychain" "$APP/Contents/MacOS/sesame-keychain"
cp Sources/SesameBar/Resources/Info.plist "$APP/Contents/Info.plist"

# L'icône est dessinée par l'app elle-même (graine + trou de serrure).
ICONSET="build/Sesame.iconset"
rm -rf "$ICONSET"
if "$APP/Contents/MacOS/SesameBar" --export-iconset "$ICONSET" >/dev/null 2>&1; then
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Sesame.icns"
fi
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "note: signature ad hoc impossible"
if ! codesign -dv "$APP/Contents/MacOS/sesame-keychain" >/dev/null 2>&1; then
  echo "erreur : sesame-keychain n'est pas signé (setSecret n'accordera sa confiance qu'à un binaire signé)" >&2
  exit 1
fi
echo "construit : $APP"
