#!/usr/bin/env bash
#
# Run a command; run it again when the reason it failed was the network rather
# than your repository.
#
# Three design choices here are the whole point of the file, and each was
# arrived at by a failure rather than by taste. See SKILL.md §"The retry budget"
# for the measurements.
#
# 1. DELIBERATELY BLIND. It retries any non-zero exit and does not try to decide
#    whether the message looked transient. A pattern list for "transient" is a
#    list nobody maintains, and every message missing from it becomes a red
#    build that this script was added to prevent. The cost of retrying a genuine
#    failure is bounded when the expensive step (dependency install) comes first
#    and the cheap failure (type error, bad Dockerfile) comes after it.
#
# 2. THE BACKOFF DOUBLES. A flat delay is worse than it looks: with three
#    attempts and a flat 20s wait, all three attempts can land inside the same
#    ~90 seconds of one link-level fault — the first attempt uploads for minutes
#    and dies, and attempts two and three fail instantly on a HEAD before the
#    fault has gone anywhere. Three tries inside one fault is one try. Doubling
#    spreads the attempts over the minutes a real fault lasts.
#
# 3. RETRY_TIMEOUT_SECONDS BOUNDS ONE ATTEMPT, because a count is not a budget.
#    Every fault you have a log for is one the client *noticed* — it returned,
#    and the next attempt began. A connection that stalls without dying does not
#    do that: it consumes the whole job timeout and every remaining attempt with
#    it, and the job dies having produced nothing, which looks identical to a
#    slow transfer that was going to succeed. Capping one attempt converts a
#    stall into an ordinary retryable failure. Unset by default so existing call
#    sites are unchanged. `timeout` exits 124 when it fires, which is non-zero,
#    which is all the loop needs.
#
# Tunables (all optional):
#   RETRY_ATTEMPTS         default 3
#   RETRY_DELAY_SECONDS    default 30 — the FIRST wait, not every wait
#   RETRY_TIMEOUT_SECONDS  default unset — no per-attempt bound
#
# The `::warning::`/`::error::` prefixes are GitHub Actions annotations. They are
# harmless plain text on any other CI system.

set -euo pipefail

attempts="${RETRY_ATTEMPTS:-3}"
delay="${RETRY_DELAY_SECONDS:-30}"
attempt_timeout="${RETRY_TIMEOUT_SECONDS:-}"

if [ "$#" -eq 0 ]; then
  echo "usage: retry.sh <command> [args...]" >&2
  exit 2
fi

if [ -n "$attempt_timeout" ] && ! command -v timeout >/dev/null 2>&1; then
  echo "::warning::RETRY_TIMEOUT_SECONDS is set but 'timeout' is not installed; attempts will be unbounded" >&2
  attempt_timeout=""
fi

attempt=1
while true; do
  status=0
  if [ -n "$attempt_timeout" ]; then
    # `--kill-after`, because the thing being bounded is a process that has
    # stopped responding: TERM asks, KILL is what actually ends it.
    timeout --kill-after=30s "$attempt_timeout" "$@" || status=$?
    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
      echo "::warning::'$*' exceeded the ${attempt_timeout}s per-attempt limit and was killed"
    fi
  else
    "$@" || status=$?
  fi

  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  if [ "$attempt" -ge "$attempts" ]; then
    # `::error::` rather than a bare echo: after N attempts this is the run's
    # actual cause of death, and it should be the annotation the CI UI shows.
    echo "::error::'$*' failed on all $attempts attempts; last exit status $status"
    exit "$status"
  fi

  echo "::warning::'$*' failed with exit status $status on attempt $attempt of $attempts; retrying in ${delay}s"
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
done
