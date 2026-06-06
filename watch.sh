#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_LOG="${ROOT_DIR}/.watch-build.log"
JUPYTER_LOG="${ROOT_DIR}/.watch-jupyter.log"
WATCH_LOG="${ROOT_DIR}/.watch.log"
PORT="${PORT:-8889}"

hash_tree() {
  find "$ROOT_DIR" \
    \( -path "$ROOT_DIR/.git" -o -path "$ROOT_DIR/.venv" -o -path "$ROOT_DIR/node_modules" -o -path "$ROOT_DIR/lib" -o -path "$ROOT_DIR/build-core" -o -path "$ROOT_DIR/jupyterlab_nitro_ai_judge/labextension" \) -prune \
    -o -type f \
    ! -name '.watch.log' \
    ! -name '.watch-build.log' \
    ! -name '.watch-jupyter.log' \
    -print \
    | sort \
    | xargs stat -c '%n %Y %s' 2>/dev/null \
    | sha256sum \
    | awk '{print $1}'
}

start_jupyter() {
  nohup "${ROOT_DIR}/.venv/bin/jupyter" lab \
    --no-browser \
    --ServerApp.ip=0.0.0.0 \
    --ServerApp.port="${PORT}" \
    >"${JUPYTER_LOG}" 2>&1 &
  JUPYTER_PID=$!
  echo "started jupyter lab pid=${JUPYTER_PID} port=${PORT}" >>"${WATCH_LOG}"
}

stop_jupyter() {
  if [[ -n "${JUPYTER_PID:-}" ]] && kill -0 "${JUPYTER_PID}" 2>/dev/null; then
    kill "${JUPYTER_PID}" 2>/dev/null || true
    wait "${JUPYTER_PID}" 2>/dev/null || true
  fi
}

rebuild_and_restart() {
  echo "$(date -Iseconds) rebuilding" >>"${WATCH_LOG}"
  if npm run build:prod >"${BUILD_LOG}" 2>&1; then
    stop_jupyter
    start_jupyter
    echo "$(date -Iseconds) rebuild complete" >>"${WATCH_LOG}"
  else
    echo "$(date -Iseconds) rebuild failed" >>"${WATCH_LOG}"
    tail -n 40 "${BUILD_LOG}" >>"${WATCH_LOG}" 2>/dev/null || true
  fi
}

trap 'stop_jupyter' EXIT

: >"${WATCH_LOG}"
echo "watch started $(date -Iseconds)" >>"${WATCH_LOG}"
JUPYTER_PID=""
rebuild_and_restart
LAST_HASH="$(hash_tree)"

while true; do
  CURRENT_HASH="$(hash_tree)"
  if [[ "${CURRENT_HASH}" != "${LAST_HASH}" ]]; then
    LAST_HASH="${CURRENT_HASH}"
    rebuild_and_restart
  fi
  sleep 2
done
