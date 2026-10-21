#!/bin/sh
set -e
# One container per profile lease, so a lock left by a killed container is stale and safe to drop.
rm -f /profile/SingletonLock /profile/SingletonSocket /profile/SingletonCookie
export HOME=/tmp/home
mkdir -p "$HOME"
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
export DISPLAY=:99
# Chrome binds its debugging port to the container loopback only; forward it on the container interface.
socat TCP-LISTEN:9222,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9221 &
# shellcheck disable=SC2086
exec chromium $CHROME_FLAGS --user-data-dir=/profile --remote-debugging-port=9221 \
  --no-first-run --no-default-browser-check --window-size=1280,720 about:blank
