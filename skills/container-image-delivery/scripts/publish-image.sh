#!/usr/bin/env bash
#
# Publish ONE image to a registry: tag it, push every tag with retries, then
# resolve and ASSERT the digest a deployment can pin.
#
# This is a separate process rather than a shell function, and that is the whole
# point of the file. Its caller has to survive this failing, so it calls into a
# tested context — and bash disables `set -e` *inside* a function whose failure
# is tested (`f || status=$?`, `if f; then`). A function would therefore keep
# running past a failed `docker push` and go on to assert the digest of an image
# it never pushed. A subprocess keeps `set -e` honest: the first failure here is
# the exit status the caller sees.
#
# usage: publish-image.sh <name> <local-tag> <repo> <primary-tag> [extra-tag]
#
#   name         repository name under $repo, and the suffix of the
#                <NAME>_IMAGE line written to the step summary.
#   local-tag    the locally built tag to publish.
#   repo         registry + namespace, e.g. ghcr.io/acme/product
#   primary-tag  the immutable tag a deployment pins — usually the commit sha.
#   extra-tag    optional; a release name such as v1.2.3.
#
# Environment:
#   RETRY_ATTEMPTS / RETRY_DELAY_SECONDS / RETRY_TIMEOUT_SECONDS  → retry.sh
#   IMAGE_SUMMARY_FILE   if set, receives one `<NAME>_IMAGE="<digest>"` line —
#                        and receives it ONLY on success, so a summary never
#                        advertises an image that is not in the registry.
#                        Defaults to $GITHUB_STEP_SUMMARY when that is set.
#   PUSH_LATEST          "false" to skip the floating tag. Default true.

set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: publish-image.sh <name> <local-tag> <repo> <primary-tag> [extra-tag]" >&2
  exit 2
fi

name="$1"
local_tag="$2"
repo="$3"
primary_tag="$4"
extra_tag="${5:-}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
summary_file="${IMAGE_SUMMARY_FILE:-${GITHUB_STEP_SUMMARY:-}}"
push_latest="${PUSH_LATEST:-true}"
target="$repo/$name"

echo "==> publishing $name from $local_tag to $target"

docker tag "$local_tag" "$target:$primary_tag"

# The immutable tag first, deliberately. It is the one a deployment pins, so if
# the link dies partway through this image it should die having landed the tag
# that matters rather than the floating one.
"$here/retry.sh" docker push "$target:$primary_tag"

if [ "$push_latest" != "false" ]; then
  docker tag "$local_tag" "$target:latest"
  "$here/retry.sh" docker push "$target:latest"
fi

if [ -n "$extra_tag" ]; then
  docker tag "$local_tag" "$target:$extra_tag"
  "$here/retry.sh" docker push "$target:$extra_tag"
fi

# `RepoDigests` is a LIST — one entry per repository the image ID has answered
# to. On a persistent runner the local build tag has an entry of its own, so
# `{{index .RepoDigests 0}}` can return a perfectly correct digest under a
# repository name the registry has never heard of. That is exactly the value
# nobody should paste into a deployment. Match the prefix instead.
#
# `|| true` because a no-match is an outcome this script reports itself, not a
# reason for `set -e` to kill it without a message.
digest="$(docker inspect \
  --format '{{range .RepoDigests}}{{println .}}{{end}}' \
  "$target:$primary_tag" |
  grep -m1 "^$target@sha256:" || true)"

# Assert, do not print. A step that echoes an empty line and exits zero looks
# exactly like a step that published something.
if [ -z "$digest" ]; then
  echo "::error::$target has no digest for this registry; docker knows it as:"
  docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$target:$primary_tag"
  exit 1
fi

echo "$digest"

if [ -n "$summary_file" ]; then
  echo "    $(echo "$name" | tr '[:lower:]-' '[:upper:]_')_IMAGE=\"$digest\"" >>"$summary_file"
fi
