#!/bin/bash
# Installation de Sésame sur le Mac. À lancer depuis le dossier décompressé : bash install.sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js absent. Installe-le (brew install node, ou https://nodejs.org) puis relance."; exit 1
fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 20 ]; then echo "❌ Node $MAJOR trop ancien (≥ 20 requis)."; exit 1; fi

echo "📦 Installation des dépendances…"
npm install --omit=dev --no-audit --no-fund >/dev/null

# Commande `sesame` disponible partout : npm link, sinon alias dans ~/.zshrc
if npm link >/dev/null 2>&1; then
  echo "✅ Commande « sesame » installée (npm link)."
else
  LINE="alias sesame='node \"$(pwd)/bin/sesame.js\"'"
  grep -qF "bin/sesame.js" ~/.zshrc 2>/dev/null || echo "$LINE" >> ~/.zshrc
  echo "✅ Alias « sesame » ajouté à ~/.zshrc (ouvre un nouveau terminal ou : source ~/.zshrc)."
fi

echo
echo "🔌 Déclaration du serveur MCP dans Claude Code et Claude Desktop (Cowork)…"
node bin/sesame.js install all || true

cat <<MSG

──────────────────────────────────────────────────────────
Sésame est installé. Prochaines étapes :

  1. sesame chrome                         # lance le Chrome « Sésame » (profil dédié)
     → dans ce Chrome, installe l'extension « Claude in Chrome » et relie-la à Claude Desktop.
  2. sesame add edf --url https://particulier.edf.fr/fr/accueil/connexion.html
     → tape ton identifiant et ton mot de passe (masqué). Ils vont dans le Trousseau macOS.
  3. sesame doctor                         # tout doit être ✅
  4. Redémarre Claude Desktop, puis dis à Claude : « connecte-toi sur edf et récupère la dernière facture ».

  sesame list · sesame policy edf always · sesame revoke edf · sesame lock · sesame log
──────────────────────────────────────────────────────────
MSG
