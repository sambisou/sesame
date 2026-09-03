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
  if [ -d "macos/build/Sésame.app" ]; then
    echo "Installing the menu bar app / Installation de l'app de la barre des menus…"
    rm -rf "/Applications/Sésame.app" 2>/dev/null
    if cp -R "macos/build/Sésame.app" /Applications/ 2>/dev/null; then
      xattr -dr com.apple.quarantine "/Applications/Sésame.app" 2>/dev/null || true
      open "/Applications/Sésame.app"
      read -r -p "Open Sésame at login? / Ouvrir Sésame à la connexion ? [y/N] " yn
      case "$yn" in [yY]*) osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/Sésame.app", hidden:false}' >/dev/null 2>&1 && echo "  added to Login Items / ajouté aux éléments d'ouverture";; esac
    else
      echo "  could not copy to /Applications; the app stays in $(pwd)/macos/build / copie impossible, l'app reste dans le dossier"
      open "macos/build/Sésame.app"
    fi
  fi
  echo
  echo "Done. Next / Terminé. Ensuite :"
  echo "  1. look for the seed icon in the menu bar: add sites, open Chrome, lock / cherchez la graine dans la barre des menus"
  echo "  2. restart Claude Desktop / redémarrez Claude Desktop"
else
  echo "Installation failed (code $status). See messages above. / Échec (code $status), voir ci-dessus."
fi
echo
read -r -p "Press Enter to close / Entrée pour fermer" _
