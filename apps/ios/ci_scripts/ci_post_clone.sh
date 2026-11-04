#!/bin/sh
# Xcode Cloud runs this after cloning the repository. The Xcode project is generated from
# project.yml, so generate it here and point the app at the deployed server.
set -e
cd "$CI_PRIMARY_REPOSITORY_PATH/apps/ios"
brew install xcodegen
printf 'JARVIS_API_BASE_URL = %s\n' 'https:/$()/jarvisweb-production-0026.up.railway.app/api' > Config/Local.xcconfig
xcodegen generate
