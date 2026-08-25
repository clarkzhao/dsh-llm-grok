#!/usr/bin/env bash
# Install a per-user macOS launchd agent that copies the Grok CLI access
# token into DSH's credentials file every 5 minutes.
#
# Usage:
#   ./scripts/install-launchd.sh           # install / reload
#   ./scripts/install-launchd.sh status    # print launchctl state
#   ./scripts/install-launchd.sh uninstall # bootout and remove plist
#
# END_USAGE
set -euo pipefail

ACTION="${1:-install}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/sync-grok-credential.py"
PYTHON="${SYNC_GROK_PYTHON:-/usr/bin/python3}"
USER_SAFE="$(id -un | tr -c 'A-Za-z0-9._-' '_' | sed 's/_$//')"
LABEL="${SYNC_GROK_LABEL:-com.${USER_SAFE}.sync-grok-credential}"
LOG="${SYNC_GROK_LOG:-/tmp/sync-grok-credential.log}"
LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"
HOME_PLIST="${LAUNCH_AGENTS}/${LABEL}.plist"
REPO_PLIST_DIR="${REPO_ROOT}/launchd"
REPO_PLIST="${REPO_PLIST_DIR}/${LABEL}.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

usage() {
  sed -n '2,/^# END_USAGE$/p' "$0" | sed '/END_USAGE/d; s/^# \{0,1\}//'
}

write_plist() {
  local dest="$1"
  mkdir -p "$(dirname "$dest")"
  cat >"$dest" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${PYTHON}</string>
        <string>${SCRIPT}</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG}</string>
    <key>StandardErrorPath</key>
    <string>${LOG}</string>
</dict>
</plist>
EOF
}

bootout_if_loaded() {
  if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  fi
}

print_status() {
  echo "label:  ${LABEL}"
  echo "script: ${SCRIPT}"
  echo "log:    ${LOG}"
  if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    launchctl print "${DOMAIN}/${LABEL}" | awk '
      /state =/ || /program =/ || /run interval/ || /last exit code/ || /path =/ { print }
    '
    echo
    echo "note: state = not running is normal. The script exits in milliseconds;"
    echo "      launchd is waiting for the next 300s interval."
  else
    echo "launchd: not loaded"
  fi
}

uninstall() {
  bootout_if_loaded
  rm -f "$HOME_PLIST" "$REPO_PLIST"
  echo "removed ${LABEL}"
}

install_agent() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "install-launchd.sh is macOS-only. On Linux see docs/credential-sync.md (cron)." >&2
    exit 1
  fi
  if [[ ! -x "$PYTHON" ]]; then
    echo "python not executable: $PYTHON" >&2
    exit 1
  fi
  if [[ ! -f "$SCRIPT" ]]; then
    echo "missing sync script: $SCRIPT" >&2
    exit 1
  fi
  chmod +x "$SCRIPT" || true

  write_plist "$REPO_PLIST"

  local plist="$REPO_PLIST"
  local copied=0
  mkdir -p "$LAUNCH_AGENTS"
  if cp "$REPO_PLIST" "$HOME_PLIST" 2>/dev/null; then
    plist="$HOME_PLIST"
    copied=1
  else
    echo "warning: could not write ${HOME_PLIST}"
    echo "         (common when the agent sandbox blocks ~/Library/LaunchAgents)."
    echo "         loading from the repo copy instead:"
    echo "         ${REPO_PLIST}"
    echo "         copy it into ~/Library/LaunchAgents/ later if you want it to"
    echo "         survive a reboot:"
    echo "           cp \"${REPO_PLIST}\" \"${HOME_PLIST}\""
  fi

  bootout_if_loaded
  launchctl bootstrap "$DOMAIN" "$plist"

  echo "loaded ${LABEL} from ${plist}"
  if [[ "$copied" -eq 0 ]]; then
    echo "persist: NOT in ~/Library/LaunchAgents — reboot may drop this job."
  else
    echo "persist: ${HOME_PLIST}"
  fi

  "$PYTHON" "$SCRIPT" || true
  print_status
}

case "$ACTION" in
  install|"") install_agent ;;
  status) print_status ;;
  uninstall|remove) uninstall ;;
  -h|--help|help) usage ;;
  *)
    echo "unknown action: $ACTION" >&2
    usage >&2
    exit 2
    ;;
esac
