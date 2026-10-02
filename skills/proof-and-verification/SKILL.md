---
name: proof-and-verification
description: How to tell a result from the appearance of one — sorting claims into measured and argued and then distrusting the measured ones too, because the reference class and the unit of analysis are authored rather than observed; finding the pair of states an assertion cannot distinguish, which is why a green test can be structurally incapable of failing; establishing that a red proof reddened for the reason you think; noticing when nothing ran at all and the silence read as a result; and asking at design time whether a thing can ever be checked. Use before reporting a measurement or a finding, when writing a negative or mutation-based proof, when a test passes and you cannot say what would break it, when a command's output and its exit status disagree, or when reviewing a design whose decision is encoded as an absence.
---

# Telling a result from the appearance of one

**One question carries most of this page: *an absence is only evidence if you can
show the presence was reachable.*** Empty DOM, zero rows, a non-zero exit, no glob
match, no output, an uncovered window, a deleted row, `N passed` from a mutation
that never applied — every one of those has been read as evidence, and every one
was the absence of evidence.

Two corollaries worth carrying together, because they fail in opposite directions:

- **A green run is not a result until you can show the test was capable of going
  red.**
- **A red run is not a result until you know what reddened it.**

This is the depth behind the *quantifier / cause / severity* trigger in
`~/.claude/CLAUDE.md`. That trigger says when to stop and check; this says what
checking consists of, and catalogues the ways a check turns out to be decorative.

---

## 1. Sort your claims into measured and argued — then distrust the measured ones too

**The first pass.** Before sending any prose you wrote — a design, a plan, a task
note, a commit message, a summary — sort its claims into the ones with a command,
a measurement or a red/green proof behind them, and the ones argued from reading
code or a dependency graph. Spend the whole review on the second pile: for each
claim either run the experiment or restate it as an explicit obligation on the task
that will implement it.

Reviewing an approved design doc of mine adversarially, rather than re-reading it
approvingly, turned up three factual errors and two gaps. **All five were in the
sections I had reasoned; none were in the sections I had measured** — and the
document's own stated standard was *"verify by experiment, never by reading."*

**Re-reading for sense cannot work, because coherence is not evidence.** Argued
claims already have internal coherence — that is what made them persuasive enough
to write down. The tell is a **confidence word** (*provably*, *clearly*,
*obviously*) attached to a claim with no command behind it. Also re-read any code
fragment a reader would copy: two of those five errors were in a sample
`Dockerfile` that contradicted the prose beside it and omitted a step, without
which it would have shipped the exact defect it existed to remove.

**Review the remedy hardest.** A review's *evidence* can be measured while its
*prescription* is argued. In a re-review, two of five findings corrected **my own
earlier review** of the same work rather than the work — both in its prescriptions,
while its measurements held up.

**Then attack the measured pile, because "measured" is not a safe category.** Three
distinct ways a reproducible number is still wrong:

**The `WHERE` clause is authored, not observed.** A recommendation rested on *"of
63 actor columns exactly two carry a foreign key — so dropping this one makes it
match the other 61."* Every digit reproduced. Counting *columns that point at a user
row* instead gave **24 with a foreign key**. One database, two natural reference
classes, opposite conclusions, and nothing in the prose flagged that a choice had
been made. When a claim has the shape *"N of M are like this, so match them,"* write
a second query over another natural set — by what it references, by what writes it,
by which subsystem owns it — before agreeing. Expect the outcome **right answer,
collapsed support**: don't reject the conclusion, and don't let it ship with the
dead reason attached.

**The inclusion rule may not match the claim.** A count of `34 of 72` came from a
`grep -rl` that counted commented-out code, over a denominator that swept in a
non-migration file. The real figure was **31 of 71**.

**The unit of analysis may be wrong.** A microbenchmark calling the expensive
primitive directly gave a ceiling of ~**100** operations/sec from
`pool size ÷ per-item cost`. End to end it was **56/sec** on a quiet host and
**17/sec** with other work running alongside — optimistic by **1.8× to 6×**,
because the real path adds serial work the primitive never sees. Never derive a
ceiling that way. And note what survived: two runs twenty minutes apart on the same
laptop **disagreed 3× on the ceiling while the ratios did not move at all**. So
**report ratios as findings and absolutes as ranges, and size from the low end.**

**A suspiciously round factor is a harness smell — including in your own notes.** ~2×,
~½, ~10× on a quantity that should be arbitrary. One note recorded a `pg_dump` archive
as "~2× to a seekable file vs a pipe" (492,056 against 250,922 bytes) and explained it
with a mechanism: the TOC is written twice when the output is seekable. Re-measured on
the same schema, the two sinks are **byte-identical** — 393,262 both ways compressed,
1,106,046 uncompressed. The mechanism could not have produced a doubling either, since
seeking back to rewrite the TOC overwrites bytes rather than appending.

The note's own closing rule was *"when a measured number disagrees with a prediction by
a suspiciously round factor, suspect the harness before the code"* — and 492,056 /
250,922 = **1.96**. It applied that rule to the code under test and never to its own
harness, then wrote a mechanism that made the bad number unfalsifiable. **A plausible
mechanism is what lets a wrong measurement survive**, so check the harness *before*
reaching for an explanation. And take the baseline through the same sink the code
actually uses — that part was right, it just wasn't worth 2×.

**Falsify the cause before filing it.** Chasing an intermittent failure, I had two
confident theories and **both were wrong** — the queue was not backlogged (the wait
and active sets were 0 between runs), and clearing 28 stale keys before a run
changed nothing. Filing the first theory as the cause would have started the next
person from a false lead. Record what you *ruled out*, not a guess.

---

## 2. Find the pair of states the assertion cannot distinguish

**The generative question: name the two worlds this assertion is supposed to tell
apart, and say which observable differs between them.** If you cannot, the test is
structurally incapable of failing. Four mechanisms, all found by mutation:

**Returned null versus never ran.** A component that mounted and returned nothing
produces DOM identical to one that never executed — but only the second fired no
queries. Verified by mutation: rendering `{children}` inside
`<div className="hidden">` left **every DOM assertion green, and only the request
log failed.** Assert on a side-effect the two cases cannot share — a render spy
(`render(<Gate><Probe/></Gate>)` where `Probe` calls a `vi.fn()`, assert zero
calls), or a request log collected **before** navigating
(`page.on("request", …)`, assert the guarded procedure never appears).
**Absent markup never proves a gate blocked anything.**

**Read the column versus read a constant.** A lookup in an in-code table satisfies
every ordinary assertion — right values, right shape, green suite — while the
database column it supposedly reads stays untouched. *It looks exactly like a
reader in review.* To prove code reads a source, **make the two candidate sources
disagree**: `UPDATE` the row inside the test, re-run the reader, require the answer
to **flip**, restore in a `finally` because other specs share the table. A test
that checks only the *value* is checking the seed, and the seed and the hardcoded
constant agree by construction. Then verify the test is real by swapping the
constant back in and watching it go red.

**Excluded by the filter versus absent.** When a census or drift test narrows its
query by a list of names — `where column_name in ('a','b','c','d')` — **the filter
is the census.** Whatever it excludes does not exist to any assertion downstream,
so *both* the must-exist and the must-be-absent halves stay green on a column you
just added. Widen the filter *before* adding the column; red-proof it by dropping
one column and requiring the test to **name that table**. Prefer a filter expressed
as a **rule** (a `like` pattern, a regex, a pairing function) over a list, because a
rule admits the next column automatically. *If dropping a column does not redden
the test, the assertion was decorative.*

**Arrived in the bad state versus was always fine.** An after-the-fact state
comparison detects **reversion, never arrival**. Any hazard that ends in the state
the system is supposed to be in is indistinguishable from success. A guard that
re-read a security setting after a deploy and failed on anything that came back set
could catch a pre-existing object being re-set mid-deploy, but could never catch one
**created and set inside the same deploy** — which was the majority shape (**31 of
71** migrations) and is *correct*. Widening it to "everything present afterwards"
would flag all 31. Before writing a state detector, enumerate the hazards and ask
which end in a distinguishable state; for the rest, a detector is the wrong
instrument — prevent *during* the work, or check the input statically. **Say out
loud which hazards each instrument covers.**

---

## 3. The stand-in is the variable

**The reason for substituting is never a reason the substitution is sound.** Name
the substitution out loud before running, and ask what the real value can do that
the stand-in cannot. If nothing, say so; otherwise run the real value under a guard
— check the resource is idle, then use it — rather than swapping it out.

Reproducing a bug on shared infrastructure, I picked port **34567** instead of the
failing port **3000** so the probe could not collide with a running job. The result
— *"every form of the tool finds the listener"* — was true and irrelevant: the exact
variable under test had been changed in order to run the test safely. It surfaced
only because the next probe failed for an unrelated reason.

**When the behaviour under test is ordering, the key format *is* the variable.** A
prune function sorts ids as strings, where a real id looks like
`prefix-20260922T020000000Z`. A probe that named its fixture `20260922T020000Z`
sorted it **first** (digits before letters), so the orphan was pruned first and the
probe concluded *"no good backup is lost."* With the real prefix it sorts **last**,
survives, and evicts every good backup ahead of it — **the opposite conclusion,
from the same real code and the same real assertion.** Nothing was faked: real
engine, real target, real prune, which is exactly what made the result look
authoritative.

So: build fixtures with the **production id helper**, never a literal, and
sanity-check the ordering itself (`[...ids].sort()`) before asserting on what
survived. Port numbers, table names, user ids and dates all carry behaviour —
`/etc/services`, reserved ranges, partial indexes, DST.

---

## 4. A red proof needs its own proof

A negative result carries no information about *why*. Establish three things before
believing one: **the mutation landed**, **the message is the expected one**, and
**it is the assertion under test that fired.**

**Grep for the specific message, never a bare non-zero exit.** A five-case shell
suite had four cases grepping their own expected message, and **case E — the one
written specifically to stop vacuous passing** — settled for a non-zero exit. On
the first CI run the interpreter was not installed, so *every* invocation exited
non-zero with no output: `1 passed, 6 failed`, and the single green line was case E,
certifying an outcome produced by a missing interpreter. The positive baseline
(case A) went red immediately and is what exposed it. **Keep a positive baseline in
the same suite** to detect a harness that fails everything, and validate the suite
by pointing it at a stub that exits non-zero with an unrelated message and requiring
**0 passed**.

**Guard the mutation itself.** Proving four assertions by removing each one in
turn, the mutation script **silently failed to edit the file** — the target string
now occurred twice in that registry, so an unanchored replacement matched two
occurrences and aborted. The suite then legitimately passed, producing **four
consecutive `6 passed` lines** that read as evidence the assertions were
unnecessary; only the tracebacks above them gave it away. So: assert the edit
landed before trusting the run —

```python
assert s.count(old) == 1, f"expected 1 occurrence, got {s.count(old)}"
```

— print a loud `!! mutation failed, the result below is meaningless`, and treat a
green run from an unguarded harness as **no result**, not a pass. **A string that
occurs twice is not an address.**

**Read the full verdict and list every check that fired.** Two new sentinels were
added to a drill to catch a specific corruption. The red proof did fail on them —
and also produced **19 row-count mismatches that the drill's existing comparison
already failed on**, so on that shape the sentinels were not what caught it. If a
pre-existing check already fires, either state the new assertion's distinct value or
find the shape where **only** it fires. The honest residual value here was narrower
than the original claim: naming the damage instead of a count, and covering the
shape where *every row lands* and only provenance is wrong. **The honest claim
shrinks.** Also ask what a maintainer will reach for when it goes red; and look for
a binary-path indirection (a `*_BIN` env var) so the failure shape needs no source
edit you must remember to revert.

**Ask which *other* guard throws the same code.** A shared procedure answered
`FORBIDDEN` both for a failed permission check and for a suspended-tenant check. A
hand-built context omitting one field would have made **all seven mutations in a
deny suite refuse for the wrong reason** — and the suite would look perfect,
because a deny test that expected a refusal got one. Assert code **and** message
(`expect(err.message).toBe("Not authorized.")`), set every fixture field the
upstream guards read explicitly with a comment saying why, and red-proof by
reverting the one thing under test and checking **that** case reddens and its
neighbours do not. The failure mode is inverted: **the more guards a procedure has,
the easier it is to get a green deny suite that proves nothing.**

---

## 5. Nothing ran, and the silence read as a result

These fail *below* the assertion layer, so no amount of assertion design helps.
**The visible text is not the verdict** — in both directions.

**A wrapper prints its children's status, never its own.** I piped a commit through
`tail -12`, saw a port-in-use error and `Exit status 1`, and reported the commit as
**failed**. It had succeeded: HEAD was the new commit, the tree was clean, all 17
files in. The errors came from a stale process holding a port *inside* the hook's
test run — noise the hook tolerated. Before reporting any command as failed on the
strength of its output, capture `$?`; for a commit, ask the repo read-only
(`git log --oneline -1`, `git status --porcelain`). Re-running instead would have
produced a duplicate commit.

**And the mirror: quiet success lines can hide a real failure.** A test run can
print **every test as ✓ and still exit 1** — an unhandled rejection is reported in
a separate `Unhandled Errors` block, belonging to no test, so a pipeline grepping
`✓|×|Tests` sees a clean pass. The assertion layer structurally cannot see a
failure in a promise nobody awaited; only the runner can. Read `$?` as well, and
include `Unhandled|Errors` in any grep of a test log. When the thing under test
*is* an abandoned promise, the exit code **is** the assertion — say so in a comment
so nobody "simplifies" it into an `expect`.

**A shell that refuses the block looks like a block that passed.** A shell parses the
whole input before running any of it, so **one parse error means nothing runs** —
which reads exactly like "all the checks passed silently." Measured in zsh 5.9.2:
`zsh -c 'echo FIRST; …; )bad('` printed only `zsh:1: parse error near ')'` and never
ran `FIRST`. The trigger is unbalanced quoting or brackets in a long inlined block,
**not** borrowed syntax — a `f() { …; }` definition and `VAR=value cmd` both run fine
under zsh, so do not blame a bash-ism for it. Write proof scripts to a file and run
them with `bash file.sh` rather than inlining multi-command shell. And watch for
reserved names: `status` is read-only in zsh as well as fish
(`( status=0 )` → `read-only variable: status`), so capture into `rc` instead.

**A no-match glob can abort the whole command — in some shells.** `ls .eslintrc*
eslint.config*` died with `no matches found: .eslintrc*` and **never evaluated the
second pattern, even though a matching file existed**, producing a confident claim
that the repo had no linter config when one was wired into a *required* CI check.

Measured, and the shell decides whether you get the false negative at all:

| shell | result |
|---|---|
| bash 5.3 | passes the literal through; `ls` complains about the missing pattern but **still lists the file that exists** |
| zsh 5.9 | `no matches found: .eslintrc*` — aborts, second pattern never evaluated |
| fish 4.9 | `No matches for wildcard` — aborts the same way |

So this specific wrong conclusion is reachable under zsh and fish and **not** under
bash, which is worth knowing before you trust a one-glob negative from a harness
whose shell you have not checked. **Never conclude "X does not exist" from one
glob**; confirm absence a second way before saying it out loud. Safe forms:
`ls 2>/dev/null; true`, `find . -maxdepth 1 -name 'pattern'`,
`rg --files | rg pattern`.

**A revert can destroy or fail to restore.** `git checkout -- <dir>` after a
scripted mutation **left the damage in place** for an untracked file — which then
shipped — and in the same command silently reverted an **uncommitted fix** in a
tracked file back to HEAD. Two opposite directions: untracked files are not
restored; tracked files are restored *too far*. Back up to a scratchpad and restore
from that copy rather than from git; run `git status` before and after each proof
round; commit or stash real work first.

**But do not flatten the backup.** Copying files from several directories into one
scratch dir silently overwrites same-basename files — `page.tsx`, `index.ts`,
`route.ts` — and the restore then puts the wrong content back, with no error at any
step. Mirror the tree (`cp --parents`, `rsync -R`) or use `git stash push -- <paths>`,
and assert on **content** after restoring. `shell-and-git-forensics` §4 has the
worked case.

---

## 6. Can this ever be checked? Verifiability as a design property

Before building a check, ask what would make it **unable to answer**.

**The row it lives on may be deleted.** A design encoded a decision as the
*absence* of a value — an admin action "attests the next credential by leaving the
column NULL." But that action deletes the row, and the fresh row from the next
enrolment carries NULL because nothing has stamped it. NULL then meant both *"an
administrator vouched"* and *"unstamped, nobody proved anything"* at the moment
something had to choose. **Both resolutions of the ambiguity ship a bug, in
opposite directions** — a security hole one way, an availability hole the other —
so neither is a safe default. When a design encodes a decision as an absence, ask
which procedure writes it, which deletes the row, and what a freshly-created row
looks like. If *"not yet decided"* and *"decided: yes"* render identically, the
design is unbuildable: use an explicit boolean that fails closed, on the table where
the fact is actually true.

**The window may never have been covered.** An integrity check answers *"is what I
covered still what I covered?"*, which says nothing about what was never covered.
For a periodic detector the cheapest attack is **patience, not forgery** — stop the
batcher, change things in the uncovered window, restart, and the next batch covers
the changed state as though it had always been that way. **Coverage is a separate
property from correctness and needs its own assertion, placed in the verifier rather
than the detector** — a stopped detector cannot report that it stopped. Two checks
from both sides: consecutive batches more than `MAX_LAG` apart, and uncovered items
**older** than `MAX_LAG`; the age threshold is what separates "we are behind" from
"someone wrote into the past". Note how easily the design *legalises* its own off
switch: where gaps in a sequence are legitimate, "this row is in no covered span"
cannot itself be an alarm.

**The evidence may be destroyed by a sanctioned path.** Any scheme that hashes a
**range** loses the ability to check that range once the rows are gone, so the
legitimate deletion path — retention purge, erasure request, lifecycle job — is the
perfect laundering path. *"Deletion stays auditable because the checkpoint survives
the rows"* is true about **the fact of deletion** and false about **the integrity of
what was deleted**; the digest still states a count nothing can ever re-derive.
Verify every span immediately **before** invalidating it and refuse if any fails, so
the deletion record is a signed statement that the range was intact when it went.
And note that **an approvals table on its own is not evidence — it is as writable as
anything else**, so it can be filled in afterwards: seal the approval before the
purge may run, and carry approver, timestamp and note *inside* the MAC.

**The evidence may sit somewhere the adversary can rewrite.** A scheme is only as
strong as where its head is anchored; a digest in a table the same actor can rewrite
proves nothing.

---

## 6b. A proof of the parts is not a proof of the join

**When two features are built an increment apart, every individual proof can pass
while the thing they form together is broken.** Neither increment's proof list
names the join, because neither increment owns it.

Two instances, found the same week, both reaching production:

**A "supersede" that superseded nothing.** One increment added a mint that
inserted a new row and inherited the old row's counter. A later increment added a
detector refusing two live rows. Each was proved. Together: the mint's own rule
required the predecessor to be *unexpired*, so every legitimate resend produced
exactly the state the detector refuses — a nine-minute outage on three
procedures, reachable by following the product's own on-screen advice.

**A cooldown whose arithmetic was proved to the millisecond.** The policy function
was pure, clock-injected and unit-tested at its boundary; the row-read beneath it
had its own clock-seeded integration tests. The function joining them had no test
at all, because it was module-private and ran behind a scheduler.

**Why the existing tests could not catch either.** In both, a fixture *built the
broken state and then stopped* — asserting a row count, or reading the table with
a privileged client rather than through the code path under test. In one case the
fixture's own comment said it produced the state the other property detects, and
still nobody read the table back afterwards.

**How to apply.**

- After a test produces an interesting state, **call the real reader before the
  test ends** — through the repo or the router, not the admin client. A count is
  not a read.
- When a fixture's comment says it produces the state another property detects,
  **that sentence is the missing test.** Write it.
- When two increments share a table, a queue or a file, **one proof must cross the
  seam in the direction the product does.**
- At review time, ask of each increment: *what reads this next, and does anything
  exercise that?* The answer is usually "a different increment's deliverable, and
  no".

---

## 7. A scope claim owes an enumeration

Before any mechanism — a trigger, a database default, an extension — takes over a
column, grep **every** write site, not a sample, and ask of each: *is another value
in this same object computed from it?* A column that looks like plumbing can be an
argument somewhere, and **the caller owns the pair, not the column.**

Designing a trigger to stamp a timestamp from the database clock across 33 tables,
three writers turned out to pass an explicit value **paired with an expiry computed
from the same clock reading**. A trigger replacing one half shifts every expiry by
the transaction's latency: *a green build and broken auth.*

Then record the resulting scope as a **rule** in the design, not a one-off
exception, so the next table is caught mechanically rather than by luck — the same
move as preferring a pattern over a list of names in §2.

---

## 8. Verifying claims about documents

Two of these are verification procedures that happen to target prose, and both have
a one-command check.

**A citation's line numbers are not evidence of its path.** A review cited a
function at `<pkg>/src/mfa.ts:211-238`. The content and *both* line numbers were
exactly right — **for a different module** with the same symbol. The file actually
named is **95 lines long**, so the citation pointed past its end, and two further
citations quoted that other module's header. A reviewer who jumps by symbol
confirms the content and silently accepts the wrong file. Verify by opening **that
path**: `sed -n '<line>p' <path>`, or `wc -l` first. When it fails, ask what the
author *was* looking at rather than just fixing the number — that is how the
95-line discrepancy surfaced.

**The reason for a constraint is usually written within three lines of it.** Before
writing *"we could just drop or relax X,"* read the ~10 lines around X in the
migration that added it, and grep the validator or drift detector for how it treats
X's class. Twice in one review I proposed a cheap fix that a comment three lines
above the statement existed to refuse, and treated a deliberate exemption as an
undocumented weakening when the detector that tolerated it said *"deliberately … so
migrations can seed them."* A recorded decision is invisible to a code search for
the table name. Follow it or argue against it explicitly — never silently around
it. **The cheap fix you are about to propose is often the one a comment already
refused.**

**And the shape these share with the tracking cases:** the relation between two
written things lives in the text of whichever was written **second**, where no
generator, no grep-by-topic and no go-to-definition will find it. A precedence rule
of the form *"where an amendment conflicts with the body, the amendment wins"* says
nothing about amendment-versus-amendment, and each amendment is written against the
body by someone who has not re-read the others: one amendment made a timestamp
unforgeable on purpose, and another **two days later** made it writable on every
covered table, both approved, nothing resolving them. Before implementing amendment
*n*, grep the earlier ones for the **table, column or function** it touches — not
for its topic, which will not match.

*Cross-reference:* `work-tracking` for the same failure in a generated queue — a
numeric priority field cannot read a dependency stated in prose, and an obligation
to measure must not be parked just because the task holding it was re-ranked.

## Related

- `postgres-behaviour` — the traps this page's discipline is usually applied to: a
  row count that is vacuous under row-level security, a tiebreaker test that never
  forces the plan, a guard that counts zero and passes for the wrong reason.
- `pg-dump-and-restore` — the canonical vacuous green: a restore drill that reports
  success, exits as expected, and restored nothing.
- `prisma-behaviour` — a bare `.rejects.toThrow()` satisfied by a client-side error
  that never reached the database, and a rollback drill whose re-apply was a no-op.
