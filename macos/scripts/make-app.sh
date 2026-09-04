#!/bin/bash
# Assemble Sésame.app : barre des menus + assistant Trousseau (SwiftPM) + Node embarqué (deux
# architectures) + serveur Sésame (src/, bin/, dépendances de production) — un bundle qui tourne sans le
# dépôt et sans Node système. Usage : scripts/make-app.sh [debug|release]
set -euo pipefail
cd "$(dirname "$0")/.."      # macos/
ROOT="$(cd .. && pwd)"       # racine du dépôt
CONFIG="${1:-debug}"

# ---------------------------------------------------------------------------------------------
# 1. Barre des menus + assistant Trousseau (SwiftPM)
# ---------------------------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------------------------
# 2. Node embarqué (arm64 + x64) : plus aucun Node système requis pour l'utilisateur.
# ---------------------------------------------------------------------------------------------
echo "→ Node embarqué…"
./scripts/fetch-node.sh
for arch in arm64 x64; do
  src="vendor/node-${arch}/node"
  [ -x "$src" ] || { echo "erreur : $src absent — scripts/fetch-node.sh a dû échouer" >&2; exit 1; }
  mkdir -p "$APP/Contents/Resources/node-${arch}"
  cp "$src" "$APP/Contents/Resources/node-${arch}/node"
  chmod 755 "$APP/Contents/Resources/node-${arch}/node"
done
# Obligation de la licence MIT de Node (les deux architectures partagent le même texte de licence).
cp "vendor/node-arm64/LICENSE" "$APP/Contents/Resources/NODE_LICENSE.txt"

# ---------------------------------------------------------------------------------------------
# 3. Serveur Sésame embarqué : src/, bin/, extension/ (pour « sesame install extension » depuis le
#    bundle), et les seules dépendances de PRODUCTION (npm ci --omit=dev, dans le bundle lui-même :
#    un dossier temporaire n'apporterait rien puisque node_modules doit de toute façon finir ici).
# ---------------------------------------------------------------------------------------------
echo "→ Serveur Sésame embarqué…"
SERVER="$APP/Contents/Resources/sesame"
rm -rf "$SERVER"
mkdir -p "$SERVER"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$SERVER/"
cp "$ROOT/LICENSE" "$SERVER/LICENSE"
( cd "$SERVER" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error )
rm -rf "$SERVER/node_modules/.package-lock.json"
cp -R "$ROOT/src" "$SERVER/src"
cp -R "$ROOT/bin" "$SERVER/bin"
cp -R "$ROOT/extension" "$SERVER/extension"
chmod +x "$SERVER"/bin/*.js "$SERVER"/bin/*.sh 2>/dev/null || true

# ---------------------------------------------------------------------------------------------
# 4. Lanceurs (Contents/MacOS) : choisissent le Node embarqué selon `uname -m` et exécutent le
#    script correspondant dans Contents/Resources/sesame/bin — jamais le dépôt de développement.
#    C'est le chemin que « sesame install extension » écrit dans le manifeste de messagerie native
#    (bin/sesame.js), et celui que « sesame install claude-code/cowork » peut proposer pour rester
#    valable même si l'app est déplacée ou l'utilisateur change de Mac.
# ---------------------------------------------------------------------------------------------
write_launcher() {
  local out="$1" target="$2"
  cat > "$out" <<EOF
#!/bin/sh
# Lanceur embarqué de Sésame.app — ne dépend d'aucun Node système.
# Choisit le binaire Node embarqué selon l'architecture puis exécute Contents/Resources/sesame/bin/${target}.
DIR="\$(cd "\$(dirname "\$0")/.." && pwd)"   # .../Sésame.app/Contents
case "\$(uname -m)" in
  arm64)  NODE="\$DIR/Resources/node-arm64/node" ;;
  x86_64) NODE="\$DIR/Resources/node-x64/node" ;;
  *) echo "[sesame] architecture non prise en charge : \$(uname -m)" >&2; exit 1 ;;
esac
if [ ! -x "\$NODE" ]; then
  echo "[sesame] Node embarqué introuvable (\$NODE) — bundle Sésame.app incomplet ou corrompu." >&2
  exit 1
fi
exec "\$NODE" "\$DIR/Resources/sesame/bin/${target}" "\$@"
EOF
  chmod 755 "$out"
}
write_launcher "$APP/Contents/MacOS/sesame-launcher" "sesame.js"
write_launcher "$APP/Contents/MacOS/sesame-mcp" "sesame-mcp.js"
write_launcher "$APP/Contents/MacOS/sesame-bridge" "sesame-bridge.js"

# ---------------------------------------------------------------------------------------------
# 5. Signature (ad hoc pour l'instant — voir scripts/notarize.sh pour la distribution).
# ---------------------------------------------------------------------------------------------
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "note: signature ad hoc impossible"
if ! codesign -dv "$APP/Contents/MacOS/sesame-keychain" >/dev/null 2>&1; then
  echo "erreur : sesame-keychain n'est pas signé (setSecret n'accordera sa confiance qu'à un binaire signé)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
# 6. Vérification : le serveur embarqué tourne sans le dépôt et sans Node système.
# ---------------------------------------------------------------------------------------------
APP_ABS="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
NATIVE_ARCH="$(uname -m)"
case "$NATIVE_ARCH" in arm64) NODE_CHECK="node-arm64";; x86_64) NODE_CHECK="node-x64";; esac
if [ -n "${NODE_CHECK:-}" ]; then
  echo "→ Vérification (env -i, sans dépôt ni Node système, sans toucher ~/.sesame réel)…"
  CHECK_LOG="$(mktemp)"
  CHECK_HOME="$(mktemp -d)"   # jamais ~/.sesame réel, même en lecture (convention du dépôt, voir test/)
  if ! ( cd /tmp && env -i PATH=/usr/bin:/bin SESAME_HOME="$CHECK_HOME" SESAME_KEYCHAIN_SERVICE="sesame-build-check" \
      "$APP_ABS/Contents/Resources/$NODE_CHECK/node" \
      "$APP_ABS/Contents/Resources/sesame/bin/sesame.js" doctor >"$CHECK_LOG" 2>&1 ); then
    echo "erreur : le serveur embarqué (bin/sesame.js doctor) a échoué — voir $CHECK_LOG" >&2
    tail -20 "$CHECK_LOG" >&2 || true
    rm -rf "$CHECK_HOME"
    exit 1
  fi
  rm -f "$CHECK_LOG"
  rm -rf "$CHECK_HOME"
  echo "  ok : bin/sesame.js doctor répond depuis le bundle."
fi

echo "construit : $APP"
