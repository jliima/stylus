#!/usr/bin/env bash
# Builds Stylus Themer for Firefox (dist-xpi/stylus-themer.xpi) and Chromium (dist-chrome-mv3/, load it unpacked).
# Install them with the Themer browser plugin: <themer>/plugins/browser/install.sh --firefox-xpi dist-xpi/*.xpi
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# nvm is often loaded lazily by the shell profile, so a script does not see node until nvm.sh is sourced.
if ! command -v npx >/dev/null && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi
# The pnpm version package.json pins (corepack 0.24 cannot start pnpm 12).
pnpm() {
  if command -v pnpm >/dev/null; then command pnpm "$@"
  else npx --yes "$(node -p "require('./package.json').packageManager.split('+')[0]")" "$@"; fi
}
[[ -d node_modules ]] || pnpm install
node tools/build.js build firefox
node tools/build.js build chrome mv3
mkdir -p dist-xpi
rm -f dist-xpi/stylus-themer.xpi
(cd dist-firefox-mv2 && zip -qr -X ../dist-xpi/stylus-themer.xpi .)
echo "Firefox:  $PWD/dist-xpi/stylus-themer.xpi"
echo "Chromium: $PWD/dist-chrome-mv3"
