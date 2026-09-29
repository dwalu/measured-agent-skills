# Tracing, linkers, and resolution checks

Split out of `container-image-delivery` §2 to keep the skill body under the 500-line
guidance. **Read this when** a framework's "trace only what is reachable" output mode
is on the table, when a traced image boots and then dies on the first request, or when
a resolution check reports a package MISSING that production resolves fine.

## When a tracer offers to do the cutting for you

Frameworks increasingly ship a "trace only what is reachable" output mode, and
the numbers are spectacular — measured on one app, **66 MB against 852 MB**, an
application blob of 17 MB against 226 MB. Take the number seriously and the
result sceptically, because the failure mode is the worst kind:

**A tracer emits an image that boots.** It starts, it logs its ready banner, and
it fails on the first request that reaches a module the trace missed. That is
strictly worse than a build error, and no amount of "does it start" testing
finds it.

The specific trap, which generalises past any one framework: **a tracer resolves
from where the emitted bundle sits, and that is not always where the runtime
resolves from.** With a strict/isolated package manager layout (pnpm's default),
packages belonging to *sibling* workspace packages are not resolvable from the
application directory at all. The application works anyway because the package
manager keeps a hidden hoisted directory that the *framework's own* module
location can see. The tracer, resolving from the bundle, finds nothing to trace
and correctly copies nothing — so an explicit "also include these" list does not
help either, and adding one may change nothing at all.

How to check in five minutes, before betting an increment on it:

```sh
# 1. Is the module even in the traced tree?
find <traced-tree> -type d -name argon2 -o -type d -name '@prisma'

# 2. Resolve the way the RUNTIME does, not the way you assume.
node -e '
  const {createRequire} = require("module");
  const r = createRequire("<path-to-framework>/index.js");
  for (const p of ["<external-1>", "<external-2>"])
    { try { r.resolve(p); console.log("ok " + p) } catch { console.log("MISSING " + p) } }'
```

If (1) finds nothing, the tracer dropped it, and the fix is the package manager's
layout (a flat/hoisted linker) rather than an include glob. Decide that on its
own merits — it changes workspace semantics — rather than as a side effect of
wanting a smaller image.

**The resolution check has its own footgun, and it fails in the flattering
direction.** `require.resolve("pkg", { paths: [dir] })` does **not** reproduce
Node's normal lookup: it **replaces** the module-path list instead of walking up
`dir/node_modules` and its ancestors, so it reports `MODULE_NOT_FOUND` for packages
a real `require` from that directory resolves without trouble. That makes a
correctly-resolving production image look broken — a false discovery, which is
harder to dismiss than a false clean bill. Anchor with `createRequire(<file>)` as
above, because that *does* walk up from the file, or write and run a real probe file
in the directory under test.

**A traced tree's symlink count is a property of the package linker, not of the
tracer or the output mode.** Same app, same framework version, changing only the
pnpm linker: hoisted gives ~0 symlinks and no `.pnpm` directory in the output;
isolated, which is pnpm's default, gives **24 symlinks and a full `.pnpm` store**.
So "this output mode is symlink-free" is not something to assert from
documentation. And it hands you the right detector: if a build is supposed to run
under a hoisted linker, **`.pnpm` present in the shipped tree directly proves the
linker setting silently did not apply** — the exact regression shape that boots
clean and dies on the first request. Assert `.pnpm` absent, not a symlink count of
zero.

Two smaller findings from the same trace, both worth knowing before you plan work
around them: the traced output contained **zero `*.map` files**, so a source-map cut
is fully subsumed by adopting the mode rather than merely reduced; and the
framework's own `required-server-files.json` ships **inside** the output carrying
the externals list and output mode, so a check can read that configuration straight
out of the built image instead of duplicating it.
