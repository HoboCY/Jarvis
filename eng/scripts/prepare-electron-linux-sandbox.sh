#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Electron sandbox preparation accepts no arguments." >&2
  exit 2
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Linux Electron sandbox preparation is not required on this platform."
  exit 0
fi

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper_path="$script_directory/prepare-electron-linux-sandbox.mjs"
pin_helper_path="$script_directory/prepare-electron-linux-sandbox-pin.mjs"
repository_root="$(cd "$script_directory/../.." && pwd -P)"

fail() {
  echo "Electron sandbox preparation failed: $1" >&2
  exit 1
}

sandbox_path="$(node "$helper_path" --resolve 2>/dev/null)" \
  || fail "could not resolve the installed Electron sandbox."
if [[ -z "$sandbox_path" || "$(basename -- "$sandbox_path")" != "chrome-sandbox" ]]; then
  fail "resolved target is not the Electron chrome-sandbox file."
fi

pin_output="$(mktemp "${TMPDIR:-/tmp}/jarvis-electron-sandbox-pin.XXXXXX")" \
  || fail "could not create the sandbox pin handoff."
pin_pid=""
cleanup_pin() {
  if [[ -n "$pin_pid" ]]; then
    kill -TERM "$pin_pid" >/dev/null 2>&1 || true
    wait "$pin_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$pin_output" ]]; then
    rm -f -- "$pin_output"
  fi
}
trap cleanup_pin EXIT

cd "$repository_root"
node "$pin_helper_path" --pin >"$pin_output" 2>/dev/null &
pin_pid="$!"
pin_handshake=""
for attempt in {1..50}; do
  if IFS= read -r pin_handshake <"$pin_output"; then
    break
  fi
  if ! kill -0 "$pin_pid" >/dev/null 2>&1; then
    fail "could not pin the installed Electron sandbox."
  fi
  sleep 0.1
done
if [[ ! "$pin_handshake" =~ ^PID=([0-9]+)[[:space:]]FD=([0-9]+)[[:space:]]DEV=([0-9]+)[[:space:]]INO=([0-9]+)[[:space:]]NLINK=([0-9]+)$ ]]; then
  fail "could not pin the installed Electron sandbox."
fi
reported_pin_pid="${BASH_REMATCH[1]}"
pin_fd="${BASH_REMATCH[2]}"
pin_dev="${BASH_REMATCH[3]}"
pin_ino="${BASH_REMATCH[4]}"
pin_nlink="${BASH_REMATCH[5]}"
if [[ "$reported_pin_pid" != "$pin_pid" || ! "$pin_fd" =~ ^[0-9]+$ \
  || ! "$pin_dev" =~ ^[0-9]+$ || ! "$pin_ino" =~ ^[0-9]+$ || ! "$pin_nlink" =~ ^[0-9]+$ ]]; then
  fail "could not pin the installed Electron sandbox."
fi

mutator_code='
import os
import stat
import sys

def fail():
    raise RuntimeError()

def decimal(value, maximum):
    if not value.isascii() or not value.isdecimal() or len(value) > 20:
        fail()
    number = int(value, 10)
    if number < 0 or number > maximum:
        fail()
    return number

if len(sys.argv) != 6:
    fail()
pid = decimal(sys.argv[1], 2147483647)
fd_number = decimal(sys.argv[2], 1048575)
expected_dev = decimal(sys.argv[3], 18446744073709551615)
expected_ino = decimal(sys.argv[4], 18446744073709551615)
expected_nlink = decimal(sys.argv[5], 1048575)
if expected_nlink != 1:
    fail()
foreign_fd_path = "/proc/{}/fd/{}".format(pid, fd_number)
required_nonblocking = getattr(os, "O_NONBLOCK", 0)
if required_nonblocking == 0:
    fail()
open_flags = os.O_RDONLY | required_nonblocking | getattr(os, "O_CLOEXEC", 0)
descriptor = os.open(foreign_fd_path, open_flags)
try:
    before = os.fstat(descriptor)
    before_identity = (before.st_dev, before.st_ino, before.st_nlink)
    if not stat.S_ISREG(before.st_mode) or before_identity != (expected_dev, expected_ino, expected_nlink):
        fail()
    os.fchown(descriptor, 0, 0)
    os.fchmod(descriptor, 0o4755)
    after = os.fstat(descriptor)
    after_identity = (after.st_dev, after.st_ino, after.st_nlink)
    if not stat.S_ISREG(after.st_mode) or after_identity != before_identity:
        fail()
    if after.st_uid != 0 or after.st_gid != 0 or (after.st_mode & 0o7777) != 0o4755:
        fail()
finally:
    os.close(descriptor)
'
if ! sudo -n /usr/bin/python3 -I -S -c "$mutator_code" \
  "$pin_pid" "$pin_fd" "$pin_dev" "$pin_ino" "$pin_nlink" >/dev/null 2>&1; then
  fail "could not mutate and verify the pinned Electron sandbox."
fi
if ! kill -USR1 "$pin_pid" >/dev/null 2>&1; then
  fail "could not verify the pinned Electron sandbox."
fi
if ! wait "$pin_pid" >/dev/null 2>&1; then
  pin_pid=""
  fail "could not verify the pinned Electron sandbox."
fi
pin_pid=""

resolved_sandbox_path="$(node "$helper_path" --resolve 2>/dev/null)" \
  || fail "could not re-resolve the installed Electron sandbox."
if [[ "$resolved_sandbox_path" != "$sandbox_path" ]]; then
  fail "Electron sandbox target changed during preparation."
fi

attributes="$(stat -c '%u:%g:%a' -- "$resolved_sandbox_path" 2>/dev/null)" \
  || fail "could not inspect the Electron sandbox after preparation."
if [[ "$attributes" != "0:0:4755" ]]; then
  fail "Electron sandbox ownership or mode verification failed."
fi

echo "Electron Linux sandbox prepared and verified."
