#!/bin/sh
# Lanceur du pont natif Sésame. C'est ce chemin que pointe le manifeste de messagerie native
# (~/Library/Application Support/Google/Chrome/NativeMessagingHosts/app.sesamekey.bridge.json).
#
# Chrome lance les hôtes natifs avec un PATH minimal (/usr/bin:/bin:/usr/sbin:/sbin) : `node` n'y est
# généralement pas. On le cherche donc, dans l'ordre :
#   1. $SESAME_NODE — honoré SEULEMENT si SESAME_TEST=1 est aussi posé (bancs d'essai), comme SESAME_HOME :
#      l'environnement hérité de Chrome n'a pas à choisir l'interpréteur qui portera le secret ;
#   2. le chemin figé à l'installation dans ~/.sesame/node-path, écrit par `sesame install extension`
#      avec le node qui a servi à l'installation — accepté seulement si c'est un fichier régulier qui
#      appartient à l'utilisateur ;
#   3. `command -v node` ;
#   4. les emplacements usuels (Homebrew Apple Silicon et Intel, MacPorts) ;
#   5. les gestionnaires de versions (nvm : la plus récente ; volta ; fnm ; asdf).
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1

if [ "${SESAME_TEST:-}" != "1" ]; then
  unset SESAME_NODE SESAME_HOME
fi
HOME_DIR="${SESAME_HOME:-$HOME/.sesame}"
NODE=""
try() { if [ -z "$NODE" ] && [ -n "${1:-}" ] && [ -f "$1" ] && [ -x "$1" ]; then NODE="$1"; fi; }

try "${SESAME_NODE:-}"
NODE_PATH_FILE="$HOME_DIR/node-path"
if [ -z "$NODE" ] && [ -f "$NODE_PATH_FILE" ] && [ -O "$NODE_PATH_FILE" ] && [ -r "$NODE_PATH_FILE" ]; then
  try "$(head -n 1 "$NODE_PATH_FILE" | tr -d '\r')"
fi
if [ -z "$NODE" ]; then try "$(command -v node 2>/dev/null || true)"; fi
try /opt/homebrew/bin/node
try /usr/local/bin/node
try /opt/local/bin/node
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  try "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1)"
fi
try "$HOME/.volta/bin/node"
if [ -z "$NODE" ] && [ -d "$HOME/.local/share/fnm/node-versions" ]; then
  try "$(ls -d "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -n 1)"
fi
try "$HOME/.asdf/shims/node"

if [ -z "$NODE" ]; then
  echo "[sesame-bridge] node introuvable : installe Node.js (brew install node) ou lance \`sesame install extension\`." >&2
  exit 127
fi
exec "$NODE" "$DIR/bin/sesame-bridge.js" "$@"
