#!/bin/bash
# Screenshots of every main screen on iPhone, iPad and Apple Watch simulators, in English and
# Simplified Chinese, using the app's built-in demo data:
#   bash scripts/screenshots.sh <Haptune.app (simulator build)> <HaptuneWatch.app> <output folder>
set -uo pipefail
APP="$1"; WATCH_APP="$2"; OUT="$3"
BUNDLE=com.haptune.app
mkdir -p "$OUT"

pick() {   # newest available simulator whose name starts with $1
  xcrun simctl list devices available -j | python3 -c "
import json, re, sys
best = None
for runtime, devices in json.load(sys.stdin)['devices'].items():
    m = re.search(r'(iOS|watchOS)-(\d+)-(\d+)', runtime)
    if not m:
        continue
    version = (int(m.group(2)), int(m.group(3)))
    for d in devices:
        if d['name'].startswith('$1') and (best is None or version > best[0]):
            best = (version, d['udid'])
print(best[1] if best else '')"
}

boot() {
  xcrun simctl boot "$1" 2>/dev/null
  xcrun simctl bootstatus "$1" -b >/dev/null
  xcrun simctl status_bar "$1" override --time 9:41 --batteryState charged --batteryLevel 100 2>/dev/null || true
}

shoot_phone() {   # udid label
  local UDID=$1 LABEL=$2
  boot "$UDID"
  xcrun simctl install "$UDID" "$APP"
  for LANG in en zh-Hans; do
    for SCREEN in summary library practice split mixer tools account paywall; do
      xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null
      xcrun simctl launch "$UDID" "$BUNDLE" -HaptuneDemo YES -HaptuneScreen "$SCREEN" -AppleLanguages "($LANG)" >/dev/null
      sleep 7
      xcrun simctl io "$UDID" screenshot "$OUT/$LABEL-$LANG-$SCREEN.png" >/dev/null
    done
  done
  xcrun simctl shutdown "$UDID"
}

IPHONE=$(pick "iPhone 1")
IPAD=$(pick "iPad Pro")
[ -z "$IPAD" ] && IPAD=$(pick "iPad")
[ -n "$IPHONE" ] && shoot_phone "$IPHONE" iphone
[ -n "$IPAD" ] && shoot_phone "$IPAD" ipad

WATCH=$(pick "Apple Watch")
if [ -n "$WATCH" ] && [ -d "$WATCH_APP" ]; then
  boot "$WATCH"
  xcrun simctl install "$WATCH" "$WATCH_APP"
  xcrun simctl launch "$WATCH" "$BUNDLE.watchkitapp" >/dev/null
  sleep 8
  xcrun simctl io "$WATCH" screenshot "$OUT/watch-coach.png" >/dev/null
  xcrun simctl shutdown "$WATCH"
fi
ls -la "$OUT"
