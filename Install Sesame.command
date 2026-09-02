#!/bin/bash
# Double-click this file in Finder to install Sésame (macOS).
# Double-cliquez sur ce fichier dans le Finder pour installer Sésame (macOS).
# First time, macOS may refuse: right-click → Open. / La première fois, macOS peut refuser : clic droit → Ouvrir.
cd "$(dirname "$0")" || exit 1
echo "══════════════════════════════════════════════"
echo "  Sésame — installation / install"
echo "══════════════════════════════════════════════"
echo
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is missing. Install it from https://nodejs.org (LTS), then run this file again."
  echo "Node.js manque. Installez-le depuis https://nodejs.org (LTS), puis relancez ce fichier."
  echo
  read -r -p "Press Enter to close / Entrée pour fermer" _
  exit 1
fi
bash ./install.sh
status=$?
echo
if [ $status -eq 0 ]; then
  echo "Done. Next / Terminé. Ensuite :"
  echo "  1. sesame chrome"
  echo "  2. sesame add <site> --url <login-url>"
  echo "  3. restart Claude Desktop / redémarrez Claude Desktop"
else
  echo "Installation failed (code $status). See messages above. / Échec (code $status), voir ci-dessus."
fi
echo
read -r -p "Press Enter to close / Entrée pour fermer" _
