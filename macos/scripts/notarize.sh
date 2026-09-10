#!/bin/bash
# Signature Developer ID + notarisation Apple de Sésame.app et de son .dmg : c'est ce qui permet à
# n'importe quel Mac d'ouvrir Sésame sans avertissement de Gatekeeper (téléchargement direct, hors
# App Store — l'App Store impose un bac à sable incompatible avec ce que fait Sésame : piloter Chrome,
# écrire la configuration de Claude, parler à l'extension par messagerie native).
#
# Prérequis, sur CE Mac :
#   - un certificat « Developer ID Application » dans le Trousseau (compte développeur Apple) ;
#   - un profil notarytool enregistré une fois :
#       xcrun notarytool store-credentials <profil> --key AuthKey_XXXX.p8 --key-id XXXX --issuer <Issuer ID>
#
# Variables (toutes facultatives, détectées sinon) :
#   DEVELOPER_ID_APPLICATION  nom exact du certificat (défaut : le premier « Developer ID Application » du Trousseau)
#   NOTARY_KEYCHAIN_PROFILE   nom du profil notarytool (défaut : FilRouge s'il existe, sinon sesame-notary)
#
# Usage : scripts/notarize.sh [debug|release]      (release par défaut)
#
# Ordre de signature : de l'intérieur vers l'extérieur, comme Apple le demande — les deux Node embarqués
# (avec leurs droits JIT, voir node.entitlements), l'assistant Trousseau, puis le bundle. Jamais --deep.
# Puis : notarisation de l'app (zip) + agrafage de l'app, .dmg, signature du .dmg, notarisation du .dmg +
# agrafage. Les deux tickets agrafés : l'app ET l'image s'ouvrent sans réseau.
#
# Effet sur un Mac où Sésame tournait déjà signée ad hoc : l'assistant Trousseau change d'identité, le
# Trousseau redemande UNE fois par site (« Toujours autoriser »), puis plus jamais — l'identité Developer
# ID (équipe) est stable d'une version à l'autre, contrairement à la signature ad hoc.
set -euo pipefail
cd "$(dirname "$0")/.."   # macos/

CONFIG="${1:-release}"
log() { echo "[notarize] $*"; }
die() { echo "[notarize] erreur : $*" >&2; exit 1; }

DEVELOPER_ID_APPLICATION="${DEVELOPER_ID_APPLICATION:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"
[ -n "$DEVELOPER_ID_APPLICATION" ] || die "aucun certificat « Developer ID Application » dans le Trousseau (security find-identity -v -p codesigning)"
APPLE_TEAM_ID="$(printf '%s' "$DEVELOPER_ID_APPLICATION" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')"
[ -n "$APPLE_TEAM_ID" ] || die "identifiant d'équipe introuvable dans « $DEVELOPER_ID_APPLICATION »"
if [ -z "${NOTARY_KEYCHAIN_PROFILE:-}" ]; then
  if xcrun notarytool history --keychain-profile FilRouge >/dev/null 2>&1; then NOTARY_KEYCHAIN_PROFILE=FilRouge; else NOTARY_KEYCHAIN_PROFILE=sesame-notary; fi
fi
xcrun notarytool history --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" >/dev/null 2>&1 \
  || die "profil notarytool « $NOTARY_KEYCHAIN_PROFILE » absent ou invalide (voir l'en-tête)"
log "certificat : $DEVELOPER_ID_APPLICATION — équipe $APPLE_TEAM_ID — profil notarytool : $NOTARY_KEYCHAIN_PROFILE"

log "1/6 — assemblage de Sésame.app (scripts/make-app.sh $CONFIG)…"
./scripts/make-app.sh "$CONFIG" >/dev/null
APP="$(cd build && pwd)/Sésame.app"
VERSION="$(node -e 'console.log(require("../package.json").version)')"

log "2/6 — signature Developer ID, de l'intérieur vers l'extérieur (hardened runtime, horodatage)…"
for arch in arm64 x64; do
  codesign --force --options runtime --timestamp --entitlements node.entitlements \
    --sign "$DEVELOPER_ID_APPLICATION" "$APP/Contents/Resources/node-$arch/node" || die "signature de node-$arch échouée"
done
codesign --force --options runtime --timestamp --sign "$DEVELOPER_ID_APPLICATION" "$APP/Contents/MacOS/sesame-keychain" \
  || die "signature de l'assistant Trousseau échouée"
codesign --force --options runtime --timestamp --sign "$DEVELOPER_ID_APPLICATION" "$APP" || die "signature du bundle échouée"
codesign --verify --strict --deep --verbose=2 "$APP" 2>&1 | tail -2 || die "vérification de la signature échouée"
# Le Node signé doit encore tourner (droits JIT bien posés) :
"$APP/Contents/Resources/node-$(uname -m | sed 's/x86_64/x64/')/node" -e 'console.log("  node signé ok :", process.version)' || die "le Node re-signé ne démarre plus (droits manquants ?)"
# Le bundle est-il complet ? Chaque exécutable Mach-O doit être signé par l'équipe.
find "$APP" -type f -perm -u+x -print0 | xargs -0 file | grep -i mach-o | cut -d: -f1 | while read -r bin; do
  # Pas de `grep -q` ici : avec pipefail, codesign prend un SIGPIPE quand grep s'arrête à la première ligne trouvée.
  sig="$(codesign -dv --verbose=2 "$bin" 2>&1 || true)"
  case "$sig" in *"Authority=$DEVELOPER_ID_APPLICATION"*) ;; *) die "non signé Developer ID : $bin" ;; esac
done

if [ "${SESAME_NOTARIZE_DRY_RUN:-}" = "1" ]; then
  log "répétition à blanc (SESAME_NOTARIZE_DRY_RUN=1) : app signée et vérifiée localement, rien envoyé à Apple."
  exit 0
fi

log "3/6 — notarisation de l'app (zip) puis agrafage du ticket dans le bundle…"
ZIP="build/Sesame-${VERSION}-app.zip"
rm -f "$ZIP"; ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" --wait 2>&1 | tail -4 | tee build/notarize-app.log
grep -q "status: Accepted" build/notarize-app.log || die "app refusée par la notarisation — xcrun notarytool log <id> --keychain-profile $NOTARY_KEYCHAIN_PROFILE"
xcrun stapler staple "$APP" >/dev/null || die "agrafage de l'app échoué"
rm -f "$ZIP"

log "4/6 — image disque avec l'app signée et agrafée (sans reconstruction)…"
SESAME_SKIP_BUILD=1 ./scripts/make-dmg.sh "$CONFIG" >/dev/null
DMG="build/Sesame-${VERSION}.dmg"
[ -f "$DMG" ] || die "$DMG absent"

log "5/6 — signature puis notarisation du .dmg, agrafage…"
codesign --force --timestamp --sign "$DEVELOPER_ID_APPLICATION" "$DMG" || die "signature du .dmg échouée"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" --wait 2>&1 | tail -4 | tee build/notarize-dmg.log
grep -q "status: Accepted" build/notarize-dmg.log || die ".dmg refusé par la notarisation"
xcrun stapler staple "$DMG" >/dev/null || die "agrafage du .dmg échoué"

log "6/6 — verdict de Gatekeeper, comme sur le Mac de quelqu'un d'autre…"
# gktool = l'analyse Gatekeeper moderne (macOS 14+), celle du premier lancement : c'est elle qui tranche.
# spctl -t exec, l'ancien outil, répond parfois « rejected » sans motif sur une app locale non mise en
# quarantaine alors que tout est en ordre : informatif seulement.
gktool scan "$APP" 2>&1 | tail -1 | tee build/gatekeeper.log
grep -q "allowed by system policy" build/gatekeeper.log || die "Gatekeeper (gktool) refuse l'app"
spctl -a -t open --context context:primary-signature -v "$DMG" 2>&1 | tail -1 || true
spctl -a -t exec -vv "$APP" 2>&1 | tail -2 || true
cp -f "$DMG" build/Sesame.dmg
log "terminé : $DMG signé Developer ID, notarisé, agrafé (copie : build/Sesame.dmg)."
