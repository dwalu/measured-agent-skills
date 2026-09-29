#!/usr/bin/env bash
#
# Answer "which layer is most of my push?" — the question that decides whether a
# retry can help you, and the one `docker images` cannot answer.
#
# Default mode prints the UNCOMPRESSED histogram from `docker history`. That is
# enough to spot a dominant layer, but it is not what crosses the wire.
#
# `--compressed` prints the REGISTRY-COMPRESSED blob sizes, which is the number
# that matters, by pushing to a throwaway local registry on loopback and reading
# the manifest back. This is fast (no upstream bytes) and exact — far better
# than estimating, and better than reading a real push log, which you only get
# after the slow push you were trying to avoid.
#
# usage:
#   layer-report.sh <image>                # uncompressed, from docker history
#   layer-report.sh --compressed <image>   # exact compressed blob sizes
#
# Environment: REGISTRY_PORT (default 5000) for --compressed.

set -euo pipefail

compressed=false
if [ "${1:-}" = "--compressed" ]; then
  compressed=true
  shift
fi

image="${1:-}"
if [ -z "$image" ]; then
  echo "usage: layer-report.sh [--compressed] <image>" >&2
  exit 2
fi

if [ "$compressed" = false ]; then
  echo "== uncompressed layers of $image (newest first, as docker history reports) =="
  echo "NOTE: this is the on-disk size. What a push uploads is the compressed"
  echo "      blob — re-run with --compressed for the number that matters."
  echo

  hist="$(mktemp)"
  trap 'rm -f "$hist"' EXIT
  docker history --no-trunc --format '{{.Size}}|{{.CreatedBy}}' "$image" >"$hist"

  # Two passes over the same file: the first totals, the second reports
  # percentages. A single pipeline cannot do this — the shell would have to
  # expand the total before the pipeline that computes it has run.
  awk -F'|' '
    function bytes(s,   n, u, m) {
      n = s + 0
      u = s; sub(/^[0-9.]+/, "", u); sub(/^[ ]+/, "", u)
      m = (u ~ /^[kK]B/) ? 1000 : (u ~ /^MB/) ? 1000000 : (u ~ /^GB/) ? 1000000000 : 1
      return n * m
    }
    function human(b,   i, n, s, u) {
      s = "B kB MB GB"; n = split(s, u, " ")
      for (i = 1; i <= n && b >= 1000 && i < n; i++) b /= 1000
      return sprintf("%.1f %s", b, u[i])
    }
    NR == FNR { total += bytes($1); next }
    {
      b = bytes($1)
      pct = (total > 0) ? 100 * b / total : 0
      if (pct > top) top = pct
      printf "  %10s  %5.1f%%  %s\n", human(b), pct, substr($2, 1, 96)
    }
    END {
      printf "\n  %10s  total\n", human(total)
      printf "  largest layer is %.1f%% of the image\n", top
      if (top > 40)
        print "\n  >>> One layer dominates. `docker push` resumes at LAYER granularity\n      only — there is no resume inside a blob — so every retry re-uploads\n      this from byte zero. Split the layer before touching retry counts."
    }
  ' "$hist" "$hist"
  exit 0
fi

port="${REGISTRY_PORT:-5000}"
container="layer-report-registry"
ref="127.0.0.1:$port/layer-report:probe"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker image rm -f "$ref" >/dev/null 2>&1 || true
  return 0
}
trap cleanup EXIT

echo "==> pushing $image to a throwaway registry on 127.0.0.1:$port (loopback only)"
docker rm -f "$container" >/dev/null 2>&1 || true
docker pull registry:2 >/dev/null
docker run -d --name "$container" -p "127.0.0.1:$port:5000" registry:2 >/dev/null

for _ in $(seq 1 30); do
  curl -fsS --max-time 2 "http://127.0.0.1:$port/v2/" >/dev/null 2>&1 && break
  sleep 1
done

docker tag "$image" "$ref"
docker push "$ref" >/dev/null

echo

# A modern `docker build` publishes an OCI *index*, not an image manifest: one
# entry per platform plus a `unknown/unknown` attestation entry that is not an
# image at all. Follow the index to a real platform manifest before reading
# sizes, or you measure the index (a few kilobytes) and conclude the image is
# tiny.
raw="$(docker manifest inspect --insecure "$ref")"

child="$(printf '%s' "$raw" | python3 -c '
import json, sys
entries = (json.load(sys.stdin).get("manifests") or [])
real = [e for e in entries
        if (e.get("platform") or {}).get("architecture") not in (None, "unknown")]
if entries:
    print((real or entries)[0]["digest"])
')"

if [ -n "$child" ]; then
  echo "(followed a multi-platform index to $child)"
  raw="$(docker manifest inspect --insecure "${ref%:*}@$child")"
fi

# Read the `layers` array and nothing else. The manifest also carries a `size`
# for the config blob and one for itself, so anything that greps for `"size"`
# mixes three different numbers and reports a 234 MB image as a few kilobytes.
printf '%s' "$raw" | python3 -c '
import json, sys

layers = (json.load(sys.stdin).get("layers") or [])
if not layers:
    sys.exit("no layers array in the manifest")

def human(b):
    for u in ("B", "kB", "MB", "GB"):
        if b < 1000 or u == "GB":
            return "%.1f %s" % (b, u)
        b /= 1000.0

total = sum(l["size"] for l in layers)
print("\n== registry-compressed blobs (largest first) ==")
print("   this is what a push actually uploads.\n")
for l in sorted(layers, key=lambda l: -l["size"]):
    print("  %10s  %5.1f%%  %s" % (human(l["size"]),
                                   100.0 * l["size"] / total,
                                   l["digest"][:26]))

top = 100.0 * max(l["size"] for l in layers) / total
print("\n  %10s  total across %d layers" % (human(total), len(layers)))
print("  largest blob is %.1f%% of the push" % top)
if top > 40:
    print("""
  >>> One blob dominates. `docker push` resumes at LAYER granularity only —
      there is no resume inside a blob — so every retry re-uploads this from
      byte zero, and raising the retry count buys nothing. Split the layer.""")
'
