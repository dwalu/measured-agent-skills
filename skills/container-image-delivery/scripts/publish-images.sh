#!/usr/bin/env bash
#
# Publish several images INDEPENDENTLY, and fail at the end if any did not land.
#
# What this exists to prevent, observed in practice: a publish step written as
#
#     set -euo pipefail
#     for pair in "web:$WEB_IMAGE" "worker:$WORKER_IMAGE"; do
#       docker push ...
#     done
#
# The first failed push exits the step, so the second image is never attempted.
# The two artifacts were independent and shared no failure mode, so coupling
# them meant a bad minute on one upload cost both. In the case this was written
# from, the second image had NEVER been published: across four runs there were
# six push attempts, and not one of the six was an attempt at the second image.
# Nothing in the logs said so, because the loop simply ended.
#
# So: a partial publish is still RED — a release that produced half a set is not
# a release — but a partial publish now HAPPENS, which is what makes the re-run
# cheap. A registry answers `Layer already exists` for blobs it has, so
# re-running after a partial success is close to free for the image that landed
# and full price only for the one that did not. That property is the real retry
# budget, and it is worth more than extra attempts inside a single run.
#
# ORDER MATTERS: pass the SMALLEST image first. It banks the cheap artifact
# before the expensive one can spend the job's clock, and because a re-push of a
# landed image is nearly free, a run that gets the small one up and loses the
# big one leaves a re-run with the whole budget for the one that is missing.
#
# usage: publish-images.sh <repo> <primary-tag> <extra-tag> <name>=<local-tag> ...
#
# `extra-tag` may be empty — pass "" when not publishing a named release.

set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: publish-images.sh <repo> <primary-tag> <extra-tag> <name>=<local-tag> ..." >&2
  exit 2
fi

repo="$1"
primary_tag="$2"
extra_tag="$3"
shift 3

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
summary_file="${IMAGE_SUMMARY_FILE:-${GITHUB_STEP_SUMMARY:-}}"

if [ -n "$summary_file" ]; then
  {
    echo "### Published images"
    echo
    echo "Pin these by digest:"
    echo
  } >>"$summary_file"
fi

# Plain strings rather than arrays: an image name has no spaces, and `${arr[@]}`
# on an EMPTY array is an unbound-variable error under `set -u` in bash 3.2,
# which is what `/usr/bin/env bash` finds on macOS. This has to behave the same
# on a developer machine as on the runner.
published=""
failed=""

for pair in "$@"; do
  name="${pair%%=*}"
  local_tag="${pair#*=}"

  if [ -z "$name" ] || [ "$name" = "$pair" ]; then
    echo "::error::malformed argument '$pair'; expected <name>=<local-tag>"
    exit 2
  fi

  # `if` rather than `&&`/`||` so a failure here is data, not the end of the
  # script. Each call is a subprocess, so its own `set -e` still aborts IT on
  # the first bad command.
  if "$here/publish-image.sh" "$name" "$local_tag" "$repo" "$primary_tag" "$extra_tag"; then
    published="$published $name"
  else
    status=$?
    echo "::error::publishing $name failed with exit status $status; continuing with the rest"
    failed="$failed $name"
  fi
done

published="${published# }"
failed="${failed# }"

echo
echo "published: ${published:-none}"
echo "failed:    ${failed:-none}"

if [ -n "$failed" ]; then
  # Say it in the summary too. A release run's summary is what a human reads
  # before pinning digests, and "the image you were about to pin is not there"
  # belongs next to the ones that are.
  if [ -n "$summary_file" ]; then
    {
      echo
      echo "> **Incomplete.** \`$failed\` did not publish."
      echo "> This is not a deployable release — re-run the job."
      echo "> The images that did land re-push in seconds, so a re-run pays"
      echo "> full price only for the ones listed above."
    } >>"$summary_file"
  fi
  echo "::error::publish incomplete: $failed did not publish"
  exit 1
fi
