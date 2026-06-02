#!/usr/bin/env bash
# Boots the virtual display + VNC bridge, then the Node backend (PID 1 via tini).
set -eo pipefail

export DISPLAY="${DISPLAY:-:99}"
DISP_NUM="${DISPLAY#:}"

# 1) Virtual framebuffer so Chromium can run "headed" with no real monitor.
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp &

# Wait for the X socket to appear before starting the VNC server.
for _ in $(seq 1 50); do
  [ -S "/tmp/.X11-unix/X${DISP_NUM}" ] && break
  sleep 0.2
done

# 2) Export the display over VNC (localhost only; reached solely through the
#    backend's authenticated /vnc proxy, never published directly).
x11vnc -display "$DISPLAY" -rfbport 5900 -localhost -forever -shared -nopw -quiet -bg

# 3) noVNC web client + WebSocket-to-VNC bridge on localhost:6080.
websockify --web=/usr/share/novnc 6080 localhost:5900 &

# 4) Backend: serves the dashboard, /control + /audio WS, and the /vnc proxy.
exec node server.js
