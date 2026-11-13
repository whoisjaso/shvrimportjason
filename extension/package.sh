#!/bin/sh
# Build the zip to upload to the Chrome Web Store: dist/hcp-job-costing-export-<version>.zip
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$root/extension/manifest.json")
out="$root/dist/hcp-job-costing-export-$version.zip"

mkdir -p "$root/dist"
rm -f "$out"
cd "$root/extension"
zip -qr "$out" manifest.json background.js app.html app.css app.js lib icons/*.png -x '.*'
echo "$out"
