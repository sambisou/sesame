#!/bin/bash
# Signature Developer ID + notarisation de Sésame.app / du .dmg, pour la distribution en dehors du Mac
# de développement (aujourd'hui, make-app.sh / make-dmg.sh ne signent qu'en ad hoc : suffisant pour
# tourner sur CE Mac, mais Gatekeeper bloquera l'app sur celui de quelqu'un d'autre sans ce qui suit).
#
# NON EXÉCUTÉ AUTOMATIQUEMENT : ce script est documenté, à la disposition de qui aura un compte
# développeur Apple (99 $/an) et un certificat « Developer ID Application ». Tant que ces variables ne
# sont pas renseignées, il s'arrête avant de rien signer.
#
# Renseigne AVANT de lancer :
#   - DEVELOPER_ID_APPLICATION : nom exact du certificat, tel que `security find-identity -v -p codesigning`
#       le montre — ex. "Developer ID Application: Prénom Nom (TEAMID1234)"
#   - APPLE_TEAM_ID            : l'identifiant d'équipe à 10 caractères (TEAMID1234 ci-dessus)
#   - APPLE_ID                 : l'identifiant Apple utilisé pour développer (email)
#   - Un mot de passe d'application pour APPLE_ID, stocké dans le Trousseau de CE Mac sous le nom
#     donné par NOTARY_KEYCHAIN_PROFILE (créé une fois avec :
#       xcrun notarytool store-credentials "$NOTARY_KEYCHAIN_PROFILE" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID"
#     — suit les instructions interactives, mot de passe d'application généré sur appleid.apple.com)
#
# Usage, une fois tout renseigné : scripts/notarize.sh [debug|release]
set -euo pipefail
cd "$(dirname "$0")/.."   # macos/

# --- à renseigner ---------------------------------------------------------------------------
DEVELOPER_ID_APPLICATION="${DEVELOPER_ID_APPLICATION:-}"   # "Developer ID Application: … (TEAMID)"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"                          # ex. ABCDE12345
APPLE_ID="${APPLE_ID:-}"                                    # email du compte développeur
NOTARY_KEYCHAIN_PROFILE="${NOTARY_KEYCHAIN_PROFILE:-sesame-notary}"
# ---------------------------------------------------------------------------------------------

CONFIG="${1:-release}"

log() { echo "[notarize] $*"; }
die() { echo "[notarize] erreur : $*" >&2; exit 1; }

if [ -z "$DEVELOPER_ID_APPLICATION" ] || [ -z "$APPLE_TEAM_ID" ] || [ -z "$APPLE_ID" ]; then
  die "variables non renseignées (DEVELOPER_ID_APPLICATION, APPLE_TEAM_ID, APPLE_ID) — voir l'en-tête de ce script. Rien n'a été signé."
fi
security find-identity -v -p codesigning | grep -qF "$DEVELOPER_ID_APPLICATION" \
  || die "certificat introuvable dans le Trousseau : « $DEVELOPER_ID_APPLICATION » (security find-identity -v -p codesigning pour voir ce qui est disponible)"

log "1/4 — assemblage de Sésame.app (ad hoc, comme d'habitude)…"
./scripts/make-app.sh "$CONFIG"
APP="$(cd build && pwd)/Sésame.app"

log "2/4 — signature Developer ID (remplace la signature ad hoc, --deep pour Node embarqué + assistant Trousseau)…"
codesign --deep --force --options runtime --timestamp \
  --sign "$DEVELOPER_ID_APPLICATION" \
  "$APP" \
  || die "codesign a échoué"
codesign -dv --verbose=4 "$APP" || die "vérification de la signature échouée"
spctl -a -t exec -vv "$APP" || log "avertissement : spctl refuse encore l'app — normal avant notarisation, voir l'étape suivante"

log "3/4 — .dmg (avec l'app maintenant signée Developer ID) puis signature du .dmg lui-même…"
./scripts/make-dmg.sh "$CONFIG"
VERSION="$(node -e 'console.log(require("../package.json").version)')"
DMG="build/Sesame-${VERSION}.dmg"
codesign --force --sign "$DEVELOPER_ID_APPLICATION" "$DMG" || die "signature du .dmg échouée"

log "4/4 — notarisation (peut prendre plusieurs minutes, --wait bloque jusqu'au verdict d'Apple)…"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" --team-id "$APPLE_TEAM_ID" --wait \
  || die "notarytool submit a échoué (ou a été rejeté — voir le rapport ci-dessus, xcrun notarytool log <id> --keychain-profile $NOTARY_KEYCHAIN_PROFILE pour le détail)"
xcrun stapler staple "$DMG" || die "l'agrafage (stapler) a échoué"
spctl -a -t open --context context:primary-signature -v "$DMG" || log "avertissement : spctl reste à vérifier manuellement"

log "terminé : $DMG signé, notarisé, agrafé — prêt pour la distribution publique."
