#!/bin/bash
# Construit build/Sesame-<version>.dmg : Sésame.app (reconstruite par make-app.sh) + un alias vers
# /Applications, dans une fenêtre Finder mise en forme (fond dessiné par SesameBar --export-dmg-background,
# icônes disposées, icône de volume), compressée en UDZO. Signature ad hoc pour l'instant — voir
# scripts/notarize.sh (documenté, non exécuté) pour la distribution.
#
# Usage : scripts/make-dmg.sh [debug|release]   (défaut release — c'est ce que télécharge un utilisateur)
set -euo pipefail
cd "$(dirname "$0")/.."   # macos/
ROOT="$(cd .. && pwd)"

CONFIG="${1:-release}"
VERSION="$(node -e 'console.log(require("../package.json").version)' 2>/dev/null || grep -m1 '"version"' "$ROOT/package.json" | sed -E 's/.*: *"([^"]+)".*/\1/')"
[ -n "$VERSION" ] || { echo "erreur : impossible de lire la version dans $ROOT/package.json" >&2; exit 1; }

log() { echo "[make-dmg] $*"; }
die() { echo "[make-dmg] erreur : $*" >&2; exit 1; }

log "1/6 — assemblage de Sésame.app (scripts/make-app.sh $CONFIG)…"
./scripts/make-app.sh "$CONFIG"
APP="$(cd build && pwd)/Sésame.app"
[ -d "$APP" ] || die "$APP absent après make-app.sh"

VOL_NAME="Sésame"
OUT_DMG="build/Sesame-${VERSION}.dmg"
STAGE="build/dmg-stage"
TMP_DMG="build/dmg-tmp.dmg"
rm -rf "$STAGE" "$TMP_DMG" "$OUT_DMG"
mkdir -p "$STAGE"

log "2/6 — mise en scène (app + alias Applications + fond + lisez-moi)…"
cp -R "$APP" "$STAGE/Sésame.app"
ln -s /Applications "$STAGE/Applications"
# Tant que l'app n'est pas notariée (voir scripts/notarize.sh), la première ouverture déclenche
# l'avertissement Gatekeeper « développeur non identifié » : ce fichier explique le clic droit → Ouvrir,
# en deux lignes, dans les deux langues du produit.
cat > "$STAGE/Read me first.txt" <<'EOF'
Right-click "Sésame.app" and choose "Open" — the first time only. macOS
doesn't recognize the developer yet, but Sésame is safe to run; after
that first open, it launches normally, like any other app.

Clic droit sur « Sésame.app » puis « Ouvrir » — la première fois
seulement. macOS ne reconnaît pas encore l'éditeur, mais Sésame ne
présente aucun danger ; ensuite, l'app s'ouvre normalement.
EOF
mkdir -p "$STAGE/.background"
if ! "$STAGE/Sésame.app/Contents/MacOS/SesameBar" --export-dmg-background "$STAGE/.background/dmg-background.png" >/dev/null 2>&1; then
  die "échec de la génération du fond (SesameBar --export-dmg-background)"
fi
[ -f "$STAGE/.background/dmg-background.png" ] || die "fond du .dmg non généré"

# Icône de volume : la même graine que l'icône de l'app, sur le disque monté (visible dans la barre latérale).
if [ -f "$APP/Contents/Resources/Sesame.icns" ]; then
  cp "$APP/Contents/Resources/Sesame.icns" "$STAGE/.VolumeIcon.icns"
fi

log "3/6 — image disque temporaire, en lecture-écriture…"
SIZE_MB=$(( $(du -sm "$STAGE" | cut -f1) + 80 ))   # marge : métadonnées Finder, alignement du système de fichiers
hdiutil create -volname "$VOL_NAME" -srcfolder "$STAGE" -fs HFS+ -fsargs "-c c=64,a=16,e=16" \
  -format UDRW -size "${SIZE_MB}m" "$TMP_DMG" -ov -quiet \
  || die "hdiutil create a échoué"

log "4/6 — habillage de la fenêtre Finder…"
# Pas de -mountpoint personnalisé : Finder ne résout `disk "${VOL_NAME}"` (ci-dessous) que pour un volume
# monté à son emplacement habituel, /Volumes/<nom> (vérifié : avec -mountpoint ailleurs, Finder répond
# « Can't get disk » alors que le volume est bien monté). On lit donc le point de montage réel dans la
# sortie de hdiutil plutôt que de le choisir nous-mêmes.
ATTACH_OUT="$(hdiutil attach "$TMP_DMG" -readwrite -noverify -noautoopen 2>&1)" \
  || die "hdiutil attach a échoué : $ATTACH_OUT"
DEVICE="$(echo "$ATTACH_OUT" | grep -Eo '/dev/disk[0-9]+' | head -1)"
MOUNT_DIR="$(echo "$ATTACH_OUT" | awk -F'\t' '{print $NF}' | grep '^/Volumes/' | head -1)"
[ -n "$MOUNT_DIR" ] || die "point de montage introuvable dans la sortie de hdiutil : $ATTACH_OUT"

detach() {
  if [ -n "${DEVICE:-}" ]; then
    hdiutil detach "$DEVICE" -quiet 2>/dev/null || hdiutil detach "$DEVICE" -force -quiet 2>/dev/null || true
  fi
}
trap detach EXIT

if command -v SetFile >/dev/null 2>&1 && [ -f "$MOUNT_DIR/.VolumeIcon.icns" ]; then
  SetFile -a C "$MOUNT_DIR" 2>/dev/null || true   # marque le dossier racine « a une icône personnalisée »
fi

# Disposition Finder : icône de l'app à gauche, flèche (dans le fond), alias Applications à droite — mêmes
# centres que DMGBackground.sesameIconCenter / applicationsIconCenter (repère Finder : origine en haut à
# gauche, y = 400 - y_Quartz). Best effort : sans permission d'automatisation de Finder (osascript), le
# .dmg reste parfaitement utilisable, juste sans cette mise en forme — on prévient, on n'échoue pas le build.
if ! osascript <<OSA
tell application "Finder"
  tell disk "${VOL_NAME}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {400, 120, 1040, 520}
    set theViewOptions to the icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 96
    set background picture of theViewOptions to file ".background:dmg-background.png"
    set position of item "Sésame.app" of container window to {170, 170}
    set position of item "Applications" of container window to {470, 170}
    set position of item "Read me first.txt" of container window to {320, 340}
    close
    open
    update without registering applications
    delay 2
  end tell
end tell
OSA
then
  echo "[make-dmg] avertissement : Finder n'a pas pu mettre en forme la fenêtre (osascript sans autorisation d'automatisation ?) — le .dmg reste fonctionnel." >&2
fi

sync
detach
trap - EXIT
DEVICE=""

log "5/6 — compression (UDZO)…"
mkdir -p build
hdiutil convert "$TMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$OUT_DMG" -ov -quiet \
  || die "hdiutil convert a échoué"
rm -f "$TMP_DMG"
rm -rf "$STAGE"

log "6/6 — vérification (montage en lecture seule)…"
CHECK_DIR="$(mktemp -d /tmp/sesame-dmg-check.XXXXXX)"
CHECK_ATTACH="$(hdiutil attach "$OUT_DMG" -readonly -noverify -noautoopen -mountpoint "$CHECK_DIR" 2>&1)" \
  || die "le .dmg produit ne se monte pas : $CHECK_ATTACH"
CHECK_DEVICE="$(echo "$CHECK_ATTACH" | grep -Eo '/dev/disk[0-9]+' | head -1)"
check_detach() { hdiutil detach "$CHECK_DEVICE" -quiet 2>/dev/null || true; rmdir "$CHECK_DIR" 2>/dev/null || true; }
[ -d "$CHECK_DIR/Sésame.app" ] || { check_detach; die "Sésame.app absent du .dmg monté"; }
[ -L "$CHECK_DIR/Applications" ] || { check_detach; die "l'alias Applications est absent du .dmg"; }
[ -f "$CHECK_DIR/Read me first.txt" ] || { check_detach; die "« Read me first.txt » absent du .dmg"; }
codesign -dv "$CHECK_DIR/Sésame.app" >/dev/null 2>&1 || { check_detach; die "Sésame.app dans le .dmg n'est pas signé"; }
check_detach

log "terminé : $OUT_DMG ($(du -sh "$OUT_DMG" | cut -f1))"
