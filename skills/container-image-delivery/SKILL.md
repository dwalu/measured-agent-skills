---
name: container-image-delivery
description: Build, size, and publish container images over a link that is not fast — measuring which layer is actually the push, cutting what ships, splitting the layer so a retry can resume, publishing on a release instead of every merge, and publishing each image independently so one failure cannot skip the rest. Use when a `docker push` dies mid-upload or takes tens of minutes, when a retry never seems to get further than the last one, when CI spends more time uploading images than testing, when one image in a set has never published, when an image builds fine but the container never becomes ready, or when deciding what a deployment should pin.
---

# Container image delivery on a slow link

Everything here was learned publishing two images (354 MB and 234 MB
compressed) from CI runners with an uplink first believed to be ~250 KB/s and
later **re-measured at ~550 KB/s** off the first publish that actually
succeeded — see §3, and `references/measuring-the-uplink.md` for why that
distinction cost real work. That number is
what makes the lessons visible; it is not what makes them true. The same
mistakes cost less on a fast link and are still mistakes — a coupled publish
loop that has never published your second image is wrong at any bandwidth.

**The one thing to internalise:** `docker push` resumes at **layer granularity
and no finer**. There is no resume inside a blob. Almost every wrong instinct
about slow pushes — raise the retry count, add a longer timeout, try a different
registry — follows from not knowing that.

## Work the questions in this order

Doing these out of order wastes the most time. Each step changes the arithmetic
of the next one.

1. **Measure** which layer is the push. (`scripts/layer-report.sh`)
2. **Cut** what ships but is never executed.
3. **Split** the dominant layer, so a retry can make progress.
4. **Move** the publish off the merge path onto a release.
5. **Decouple** the images from each other.
6. **Then** — and only then — think about retries.

Retries are last because they are the only step that cannot make a bad push
better. Everything above shortens the exposure window; a retry just re-enters
it.

*(`$SKILL` below is this skill's own directory — the host prints it when the
skill activates; on Claude Code it is `~/.claude/skills/<name>`, on Gemini CLI
`~/.gemini/skills/<name>`.)*

## 1. Measure: which layer is the push?

```bash
$SKILL/scripts/layer-report.sh myimage:tag
$SKILL/scripts/layer-report.sh --compressed myimage:tag
```

Default mode reads `docker history` — the **uncompressed** on-disk sizes. Good
enough to spot a dominant layer, but not what crosses the wire.

`--compressed` is the number that matters. It pushes to a throwaway `registry:2`
on loopback and reads the real blob sizes back out of the manifest: exact, no
upstream bytes, seconds rather than the slow push you were trying to avoid. Real
output:

```
    129.8 MB   55.5%  sha256:451547b306e9358e1d5
     50.1 MB   21.4%  sha256:eb6939232e6e9b4aacb
     ...
    234.0 MB  total across 11 layers
  largest blob is 55.5% of the push
```

**Do not hand-roll this parse.** Two traps, both of which produced confidently
wrong numbers before the script handled them: a manifest carries a `size` for
the config blob and for itself as well as for each layer, so anything that greps
`"size"` mixes three quantities and reports a 234 MB image as 3 KB; and a modern
`docker build` publishes an OCI **index**, not an image manifest — you must
follow it to a platform manifest, skipping the `unknown/unknown` attestation
entry, or you measure the index.

**If you publish more than one image, a single-image histogram can point at the
wrong layer.** GHCR deduplicates blobs across repositories within one owner, so a
shared base uploads once for the whole namespace rather than once per image.
Measured on a first-ever publish of two images sharing one Debian-slim Node base,
pushed smallest first: the first image pushed 7 layers and reported 27
`Layer already exists`; the second pushed **3 of 12** layers and reported 31
already-exists, skipping the ~79.9 MB shared base entirely. Count it rather than
reasoning about it — `grep -c "Layer already exists" push.log` against
`grep -c "Pushed" push.log` — and watch two traps: a second or third *tag* on the
same image is entirely already-exists and inflates the count, and if the upstream
base tag moves, the whole base re-uploads (observed twice in eight days).

This changes how to read the report above, because **"largest blob is N% of the
push" is a per-image number**. The blob it flags can cost **zero** marginal bytes
when a sibling image shares it byte for byte. Measured on one release: a 50.1 MB
blob flagged dominant at 43.9% and a 28.1 MB blob were both shared with the other
image — marginal cost **0** each — while the real cost was a 25.7 MB application
blob that was not the largest line in either report. A release moves the **union**
of the manifests, not the sum of the per-image totals: 79.9 shared + 34.2
image-A-only + 153.4 image-B-only = **267.5 MB**, against 347.4 MB if you add the
two reports together. **Before splitting anything on a multi-image release, diff
the manifests and rank by marginal size** — the layer worth splitting is the
largest blob that appears in exactly one image, and it often is not the largest
blob in any single image's report.

**Dedup also fails for reasons that look like a layout mistake.** A build-time
cache carrying embedded mtimes can make the *same instruction* on the *same*
parent chain produce two byte-different blobs across sibling images — measured at
**4,741,391 B** against **4,741,430 B** for a corepack layer — so a layer you
expect to dedupe silently does not, and the only way to see it is diffing byte
counts, never reading the Dockerfile.

*Registry-specific:* cross-repository blob dedup is a GHCR property. Do not assume
it of Docker Hub, ECR, or the `registry:2` reference implementation that
`layer-report.sh` pushes to for measurement.

## 2. Cut what ships and is never executed

Look inside the built image, not at the build context. Two categories, and the
second is where the surprise lives.

**Genuinely dead weight.** Build caches are the reliable win — a bundler's
incremental scratch directory measured 324 MB uncompressed / **40 MB
compressed**, read by nothing at run time, ~4 minutes off every publish for one
`rm -rf`.

**Load-bearing things that read as tooling.** Verify by experiment, never by
reading. A platform-native compiler binding looked like pure build-time tooling
and was bigger than the cache (42 MB compressed) — but the server resolves it at
**startup** to load a TypeScript config file, and when it is absent the
framework does not fail loudly, it **downloads** it. In an image that boots with
no network as a non-root user, that fails twice over: you get a container that
builds clean, starts, and never becomes ready. No build error, no crash — a
health check that never goes green.

> **The general form:** pruning something an image needs at *startup* produces a
> container that never becomes ready, not a build failure. Prove a deletion by
> booting the image with `--network none` and probing its health endpoint, not
> by watching the build succeed.


**The escape hatch is usually upstream of the file you wanted to delete.** In the
case above the binding is needed *only* to parse a TypeScript config file at
startup. Rewriting that one config in plain JavaScript removed the need
entirely — 130 MB on disk, 42 MB compressed, for a mechanical edit. Before
accepting "this thing is load-bearing", ask what makes it load-bearing; it is
often a single convenience you can give up.

Prove that one in both directions, because it is cheap to and the green half
alone is not evidence:

```
green: JS config, binding deleted   -> starts, no download, reaches its next real error
red:   TS config, binding deleted   -> "Downloading <binding>..." then a network failure
```

**`.dockerignore` is independent of `.gitignore`.** A wholesale `COPY . .` ships
everything git is merely *hiding* — editor swap files, backup files, stray notes —
straight into the image. This is invisible from CI, because CI checks out clean and
structurally cannot reproduce it; only a local build surfaces it. Find it by listing
the **built image** (`docker run --rm --entrypoint ls <img> -la <app-dir>`), never by
reading `.dockerignore`. Cover the mechanical classes — `**/#*#`, `**/.#*`, `**/*~`,
`**/*.log`, `**/.DS_Store` — and say so in a comment, because an arbitrarily-named
local note still gets through; the durable fix is to stop copying the whole
repository.

### "Just install production dependencies" does not do what you think

The reflex for a fat `node_modules` is a production-only install. Measure it
before believing it: on one workspace `pnpm install --prod` removed **19%**, and
every one of the five largest unused packages survived. The reason is worth
knowing because it generalises past any one package manager:

**A production dependency can drag development tooling in as an optional peer.**
`@prisma/client` is a real `dependency`; it declares `prisma` and `typescript`
as `peerDependencies` marked `optional: true`, and pnpm installs an optional peer
whenever it resolves. So a `--prod` install re-derives the entire CLI toolchain —
CLI, engines, config library and *its* transitive tree — from a package you
genuinely need at runtime. Their being declared `devDependencies` elsewhere in
the workspace changes nothing.

Two consequences:

- **Explicit removal is the tool, not a flag.** Delete the entries you have
  shown are unreachable, and delete their hoisted links with them.
- **Count the chain, not the rows.** Before claiming *N* separate savings, check
  each package's parents in the lockfile. Four "independent" cuts turned out to
  be one: everything hung off the CLI and left when it did. A table of five rows
  overstated the independent saving by 34 MB until someone read the lockfile.

The optional-peer marking is also the safety argument, and a strong one: an
optional peer is a dependency its dependent states in its own manifest that it
can run without.

**A second flag with the same failure shape.**
`pnpm install --frozen-lockfile --filter "<pkg>..."` does **not** exclude the
workspace **root** importer. The root `package.json` is an importer like any other,
so every one of its `devDependencies` installs regardless of which app the filter
names. Measured on a runtime image: of 489 `.pnpm` entries, **166 were reachable
only from the root** — 66.9 MB apparent, **15.1 MB gzipped**, about 12% of a
steady-state release push — and the root declared zero `dependencies` against
eleven `devDependencies`, so every byte of it was build tooling by definition.
Prove it by picking a package declared in exactly one manifest, the root's, and
checking whether it is in the built image. Fix it at the install rather than with a
package-name deny-list: `--filter "!<root-name>"`, or `pnpm deploy --filter <pkg>`,
which is the tool pnpm ships for exactly this — note it restructures
`node_modules`, so gate it on a resolution check, not on the size drop.

### Removing a package strands links in three places, not one

With a strict/isolated layout, deleting the package directory is the easy half.
Symlinks to it survive in three site classes, and only the first is obvious:

1. the package manager's hidden hoisted directory;
2. the root and per-workspace-package `node_modules/`, plus `.bin` shims;
3. **inside every *other* package entry that resolved it** — the class nobody
   predicts, and the one that removing an **optional peer** hits every time.

Measured on one image: deleting a CLI toolchain plus `typescript` and doing only
(1) left **20 dangling symlinks**, several inside packages the server actually
loads at runtime rather than build tooling.

This matters because "no dangling symlink under `node_modules`" is the cheapest
detector you have for a mis-copied or mis-landed tree — a relocated bucket turns
every relative cross-entry link dangling at once. Permanent strands force an
allowlist and blunt the check exactly where it earns its keep.

```sh
# after the intended removals, in the build stage
find node_modules -xtype l -print | wc -l   # report it; an unexpected strand must be visible
find node_modules -xtype l -delete
```

`-xtype` is GNU find, present on Debian-slim bases; check it exists before
relying on this on an Alpine or busybox image.

Two conditions on that sweep. Check the **baseline is really zero** first — it
was, on a tree of 1376 symlinks — or you are deleting pre-existing breakage and
hiding it. And verify afterwards that the application still *resolves and runs*,
not merely that the count reached zero.

### The half of the design you reasoned is the half that is wrong

Worth stating as a review heuristic, because it held exactly on a document whose
author believed otherwise. In one image-shaping design, three sections were
settled by experiment and two were reasoned from the dependency graph and the
Dockerfile. An adversarial re-read found **three factual errors and two gaps, all
five in the reasoned sections, none in the measured ones.**

The tell is a word like *provably*, *clearly*, or *obviously* attached to a claim
with no command behind it. In image work that word is expensive: the failure it
protects against is a container that builds, boots, prints its ready banner, and
fails on the first request. So when reviewing your own image design, do not
re-read it for sense — **sort its claims into measured and argued, and spend the
whole review on the second pile.**

> **Detail moved out.** The tracer's failure modes — an image that boots and dies on
> the first request, bundle-relative resolution under an isolated linker, the
> `require.resolve(..., {paths})` footgun, and why a symlink count is a property of
> the linker rather than the tracer — are in **`references/tracing-and-linkers.md`**.
> Read it before trusting a traced tree.

## 3. Split the dominant layer — for resumability, and measure before believing it buys throughput

If one layer is most of the push, every retry re-uploads it from byte zero. The
evidence that this is real and not theoretical: the *same* blob digest failing
on two consecutive attempts rather than the second getting further.

At ~250 KB/s a 40 MB layer is ~3 minutes of exposure; a 266 MB layer is ~18.
Same bytes, very different odds of surviving a blip. **That is the resumability
argument, it is the solid one, and it is the only one you get for free.**

> **Detail moved out.** The measured refutation of the throughput argument — the
> 551/546 KB/s table, why single-stream equalled aggregate, and the biased-sample
> retraction — is in **`references/measuring-the-uplink.md`**. Read it before
> splitting a layer for speed rather than for resumability.

## 4. Publish on a release, not on every merge

If a publish costs tens of minutes and every merge attempts one, the link is the
binding constraint and no workflow change reaches it. Gate the push on a
deliberate signal — a tag, a release, or `workflow_dispatch`.

**Keep building on every merge.** The build is what proves the Dockerfile still
works and costs no upload. Losing it is a real regression in coverage; only the
push should move.

**State the contract change out loud.** If a deployment pins by digest and has
assumed a digest exists for every commit, after this it exists for every
*release*. Staging pins a release rather than a tip — which is what a deployment
should pin anyway, but it is a change of premise and every document that assumed
the old one has to be updated in the same change, not left to be discovered.

A release publish should push `:<tag>` alongside `:<sha>` and `:latest`. A
release that does not carry its own name is a digest with no story attached.

## 5. Publish each image independently

This is the bug worth carrying between projects, because it is invisible:

```bash
set -euo pipefail
for pair in "web:$WEB_IMAGE" "worker:$WORKER_IMAGE"; do
  docker push ...
done
```

The first failed push exits the step and **the second image is never
attempted**. Nothing says so; the loop simply ends. In the case this was written
from, the second image had *never once been published* — across four runs, six
push attempts, and not one of the six was an attempt at the second image.

```bash
scripts/publish-images.sh <repo> <primary-tag> <extra-tag> \
  smaller=local:tag  bigger=local:tag
```

Four properties that make it work, each of which was arrived at by a failure:

- **A subprocess, not a shell function.** This is load-bearing, not stylistic.
  Bash disables `set -e` *inside* a function whose failure is tested (`f ||
  status=$?`, `if f; then`). A function would keep running past a failed
  `docker push` and go on to assert — and print — the digest of an image it
  never pushed. Reporting success for an image that is not in the registry is
  the one outcome worse than failing.
- **Partial publish is still red, but it happens.** Collect per-image outcomes;
  exit non-zero at the end if any did not land. A release that produced half a
  set is not a release — but the half that landed is banked.
- **Smallest image first.** A registry answers `Layer already exists` for blobs
  it has, so a re-run after a partial success is close to free for the image
  that landed and full price only for the one that did not. Banking the cheap
  artefact leaves the whole budget for the expensive one.
- **Assert the digest.** `RepoDigests` is a **list**, one entry per repository
  the image ID answers to, and on a persistent runner the local build tag has an
  entry of its own. `{{index .RepoDigests 0}}` will happily return a correct
  digest under a repository the registry has never heard of — precisely the
  value nobody should paste into a deployment file. Select by repository
  **prefix**, and fail if the result is empty.

## 6. The retry budget

`scripts/retry.sh` — three choices, each from a failure rather than taste.

**Blind, on purpose.** It retries any non-zero exit and does not try to decide
whether the message looked transient. A pattern list for "transient" is a list
nobody maintains, and every message missing from it becomes a red build the
script was added to prevent. The cost of retrying a genuine failure is bounded
when the expensive step comes first and the cheap failure comes after it.

**The backoff doubles.** A flat delay is worse than it looks. With three
attempts and a flat 20s wait, all three can land inside the same ~90 seconds of
one link-level fault: attempt one uploads for six minutes and dies, attempts two
and three fail instantly on a `HEAD` before the fault has gone anywhere. **Three
tries inside one fault is one try.**

**Bound each attempt, not just the job.** `RETRY_TIMEOUT_SECONDS` kills a single
attempt. Every fault with a log line is one the client *noticed*; a connection
that **stalls without dying** consumes the job timeout and every remaining
attempt with it, and produces nothing — indistinguishable from a slow transfer
that was going to succeed. Size it above the worst *successful* transfer you
have measured, so it can only fire on one that was not going to finish.

**More attempts is usually the wrong lever.** Under a fixed job ceiling, extra
attempts on the first image buy a rarer give-up at the cost of a likelier
*starvation of the second*. When a publish was decoupled, the attempt count
deliberately stayed at three; what moved was the job ceiling (sized by
arithmetic — one clean pass of both images — not guessed) and the per-attempt
bound.

**And size the job ceiling for the new shape.** A ceiling sized for a coupled
loop quietly defeats the decoupling: the second image gets attempted — the fix —
and then killed by the job timeout, which is not.

## 7. Test the path that only runs on a release

**A step that only runs when it matters is a step nobody has tested.** After you
move the publish onto a release, no pull request executes a line of it. That is
not thin coverage, it is a blind spot with a shape: the coupled-loop bug above
survived four runs precisely because the only runs that executed the code were
the ones nobody was watching.

```bash
scripts/publish-images.test.sh     # ~12 assertions, under a second, zero uploaded bytes
```

It runs the **shipped** scripts against a real `registry:2` on loopback using
two `FROM scratch` images. Wire it into the pull-request path and **not** behind
the publish gate. Three cases, and the first is the regression itself:

| Case | Asserts |
|---|---|
| A | Nothing listening. Both images must still be **attempted**. Under a `set -e` loop the second never is. |
| B | Both succeed: exit 0, a digest line each, and both tags present according to the **registry's** API — not docker's local view, which would pass on a push that never happened. |
| C | First fails, second must still publish, and the run must stay **red**. |

**Verify it reddens.** Reintroduce the coupled loop and confirm assertions fail
(five of them, in the original). A proof that cannot go red proves nothing.

One consequence found by writing that check: it pulls `registry:2`, which the
runners had not cached — an **unretried network fetch inside a job that had just
been made required**, the precise shape whose absence was the argument for
keeping that job advisory. It goes through `retry.sh` now. *Adding a required
check is also adding every network dependency that check has.*

### Two traps, both found the first time a tree-assertion check ran in CI

**Your image job probably has no language runtime.** A job that only builds and
runs containers is the one job that never installs a toolchain — the tree check
above died on `node: command not found`, and nothing in the job definition hints
at it because every *other* job installs one. Do not reach for `setup-node`: this
job is required, and adding a step to a required job adds its network
dependencies too (see directly above). Run the script **inside the image under
test** instead — it already has an interpreter, plus bash, coreutils and GNU
find:

```yaml
- run: |
    docker run --rm -v "$PWD/.github/scripts:/check:ro" \
      --entrypoint bash "$IMAGE" /check/assert-tree.test.sh
```

Not circular, as long as the script builds its own synthetic fixtures — the image
is only supplying the nearest already-local interpreter.

**A negative case that asserts only a non-zero exit passes vacuously.** In that
same red run the suite reported `1 passed, 6 failed`, and the one green line was
the case written *specifically* to stop the checker passing vacuously — "if the
anchor is missing, reporting success would be worse than reporting nothing". It
settled for a non-zero exit without reading the message, so a run in which
**nothing executed at all** satisfied it.

Every negative case greps for the message it expects. And keep the positive
baseline case in the suite: the green case is what detects a harness that fails
everything — here it did, going red immediately. Validate the whole suite by
pointing it at a stub that exits non-zero with an unrelated message and requiring
**0 passed**, not merely "some failed".

## The scripts

All are dependency-light bash (plus `python3` for JSON), no project identifiers,
parameterised rather than hard-coded to a particular set of images.

| File | What it is for |
|---|---|
| `scripts/layer-report.sh` | Which layer is the push? Uncompressed histogram, or exact registry-compressed blob sizes via a throwaway loopback registry. **Start here** — it is what turns "raise the retry count" into "split the layer". |
| `scripts/publish-image.sh` | Publish **one** image: tag, push each tag with retries, resolve and assert the digest, append `<NAME>_IMAGE="<digest>"` to a step summary on success only. A separate process on purpose (see §5). |
| `scripts/publish-images.sh` | Orchestrator. Runs the above once per image, collects per-image outcomes, exits non-zero if any failed. Pass the smallest image first. |
| `scripts/publish-images.test.sh` | The three cases in §7, against a real local registry. Runs on every pull request. |
| `scripts/retry.sh` | Blind retry with doubling backoff and an optional per-attempt `timeout`. Used by the publish scripts; useful for any network step. |

Copy them into a repo (`.github/scripts/` or equivalent) rather than referencing
`~/.claude` from CI — the runner has no home directory of yours.

Tunables are documented in each script's header: `RETRY_ATTEMPTS`,
`RETRY_TIMEOUT_SECONDS`, `IMAGE_SUMMARY_FILE`, `PUSH_LATEST`, `REGISTRY_PORT`.

## Related

- **`ci-merge-gates`** — before making an image job a *required* check, read what
  that costs and in what order to do it.
- **`self-hosted-ci-runners`** — if the slow link is a runner on your own desk,
  that skill is where the link and the lanes are diagnosed.
