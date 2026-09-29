#!/usr/bin/env bash
#
# Prove that publishing one image cannot skip another.
#
# WHY THIS EXISTS AT ALL. A publish step usually runs only on a release, so no
# pull request ever executes a line of it. That is not a gap in coverage, it is
# a structural blind spot: in the case this was written from, a loop that could
# not publish the second image survived four runs and six push attempts without
# anyone seeing it, because the only runs that executed the code were the ones
# nobody was watching. A step that only runs when it matters is a step nobody
# has tested.
#
# This runs the SHIPPED publish scripts against a real registry using images
# small enough that the whole check costs seconds and moves no bytes off the
# machine. Wire it into the pull-request path, NOT behind the publish gate.
#
# Three cases, and the first is the regression itself:
#
#   A  Both pushes fail (nothing listening). Both must still be ATTEMPTED.
#      Under a `set -e` loop the second never is.
#   B  Both pushes succeed. Exit 0, a digest line for each in the summary, and
#      both tags really present according to the REGISTRY (not docker's local
#      view, which would also be satisfied by a push that never left).
#   C  The first image fails and the second succeeds. The second must publish
#      (a partial publish happens) and the run must still be red (a partial
#      publish is not a release).
#
# VERIFY IT REDDENS. Re-introduce the coupled loop in publish-images.sh and run
# this: it must fail, and the case-A assertions are the ones that must fail. A
# proof that cannot go red proves nothing.
#
# Environment: REGISTRY_PORT (default 5000), DEAD_PORT (default 5999, which must
# have nothing listening on it).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
registry_port="${REGISTRY_PORT:-5000}"
dead_port="${DEAD_PORT:-5999}"

good="127.0.0.1:$registry_port/publish-test"
dead="127.0.0.1:$dead_port/publish-test"
tag="testtag"

container="publish-images-test-registry"
ctx=""
summary=""
failures=0

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker image rm -f tiny-alpha:test tiny-beta:test >/dev/null 2>&1 || true
  for reg in "$good" "$dead"; do
    for n in alpha beta; do
      docker image rm -f "$reg/$n:$tag" "$reg/$n:latest" "$reg/$n:${tag}c" >/dev/null 2>&1 || true
    done
  done
  if [ -n "$ctx" ]; then rm -rf "$ctx"; fi
  if [ -n "$summary" ]; then rm -f "$summary"; fi
  return 0
}
trap cleanup EXIT

fail() {
  echo "::error::FAIL: $*"
  failures=$((failures + 1))
}
ok() { echo "  ok: $*"; }

# Nothing may be listening on the dead port, or case A proves nothing.
if curl -fsS --max-time 2 "http://127.0.0.1:$dead_port/" >/dev/null 2>&1; then
  echo "::error::something is listening on the 'dead' port $dead_port; set DEAD_PORT"
  exit 2
fi

echo "==> starting a registry on 127.0.0.1:$registry_port"
docker rm -f "$container" >/dev/null 2>&1 || true

# Pulled explicitly and WITH RETRIES rather than implicitly by `docker run`,
# because this is the one thing in the check that leaves the machine. An
# unretried network fetch inside a required job is exactly the shape that makes
# people leave jobs advisory; putting a new one back would undo that on the
# first bad minute.
"$here/retry.sh" docker pull registry:2

docker run -d --name "$container" -p "127.0.0.1:$registry_port:5000" registry:2 >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$registry_port/v2/" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS --max-time 2 "http://127.0.0.1:$registry_port/v2/" >/dev/null 2>&1; then
  echo "::error::registry never became ready on 127.0.0.1:$registry_port"
  exit 1
fi

# Two images that are images in every way that matters here and weigh almost
# nothing. `FROM scratch` pulls no base layer.
echo "==> building two tiny images"
ctx="$(mktemp -d)"
echo payload >"$ctx/f"
printf 'FROM scratch\nCOPY f /f\n' >"$ctx/Dockerfile"
docker build -q -t tiny-alpha:test "$ctx" >/dev/null
docker build -q -t tiny-beta:test "$ctx" >/dev/null

summary="$(mktemp)"

# ---------------------------------------------------------------- case A -----
echo
echo "==> case A: both pushes fail — both must still be attempted"
outA=""
statusA=0
outA="$(RETRY_ATTEMPTS=1 RETRY_DELAY_SECONDS=0 IMAGE_SUMMARY_FILE="" \
  "$here/publish-images.sh" "$dead" "$tag" "" \
  alpha=tiny-alpha:test beta=tiny-beta:test 2>&1)" || statusA=$?
echo "$outA" | sed 's/^/    | /'

if [ "$statusA" -ne 0 ]; then
  ok "A: exited $statusA"
else
  fail "A: expected a non-zero exit when every push failed"
fi

if echo "$outA" | grep -q "publishing alpha failed"; then
  ok "A: the first image's failure was recorded rather than fatal"
else
  fail "A: the first image's failure was not recorded — it ended the run instead"
fi
if echo "$outA" | grep -q "publishing beta failed"; then
  ok "A: the second image was attempted after the first failed — this is the fix"
else
  fail "A: the second image was NOT attempted — the regression is back"
fi

# ---------------------------------------------------------------- case B -----
echo
echo "==> case B: both pushes succeed"
: >"$summary"
outB=""
statusB=0
outB="$(RETRY_ATTEMPTS=1 RETRY_DELAY_SECONDS=0 IMAGE_SUMMARY_FILE="$summary" \
  "$here/publish-images.sh" "$good" "$tag" "" \
  alpha=tiny-alpha:test beta=tiny-beta:test 2>&1)" || statusB=$?
echo "$outB" | sed 's/^/    | /'

if [ "$statusB" -eq 0 ]; then ok "B: exited 0"; else fail "B: expected exit 0, got $statusB"; fi

for n in alpha beta; do
  upper="$(echo "$n" | tr '[:lower:]' '[:upper:]')"
  if grep -q "${upper}_IMAGE=\"$good/$n@sha256:" "$summary"; then
    ok "B: summary carries a real digest for $n"
  else
    fail "B: summary has no digest line for $n"
    sed 's/^/    summary| /' "$summary"
  fi
  # The registry, not docker's local view, is the authority on what published.
  if curl -fsS --max-time 5 "http://127.0.0.1:$registry_port/v2/publish-test/$n/tags/list" |
    grep -q "$tag"; then
    ok "B: the registry really has publish-test/$n:$tag"
  else
    fail "B: the registry does not have publish-test/$n:$tag"
  fi
done

# ---------------------------------------------------------------- case C -----
echo
echo "==> case C: the first image fails, the second must still publish"
: >"$summary"
outC=""
statusC=0
outC="$(RETRY_ATTEMPTS=1 RETRY_DELAY_SECONDS=0 IMAGE_SUMMARY_FILE="$summary" \
  "$here/publish-images.sh" "$good" "${tag}c" "" \
  alpha=does-not-exist:anywhere beta=tiny-beta:test 2>&1)" || statusC=$?
echo "$outC" | sed 's/^/    | /'

if [ "$statusC" -ne 0 ]; then ok "C: still red ($statusC)"; else fail "C: a partial publish must not exit 0"; fi

if echo "$outC" | grep -qE "^published: +beta$"; then
  ok "C: the second image published even though the first failed"
else
  fail "C: the second image did not publish after the first failed"
fi
if echo "$outC" | grep -qE "^failed: +alpha$"; then
  ok "C: the first image is reported as the one that failed"
else
  fail "C: the first image is not reported as failed"
fi
if grep -q "Incomplete" "$summary"; then
  ok "C: the summary says the release is incomplete"
else
  fail "C: the summary does not warn that the release is incomplete"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "::error::publish-images.test.sh: $failures assertion(s) failed"
  exit 1
fi
echo "publish-images.test.sh: all assertions passed"
