---
name: shell-and-git-forensics
description: Investigating with local command-line tools without fooling yourself, and the git commands that destroy work or stage what you were told not to. Covers file selection whose glob precedence is the opposite of your mental model (ripgrep later-glob-wins, git pathspec not supporting **, a scan that hangs on stdin), why a text scan cannot see a type-level distinction, staging and destructive-command discipline, backup-and-restore during a red/green proof, port and process probes that collapse every distinct failure into one empty string, and the shell plumbing that misreports exit status differently in bash, zsh and fish. Use when a search's count looks too big or too small, when a file list comes back empty and the tool exits 0 anyway, when a probe reports nothing and you cannot tell why, when PIPESTATUS gives the wrong answer, when a redirection error survives 2>/dev/null, or before any git command that stages, reverts or rewrites.
---

# Investigating with local tools without fooling yourself

Every failure here returns something that **looks like an answer**: a plausible
count, an empty list, a zero exit, silence. None of them errors. That is what makes
them expensive — and it is why `proof-and-verification`'s rule applies to your
tooling as much as to your tests: *an absence is only evidence if you can show the
presence was reachable.*

**Shell-specific claims below are labelled**, because they genuinely diverge. All
shell behaviour here was measured on macOS with **bash 5.3.20**, **zsh 5.9.2** and
**fish 4.9.3**.

---

## 1. File-selection precedence is usually not what you assume

Three tools, three different ways the selected set is wrong while the command
succeeds.

**ripgrep: a later `-g` re-includes what an earlier one excluded.**

```bash
rg -g '!**/*.test.ts' -g '*.ts' 'pattern'   # does NOT exclude tests
```

Later globs win, so the trailing include cancels the exclusion. Measured on one
scan: **975 matches across 66 files** with the wrong ordering against **182 across
33** with the right one — a 5× error that reads as a real finding rather than a
tooling mistake. Put negations **last**, or sidestep precedence entirely with
`rg -t ts -c 'pat' | grep -v '\.test\.ts'`.

**git pathspec is not shell globstar, and `**` silently matches nothing.**

```bash
git ls-files "packages/db/src/**/*.ts"        # returns 0 paths
git ls-files packages/db/src | grep '\.ts$'   # works
git ls-files "packages/db/src/*.ts"           # works
git ls-files -- ":(glob)packages/db/src/**/*.ts"   # works
```

All three working forms returned **86** where the `**` form returned **0**. Note
this is the *opposite* instinct to ripgrep: there `**` works and only the ordering
bites; here the ordering is fine and `**` is unsupported.

**The zero is dangerous because the next tool accepts it.** `tsc $FILES` with
`$FILES` empty does not error — it falls back to the nearest `tsconfig.json`, and
if that config has `"files": []` it typechecks nothing and **exits 0**. One run
printed `0 errors` for three packages having compiled none of them. So **print the
count before trusting the result** — and beware `wc -l` on an empty variable, since
`echo ""` is one blank line and an empty list therefore reports `1`.

**ripgrep with no path argument reads stdin, and hangs.** `rg PATTERN` searches the
current directory only when stdin is a TTY. From a script, a subprocess or a pipe it
reads stdin and blocks until something kills it — two scans died at exit 124 this
way and looked like a slow repository rather than a hang. Always pass an explicit
path (`rg PATTERN .`), and add `< /dev/null` to the wrapping command so a missed one
fails fast instead of waiting.

---

## 2. A text scan cannot see a type-level distinction

A function overloaded on argument *type* has textually identical call sites, so a
regex-based ratchet miscounts in the direction that looks like progress.

Migrating `fn(a, cb)` to `fn(a, b, cb)`, a rule of "two-arg iff argument two is an
inline arrow" classifies `fn(a, someNamedFn, db)` — an unconverted two-arg call
passing a function *reference* — as converted. The ratchet count falls, which reads
as migration progress, while an unconverted call site ships.

**Classify with an AST, not a pattern.** As an ESLint `no-restricted-syntax`
selector:

```
CallExpression[callee.name='fn'] > :matches(ArrowFunctionExpression, FunctionExpression):nth-child(2)
```

Two caveats. The `:nth-child(2)` index relies on how esquery enumerates a
`CallExpression`'s traversal children (the callee is not counted) — that is an
esquery implementation detail, not a standardised AST property, so **re-verify the
index against your own version** and treat only the selector *shape* as durable.
And prefer putting the classification in a `ts.createSourceFile` walk inside a
drift test rather than in a lint rule, because a lint rule is a ban: every existing
occurrence then needs a disable comment, which is not what a ratchet is for.

Expect benign false positives where a bare `Identifier` is genuinely ambiguous — a
destructured value looks like a function reference, while a `MemberExpression` such
as `ctx.session.userId` does not.

---

## 3. Before a git command that stages or destroys

**Assert the branch, never remember it.** Re-read `git branch --show-current`
immediately before any commit, push or history rewrite, and again after any pause or
long-running operation. A working tree can move under you — another terminal,
another session sharing the checkout, or your own earlier command. (`--show-current`
needs git ≥ 2.22.)

**`git add <dir>` sweeps in untracked files you were told never to stage.**
`git add docs/` stages *every* untracked file under `docs/`, including the one
specifically named as must-not-be-committed. Undo with
`git restore --staged <path>`. Prevent it by listing exact paths, or by excluding
explicitly:

```bash
git add -A ':!ONBOARDING.md' ':!docs/design/big.pdf'
git status --short | grep -v '^??'      # read this BEFORE committing
```

**Never inspect and destroy in one invocation.** `git status && git reset --hard`
prints the warning in the same output that executes the loss. Inspect, decide, then
act — and prefer `git stash -u` or `git branch backup/<name>` first.

**Content that was never staged has no recovery path.** Not the reflog, not
`git fsck`, not `git stash`. It never reached the object store. This is the fact
that makes the ordering above matter rather than being fussiness.

**Never suppress stderr on a state-changing git command** — see §5, which is the
general form of why.

---

## 4. Backing up and restoring during a red/green proof

**Do not restore with `git checkout`.** `git checkout -- <path>` (equivalently
`git checkout HEAD -- <path>`) restores from the index or HEAD and **cannot
distinguish** "the two lines I added to test this" from "the two lines I added as
the actual change". Both are uncommitted, so both go. `proof-and-verification` §5
carries the full case, including the mirror failure where the same command left an
*untracked* file's damage in place. One detail worth adding: read the `git status`
*after* a restore. In that incident it printed the reverted file as unmodified and
the human scrolled past it.

> **Correction worth stating, because these two rules used to sit side by side.**
> `git stash push -- <paths>` and `git checkout HEAD -- <paths>` are **not**
> interchangeable alternatives, even though both "keep the full path". Stash
> captures before removing and pops back; checkout discards with no capture. For
> the revert-to-baseline-then-restore shape, checkout destroys exactly the
> uncommitted work the later restore step was supposed to bring back. Use
> `git stash push -- <paths>` / `git stash pop`, or copy the files.

**A flat scratch directory collides on basename.** This costs nothing to do and
gives no error at any step:

```bash
cp e2e/a/promotion.spec.ts e2e/b/promotion.spec.ts "$S/bak/"   # second silently wins
cp "$S/bak/promotion.spec.ts" e2e/a/promotion.spec.ts          # restores the WRONG file
```

Mirror the tree instead — `cp --parents`, or `rsync -R` — or use the stash. Then
**assert on content** after restoring (`grep -c` for a symbol that must be there)
rather than assuming `cp` did what you meant; a follow-up `grep -c` returning 0 is
how this one was caught.

---

## 5. A probe that collapses every failure into one empty answer

Two companion findings from a single incident — the same port-probe script, the same
**eighteen days** of a dashboard confidently printing `web stopped` — with two
different mechanisms, so both fixes are needed.

**The script-side half: `2>/dev/null` erases *which* failure happened.**

```bash
webpid="$(lsof -ti :"$PORT" 2>/dev/null | head -1)"
```

`command not found`, `Permission denied` and "nothing is listening" all produce the
same empty string. **An empty result is data; a failed command is a different
fact.** Capture the exit code and the stderr even when you intend to degrade
gracefully: *degrade on the value, report the error.* First diagnostic step is
always to re-run the identical expression with stderr shown.

**The tool-side half: `lsof` can go blind.** On **Linux**, `lsof` 4.95.0 reports
nothing at all — `rc=1`, empty stderr, no rows even for `lsof -nP -p <that exact
pid>`, same uid, no `hidepid` — for a process whose `/proc/<pid>/comm` contains an
**unbalanced `(`**. `ss -ltnp` names it correctly. This is reachable through
ordinary means: a Node process writing `process.title` is truncated to 15 bytes by
`prctl`, so `next-server (v15.5.22)` becomes `next-server (v1`. Reproduce it with
`ctypes.CDLL("libc.so.6").prctl(15, b"weird (v1", 0, 0, 0)`.

*Platform:* Linux only. macOS `lsof` reads libproc rather than `/proc` and is
immune — so this is a CI-runner bug you cannot reproduce on a Mac.

**Ask a second oracle.** The durable lesson is not "lsof is buggy" but that a single
probe returning nothing is one observation, not a conclusion. `ss`, `fuser`, or the
listening socket itself disagree independently — prefer
`ss -H -ltnp "sport = :$PORT"` first and `lsof` as the fallback.

And note the assertion this quietly voids: a teardown check of the form
`! lsof -ti tcp:$PORT` against a Node listener is **vacuously true** on Linux. It
never proved the port was released; it proved `lsof` had nothing to say.

---

## 6. Shell plumbing that misreports exit status — and it differs per shell

**`PIPESTATUS` after a command-substitution assignment is not your pipeline's
status.** *(bash and zsh; **not** a bug in fish.)*

```bash
out=$(cmd | wc -c); code=${PIPESTATUS[0]}   # WRONG
```

The assignment is itself a simple command, so the array has already been overwritten
by the time you read it. Measured:

| shell | after `out=$(false \| wc -c)` | standalone `false \| wc -c` |
|---|---|---|
| bash 5.3.20 | `PIPESTATUS[0]` = **0** | `PIPESTATUS[0]` = 1 ✓ |
| zsh 5.9.2 | `$pipestatus` is **empty** (0 elements) | 2 elements, first = 1 ✓ |
| fish 4.9.3 | `$pipestatus` = **`1 0`** ✓ — no bug | — |

zsh's failure is the nastier of the two: an empty array means `${pipestatus[1]}` is
the empty string rather than `0`, so a numeric comparison may misbehave rather than
simply reporting success. Fish does not collapse at all, and note the name differs —
`$PIPESTATUS` does not exist in fish; it is lowercase `$pipestatus`.

Fix in bash/zsh: run the pipeline as its own command, then read the array —
`cmd | wc -c > /tmp/out; code=${PIPESTATUS[0]}` — or use `set -o pipefail` and read
`$?`.

**A failed *redirection* is diagnosed before the command runs, so the command's own
`2>/dev/null` cannot suppress it.**

```bash
printf 'x\n' >>"$log" 2>/dev/null || true       # still prints "...: Is a directory"
{ printf 'x\n' >>"$log"; } 2>/dev/null || true  # silent          (bash/zsh)
```

Same for input redirection: `wc -l <"$f" 2>/dev/null` leaks; `{ wc -l <"$f"; } 2>/dev/null`
does not. Prove the grouping actually discriminates by counting the error lines
before and after — 2, then 0.

*The mechanism reproduces in fish, but **the brace-grouping fix does not.*** Fish
emits `warning: An error occurred while redirecting file '...'` / `open: Is a
directory`, and **both** `begin; …; end 2>/dev/null` and fish's own `{ …; }`
grouping still leak it. Three things that do work in fish:

1. **Test the target first** — `if test -f $log; …; end`. The cleanest option, and
   the only one that distinguishes causes rather than hiding them.
2. **Delegate the redirect to `sh`** — `sh -c 'printf x >>"$log"' 2>/dev/null`. The
   failure still arrives as a non-zero exit status, which is what you wanted.
3. **Redirect the outer shell's stderr**, if you genuinely want everything quiet.

Option 1 is the one to reach for, because the other two suppress the diagnosis
rather than handling it — which is exactly the §5 mistake one level down.

## Related

- `proof-and-verification` — the discipline these are instances of, and §5 there
  owns the `git checkout` revert case and the aborting-glob case in full.
- `container-image-delivery` — `find -xtype` portability, and its
  `references/tracing-and-linkers.md` for the resolution-check
  footgun, for scans run against a built image.
