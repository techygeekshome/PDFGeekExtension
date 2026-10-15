#!/usr/bin/env bash
# Builds the release packages into dist/.
#   PDFGeek.zip          Chrome, Edge, Brave, Opera, Vivaldi (unzip, then Load unpacked)
#   PDFGeek-chrome.zip   same files, named for Chrome users
#   PDFGeek-edge.zip     same files, named for Edge users
#   PDFGeek-firefox.zip  Firefox package (Firefox manifest, files at the root)
set -euo pipefail
cd "$(dirname "$0")"
FILES="background.js app.html app.css app.js qpdf-worker.js zip.js lib icons"
OUT=dist; TMP=$(mktemp -d)
mkdir -p "$OUT"
rm -f "$OUT"/PDFGeek*.zip

mkdir "$TMP/pdfgeek"
cp -r $FILES manifest.json LICENSE "$TMP/pdfgeek/"
(cd "$TMP" && zip -qr -X pkg.zip pdfgeek)
for n in PDFGeek PDFGeek-chrome PDFGeek-edge; do cp "$TMP/pkg.zip" "$OUT/$n.zip"; done

mkdir "$TMP/ff"
cp -r $FILES LICENSE "$TMP/ff/"
cp manifest.firefox.json "$TMP/ff/manifest.json"
(cd "$TMP/ff" && zip -qr -X ../ff.zip .)
cp "$TMP/ff.zip" "$OUT/PDFGeek-firefox.zip"

rm -r "$TMP"
ls -l "$OUT"
