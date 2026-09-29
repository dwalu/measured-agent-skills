---
name: node-and-vitest-runtime
description: Node and Vitest runtime behaviour that makes a failure disappear — why destroy(err) on an already-drained stream is a silent no-op that stream.pipeline does not rescue, why a promise you might not await has to be guarded on entry, why registering an uncaughtException or unhandledRejection handler turns Node's crash into a clean exit 0, why a skip predicate that probes by running the tool under test converts any bug in that tool into a green skip, and why Vite rewrites a literal new URL(rel, import.meta.url) against jsdom's window.location instead of the module's real path. Use when a subprocess wrapper resolves on a command that exited non-zero, when a crash stops crashing after adding a log handler, when a suite reports skipped instead of failed, or when a path resolves to http://localhost under a jsdom test and correctly under node.
---

# Node and Vitest runtime behaviour that hides a failure

Measured on **Node v26.10.0** (Node ≥ 22 also applies where noted),
**Vitest 3.2.7 / Vite 7.3.6**, **TypeScript 5.9.3**.

Every item here converts a real failure into a success signal. That makes them
`proof-and-verification`'s problem as much as Node's: *a green run is not a result
until you can show the test was capable of going red.*

---

## 1. A drained stream's `destroy(err)` is a no-op, and `pipeline` does not save you

A subprocess wrapper that signals failure by destroying its output stream can
report success for a command that exited non-zero. The mechanism is timing, and it
is worth knowing exactly where the boundary is — I measured both sides:

- `destroy(err)` called **synchronously inside the `'end'` handler** does fire
  `'error'`, because auto-destroy has not run yet.
- `destroy(err)` called **after the stream has ended and auto-destroyed** — a tick
  later, which is the realistic case when you are waiting on an exit code — is a
  **true silent no-op**. No `'error'` event, no throw, `destroyed` is already
  `true`, process exits 0.

Two things that look like they would catch it and do not. **`.pipe()` does not
forward source errors** — long-documented Node behaviour. And **`stream.pipeline`
only helps mid-flight**: a destroy while data is still moving makes the pipeline
reject cleanly; a destroy after the drain makes it **resolve as if nothing
happened**.

**Byte counts do not substitute for an exit code.** In the incident this came
from, the truncated output was **98.8%** of the correct size, and a dump with
**zero rows** was still **99.87%** — a size-floor check passes both. Point
measurements from one incident, not a distribution, but they are the right order
of magnitude to distrust: most of a dump is schema.

**The corollary, for a promise you might not await.** If a function hands back a
promise that some callers await and others ignore, attach a handler **on entry**:

```js
void p.catch(() => undefined);   // stops the unhandledRejection crash
await p;                          // STILL throws — verified
```

The guard suppresses the crash for the unawaited interval only; a later `await`
still sees the rejection, which is what you want. Guarding on entry matters
because both failures firing at once — the process dying *and* the caller's error
handling — is the normal case, not the corner case: a killed subprocess errors its
stream **and** exits non-zero, so control leaves through the stream's error while
the exit-status promise is dropped mid-flight.

**Both sides own it.** The producer should guard its own promise, *and* the consumer
should not assume it did — the consumer is the one with the early-exit path. In a
worker with no `uncaughtException` handler, one abandoned rejection is a dead process
that takes every other queue consumer with it.

**This is not in tension with §2, though it looks like it.** A `.catch()` on one
specific promise suppresses the crash only until someone awaits it, and the
rejection survives. A global log-only handler suppresses the crash **permanently**
and the error is gone. Same shape, opposite consequence.

*Cross-reference:* `proof-and-verification` — a red proof driven through such a
wrapper comes back green, which is exactly the "a red run is not a result until you
know what reddened it" case.

---

## 2. Node's crash-on-uncaught is opt-out, not opt-in

Verified live:

| setup | uncaught exception | unhandled rejection |
|---|---|---|
| default | exit **1** | exit **1** |
| a log-only `uncaughtException` / `unhandledRejection` handler | logs, **exit 0**, still alive | logs, **exit 0** |
| `uncaughtExceptionMonitor` | logs **and still crashes**, exit 1 | same |

Node already does the right thing. **Registering a handler replaces that default**,
so the well-intentioned "let's at least log it" handler is the thing that converts
a crash into a process that stays up in an unknown state. If you want the log *and*
the crash, use `uncaughtExceptionMonitor`, which fires for both paths without
suppressing either. (Node ≥ 15, where the `--unhandled-rejections` default became
`throw`; confirmed on 22 and 26.)

**A related swallow worth knowing if you use BullMQ:** `QueueBase.emit` wraps
`super.emit()` in try/catch, and a second try/catch around the re-emitted `'error'`
falls back to `console.error(err)` — *"We give up if the error event also throws an
exception."* So an unlistened `'error'` becomes console output rather than a crash.
Checked against bullmq 5.81.3.

---

## 3. A skip predicate must test the environment, not run the tool

A skip condition that probes **by running the tool under test** turns any bug in
that tool into a green skip. One suite probed platform support by invoking the
tool's `state` subcommand and treating any error as "not this platform" — a
`NameError` inside the tool then skipped the entire live half on every runner and
reported green.

**Skip on a fact about the environment that the code under test cannot
influence** — `uname -s`, the presence of a device, an OS version. If the platform
check passes and the tool then fails, that is a **failure**, never a skip. And
print the counts (`N passed, M failed, K skipped`), because a skip count that
silently equals the total is the only visible symptom.

*Cross-reference:* `proof-and-verification` §6 — coverage is a separate property
from correctness and needs its own assertion.

---

## 4. Vite rewrites a literal `new URL(rel, import.meta.url)` against jsdom's location

**The claim you will hear, and it is wrong:** *"under a jsdom test environment
`import.meta.url` is an http URL, so `fileURLToPath` throws."* Measured on
Vitest 3.2.7 / Vite 7.3.6 in a jsdom project:

| expression | result under `environment: "jsdom"` |
|---|---|
| `import.meta.url` | `file:///…/probe.test.ts` — **always `file:`** |
| `new URL("./sibling.ts", import.meta.url)` *(literal)* | `http://localhost:3000/sibling.ts` |
| `const base = import.meta.url; new URL("./sibling.ts", base)` | `file:///…/sibling.ts` |
| `new URL(import.meta.url).pathname` | `/…/probe.test.ts` |

`import.meta.url` is never http. What happens is that **Vite recognises the literal
syntactic pattern `new URL('...', import.meta.url)`** and rewrites it for
asset-URL resolution against the page's location — and under jsdom that location
defaults to `http://localhost:3000`. Under `environment: "node"` the identical
expression resolves to `file://`, because there is no window location and the
rewrite does not fire.

Two consequences follow from the mechanism rather than from the symptom.
**Capturing `import.meta.url` into a variable first defeats the rewrite**, because
the pattern is matched syntactically. And the single-argument form
`new URL(import.meta.url).pathname` works — not because it "handles both schemes",
since only one scheme is ever in play, but because parsing an absolute URL does not
trigger the relative-asset rewrite at all.

*Version-dependent:* this is a Vite asset-URL static-analysis feature, not a jsdom
behaviour, so it can change across Vite majors. Re-run the four-row probe above
before relying on it.

## Related

- `proof-and-verification` — the discipline behind all four: an absence is only
  evidence if you can show the presence was reachable.
- `prisma-behaviour` — the TypeScript structural-typing trap where `Omit<>` fails
  to narrow what satisfies a client type.
- `loading-state-renders-the-falsy-branch` — the frontend counterpart, where an
  in-flight query makes a component render its negative branch.
