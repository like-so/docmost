#!/bin/sh
set -u
stdout_file="$1"
stderr_file="$2"
metadata_file="$3"
child_cmd='/opt/homebrew/bin/colima start default --activate=false'
started_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
started_epoch=$(date -u '+%s')
$child_cmd >"$stdout_file" 2>"$stderr_file" &
child_pid=$!
timed_out=false
term_sent=false
kill_sent=false
child_exit=''
while kill -0 "$child_pid" 2>/dev/null; do
  now_epoch=$(date -u '+%s')
  if [ $((now_epoch - started_epoch)) -ge 300 ]; then
    timed_out=true
    kill -TERM "$child_pid" 2>/dev/null || true
    term_sent=true
    waited=0
    while kill -0 "$child_pid" 2>/dev/null && [ "$waited" -lt 30 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$child_pid" 2>/dev/null; then
      kill -KILL "$child_pid" 2>/dev/null || true
      kill_sent=true
    fi
    break
  fi
  sleep 1
done
if wait "$child_pid"; then
  child_exit=0
else
  child_exit=$?
fi
ended_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
ended_epoch=$(date -u '+%s')
duration=$((ended_epoch - started_epoch))
if [ "$timed_out" = true ]; then
  wrapper_exit=124
else
  wrapper_exit="$child_exit"
fi
printf '{\n  "command": "%s",\n  "child_pid": %s,\n  "started_at_utc": "%s",\n  "ended_at_utc": "%s",\n  "duration_seconds": %s,\n  "timed_out": %s,\n  "sigterm_sent_to_owned_child": %s,\n  "sigkill_sent_to_owned_child": %s,\n  "child_exit": %s,\n  "wrapper_exit": %s\n}\n' \
  "$child_cmd" "$child_pid" "$started_at" "$ended_at" "$duration" "$timed_out" "$term_sent" "$kill_sent" "$child_exit" "$wrapper_exit" > "$metadata_file"
exit "$wrapper_exit"
