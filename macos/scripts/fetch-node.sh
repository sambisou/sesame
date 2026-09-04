#!/bin/bash
# Télécharge les binaires officiels de Node.js (nodejs.org/dist) pour macOS arm64 et x64, vérifie leur
# empreinte contre SHASUMS256.txt, et met en cache le seul exécutable `bin/node` (plus sa licence) dans
# macos/vendor/node-<arch>/ — jamais commité (voir .gitignore), reconstruit à la demande.
#
# Usage : scripts/fetch-node.sh [version]     (défaut : $NODE_VERSION ci-dessous, ex. 24.20.0)
#
# Échoue bruyamment (set -euo pipefail) au moindre problème : réseau, empreinte qui ne correspond pas,
# archive inattendue — jamais de binaire douteux mis en cache silencieusement.
set -euo pipefail
cd "$(dirname "$0")/.."   # macos/

NODE_VERSION="${1:-${NODE_VERSION:-24.20.0}}"
DIST="https://nodejs.org/dist/v${NODE_VERSION}"
VENDOR_DIR="vendor"

log() { echo "[fetch-node] $*"; }
die() { echo "[fetch-node] erreur : $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "outil requis manquant : $1"; }
need curl
need shasum
need tar
need file

# arch nodejs.org → (nom de dossier local, motif attendu dans `file` — jamais exécuté : le binaire x64
# téléchargé sur une machine arm64 (et vice versa) ne tourne pas nativement ici, `file` suffit à vérifier
# qu'on a bien mis en cache un exécutable Mach-O de la bonne architecture).
ARCHES="arm64:arm64:arm64 x64:x64:x86_64"

fetch_one() {
  local node_arch="$1" local_name="$2" file_pattern="$3"
  local out_dir="$VENDOR_DIR/node-${local_name}"
  local out_bin="$out_dir/node"
  local out_license="$out_dir/LICENSE"
  local out_stamp="$out_dir/.node-version"

  if [ -x "$out_bin" ] && [ -f "$out_license" ] && [ "$(cat "$out_stamp" 2>/dev/null || true)" = "v${NODE_VERSION}" ]; then
    log "node-${local_name} : déjà en cache (v${NODE_VERSION}), rien à faire"
    return 0
  fi

  local tarball="node-v${NODE_VERSION}-darwin-${node_arch}.tar.gz"
  local tmp
  tmp="$(mktemp -d)"

  log "téléchargement de ${tarball}…"
  curl -fsSL --retry 3 -o "$tmp/$tarball" "$DIST/$tarball" \
    || die "échec du téléchargement de $DIST/$tarball (réseau, ou version ${NODE_VERSION} inexistante sur nodejs.org)"

  log "téléchargement de SHASUMS256.txt…"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$DIST/SHASUMS256.txt" \
    || die "échec du téléchargement de $DIST/SHASUMS256.txt"

  local expected got
  expected="$(grep " ${tarball}\$" "$tmp/SHASUMS256.txt" | awk '{print $1}' || true)"
  [ -n "$expected" ] || die "${tarball} n'apparaît pas dans SHASUMS256.txt — archive suspecte, abandon"
  got="$(shasum -a 256 "$tmp/$tarball" | awk '{print $1}')"
  [ "$expected" = "$got" ] || die "empreinte SHA-256 invalide pour ${tarball} (attendu ${expected}, obtenu ${got}) — abandon, RIEN n'est mis en cache"
  log "empreinte SHA-256 vérifiée pour ${tarball}"

  local prefix="node-v${NODE_VERSION}-darwin-${node_arch}"
  tar -xzf "$tmp/$tarball" -C "$tmp" "$prefix/bin/node" "$prefix/LICENSE" \
    || die "archive ${tarball} inattendue (bin/node ou LICENSE absents)"
  [ -x "$tmp/$prefix/bin/node" ] || die "bin/node absent ou non exécutable dans ${tarball}"

  mkdir -p "$out_dir"
  cp "$tmp/$prefix/bin/node" "$out_bin.tmp"
  chmod 755 "$out_bin.tmp"
  mv "$out_bin.tmp" "$out_bin"
  cp "$tmp/$prefix/LICENSE" "$out_license"
  rm -rf "$tmp"

  file "$out_bin" | grep -q "$file_pattern" \
    || die "node-${local_name} : $(file "$out_bin") — architecture ${file_pattern} attendue, binaire suspect"
  echo "v${NODE_VERSION}" > "$out_stamp"
  log "node-${local_name} : v${NODE_VERSION} mis en cache (${out_bin})"
}

mkdir -p "$VENDOR_DIR"
for triple in $ARCHES; do
  IFS=: read -r node_arch local_name file_pattern <<< "$triple"
  fetch_one "$node_arch" "$local_name" "$file_pattern"
done
log "terminé : $VENDOR_DIR/node-arm64/node, $VENDOR_DIR/node-x64/node"
