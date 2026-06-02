#!/usr/bin/env bash
# Calls run headless, so there is no virtual display / VNC to boot - just start
# the backend (it serves the dashboard + control/audio WS). tini (ENTRYPOINT)
# is PID 1 and reaps Chromium child processes.
set -eo pipefail

exec node server.js
