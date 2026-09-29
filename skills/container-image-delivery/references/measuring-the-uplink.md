# Measuring the uplink before splitting for throughput

Split out of `container-image-delivery` §3 to keep the skill body under the 500-line
guidance. **Read this when** you are about to split a layer to go faster rather than to
make a retry resumable, or when quoting an uplink figure you did not measure yourself
off a successful push.

## The throughput argument is a hypothesis, and one link has already refuted it

The tempting second argument: `dockerd` uploads five blobs concurrently by
default, so *n* buckets should move *n* streams and beat one fat blob on a link
whose single-stream rate is below its aggregate. On the link this skill was
written from, that reasoning predicted ~1.5–1.7x — and it was **wrong**, checked
against a real publish:

| | bytes | wall clock | rate |
| --- | --- | --- | --- |
| one image, 4 concurrent blobs | ~153.6 MB | 278.6 s | **551 KB/s aggregate** |
| other image, essentially one blob | ~126.2 MB | 231.1 s | **546 KB/s single-stream** |

**Single-stream was aggregate.** The link was shaped per-host, not
per-connection, so five streams went exactly as fast as one and the entire
throughput half of the split evaporated. Splitting still bought resumability;
it bought nothing else.

Take this measurement before you let a throughput estimate rank the work,
because it is nearly free and it can delete an expensive task. You need one
successful push: `docker push` prints a per-layer `Pushed` line with a
timestamp, so *(that timestamp − the push's start) ÷ (that blob's compressed
size)* is a single-stream lower bound, and total bytes ÷ total duration is the
aggregate. If the two numbers are close, the link is per-host shaped and only
the resumability argument survives.

**And take it from a *successful* push, not a remembered one.** The same project
carried "~250 KB/s aggregate, ~165 KB/s single-stream" for weeks; it came from
degraded and failed runs, which is a biased sample — a run slow enough to
notice is a run slow enough to be remembered. The first successful publish
measured **twice** that, which halved the value of eight separate ranked tasks
at a stroke.

Splitting is harder than it looks and the obvious approaches are wrong:

- A `COPY` glob like `deps/[a-e]*` copies directory **contents** and flattens the
  tree.
- Exact versioned paths break on every lockfile bump.
- Content-addressed dependency stores (pnpm's, notably) are graphs of **relative
  symlinks between siblings**. Any scheme that relocates entries must land them
  all at the same final path, or the image builds clean and fails at `require`
  time — a defect that only appears once deployed.

Worth evaluating before hand-rolling buckets: `COPY --link`, Dockerfile 1.7-labs
`COPY --exclude`, hard-link staging (`cp -al`), and whatever "standalone output"
mode your framework offers — the last often subsumes the whole problem. Balance
buckets by **size, not count**; real dependency sizes are heavily skewed.

Whatever you choose, prove it with a **symlink-resolution check**, not a green
boot. A boot can succeed while a lazily-required module is missing.
