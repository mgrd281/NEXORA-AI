#!/usr/bin/env bash
# Build the iPhone app and upload it to TestFlight from the terminal (no Xcode window needed).
# Needs: Xcode installed (command line tools selected), xcodegen, an App Store Connect API key.
#
#   cd ~/NEXORA-AI && git pull && bash apps/ios/scripts/testflight.sh
#
# Optional environment: P8 (path of AuthKey_*.p8), KEYID, ISSUER, TEAM, BUNDLE, API_BASE.
# Secrets are read without echo and never written to the repository or the log.
set -euo pipefail

cd "$(dirname "$0")/.."

P8="${P8:-$(ls -t "$HOME"/Desktop/AuthKey_*.p8 "$HOME"/Downloads/AuthKey_*.p8 2>/dev/null | head -1)}"
[ -f "${P8:-}" ] || { echo "Keine AuthKey_*.p8 gefunden. Setze P8=/Pfad/AuthKey_XXXX.p8"; exit 1; }
KEYID="${KEYID:-$(basename "$P8" .p8 | sed 's/^AuthKey_//')}"
TEAM="${TEAM:-3227J7CBXY}"
BUNDLE="${BUNDLE:-com.mgrdegh.jarvis}"
API_BASE="${API_BASE:-https:/\$()/jarvisweb-production-0026.up.railway.app/api}"
if [ -z "${ISSUER:-}" ]; then
  read -rs -p "Issuer ID (versteckt): " ISSUER; echo
fi
BUILD="$(date +%y%m%d%H%M)"
LOG="$HOME/Desktop/jarvis-build.log"

command -v xcodegen >/dev/null || brew install xcodegen
xcodebuild -version

printf 'JARVIS_API_BASE_URL = %s\n' "$API_BASE" > Config/Local.xcconfig
xcodegen generate

AUTH=(-allowProvisioningUpdates
  -authenticationKeyPath "$P8"
  -authenticationKeyID "$KEYID"
  -authenticationKeyIssuerID "$ISSUER")

rm -rf build
echo "== Archive (Build $BUILD) =="
if ! xcodebuild archive \
    -project Jarvis.xcodeproj -scheme Jarvis \
    -destination 'generic/platform=iOS' -configuration Release \
    -archivePath build/Jarvis.xcarchive \
    "${AUTH[@]}" \
    DEVELOPMENT_TEAM="$TEAM" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" \
    CURRENT_PROJECT_VERSION="$BUILD" \
    > "$LOG" 2>&1; then
  echo
  echo "BUILD FEHLGESCHLAGEN. Fehler (kopiere NUR diese Zeilen):"
  echo "----------------------------------------------------------"
  grep -E "error:" "$LOG" | sed "s#$PWD/##" | sort -u | head -60
  echo "----------------------------------------------------------"
  echo "Vollständiges Log: $LOG"
  exit 1
fi

cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>${TEAM}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST

echo "== Export + Upload zu TestFlight =="
if ! xcodebuild -exportArchive \
    -archivePath build/Jarvis.xcarchive \
    -exportOptionsPlist build/ExportOptions.plist \
    -exportPath build/export \
    "${AUTH[@]}" >> "$LOG" 2>&1; then
  echo "UPLOAD FEHLGESCHLAGEN. Letzte Zeilen:"
  tail -25 "$LOG" | sed "s#$PWD/##"
  exit 1
fi
unset ISSUER
echo "FERTIG: Build $BUILD wurde zu App Store Connect hochgeladen."
echo "Nach ca. 5-15 Minuten erscheint er unter App Store Connect > JARVIS > TestFlight."
