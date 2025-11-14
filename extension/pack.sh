#!/bin/bash
set -euxo pipefail
cd "$(dirname "$0")"
cd src
rm -f ../codex-browser-bridge-chrome.zip
# Create the .zip
7z a -tzip -mx=9 -r ../codex-browser-bridge-chrome.zip *
