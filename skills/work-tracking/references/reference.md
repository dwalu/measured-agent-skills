# Why the rules are the way they are

## Contents

- Identity and priority cannot be the same field
- Ranks are spaced by 100, and ties are legal
- The order is generated, never written
- Bold is ownership; plain is citation
- A rank has no `#`
- Owner and rank: errors in a new repo, warnings in an old one
- The citation and promise checks
- Why the validator has no dependencies
- Why the CI job has no path filter
- The self-test exists because these rules are heuristics
- Deliberately not built

Each of these looks arbitrary until you know what it cost. They come from
running this system across ~285 tasks and 19 flows in a production repo; most
were added *after* the failure they prevent.

## Identity and priority cannot be the same field

The original scheme had one number per discovered problem, and treated it as
both "which problem is this" and "how urgent is it". That works until the most
urgent work in the repo is discovered last.

It was deployment. Deployment — the one thing standing between the repo and a
running product — got numbers 50 through 57, the tail of the queue, because
numbers only ever increment. There was no legal way to express "this is first"
without renumbering, and renumbering was impossible: by then the numbers were
cited in 56 immutable commit messages and ~110 places across the docs, two of
whose forms defeat a scripted rewrite outright (range citations like
`TODO-50…57` are not greppable per number, and one design doc used TODO numbers
as a table's primary key).

So: **`TODO-<n>` is identity — allocated once, never reused, never renumbered.
`Rank` is priority — nothing cites it, so it can be rewritten freely.** The
validator enforces the first half by making TODO numbers share a uniqueness
namespace with task ids.

The tell that you have this wrong in some other system: you find yourself
wanting to renumber, and can't.

## Ranks are spaced by 100, and ties are legal

**Spacing 100** means inserting between two tasks edits exactly one line in one
file. Two PRs inserting at different points produce disjoint diffs and cannot
conflict — which a single central ordered list does not give you. This is not
hypothetical: two concurrent tracking PRs in the source repo silently reverted
each other's generated rollup, and each validated fine on its own.

**Ties are legal** and mean "the order between these does not matter". They
break deterministically on `(rank, file, line)`. Requiring unique ranks would
re-create the concurrent-allocation race one layer up: two PRs both inserting
"just before Stage B" both pick 150. If the relative order genuinely matters,
give the tasks distinct ranks rather than relying on where they sit in the file.

**When the gaps run out** (about six successive midpoint inserts in one place),
`--renumber` remaps the distinct rank *values* onto 100, 200, 300… Because that
is a monotone remap of values — not a re-sort of tasks — every relative
comparison, every tie, and the whole task→feature→flow inheritance structure
survive untouched. Verified on the source repo's full tree: 49 ranks respaced
across 11 files, queue order byte-identical before and after.

`--new-task --after <id>` computes a midpoint and **refuses when the neighbours
are adjacent**, telling you to renumber. Silently picking a tie would be worse:
a tie asserts the order does not matter, and you just said it does.

## The order is generated, never written

The same sequence was once copied by hand into five documents. It drifted in all
five — one sat eighteen days stale while an entire missing feature had no home.
Prose does not diff against prose, so nobody saw it.

Now `QUEUE.md` and `MASTER.md`'s rollup are generated between markers, and a
**staleness check runs on every commit**: flip a status without `--write` and
the hook fails. That check is what makes generation trustworthy rather than
merely convenient.

Two smaller consequences worth keeping:

- The validator **prints the top 3 of the queue on every run** — every hook,
  every CI job. That is the highest-frequency feedback loop in a repo, so a
  wrong order gets *seen* rather than filed. The document that rotted was the
  one nobody opened.
- `MASTER.md` generates its flow **links**, not just its numbers. The
  hand-maintained bullet list it replaced had silently lost a whole flow.

## Bold is ownership; plain is citation

A task owns the `**TODO-n**` written in bold immediately after its id, and
nothing else. A number mentioned anywhere else in the line is a citation and
must be written plain.

The parser originally took the first bold `TODO-n` anywhere in the line. That is
wrong for exactly one row in a 285-task tree, and wrong in the worst way: a
design task with no number of its own cited another task's number in its prose,
and so parsed as *owning* it. Harmless while nothing read the field — a false
duplicate the instant uniqueness was enforced.

Placement is therefore enforced, not assumed. Without the check, a bold number
in the wrong place silently reads as "this task has no number", which is the
same class of quiet wrongness the anchoring exists to fix.

## A rank has no `#`

The PR-link parser falls back to a bare `/#(\d+)/`. A rank written `#110` would
satisfy the "🟦/✅ needs a PR link" rule *using its own rank number*, and the
task would look reviewed. Hence: plain integer, 1–9999, and a malformed rank is
an error rather than being treated as unranked — an unparseable rank reads as
"no rank" and the task quietly falls to the bottom of the queue while its line
looks ranked.

## Owner and rank: errors in a new repo, warnings in an old one

Both checks are migration-hostile. In the source repo, 160 of 285 tasks predated
the owner rule; turning it red would have failed every commit in the repo for
work nobody was doing.

But a rule nothing surfaces is a rule that decays — that is exactly how "every
task has an owner" reached *zero* tasks owned while the sentence sat in the
project's instructions. So: warned, collected into **one summary line** rather
than 160 (a warning channel with 160 entries is one everyone scrolls past), and
promotable to errors via `strict` once the backlog catches up.

`init.mjs` writes `strict: true` because a greenfield repo pays nothing for it.

**Unranked and unowned are both legal states, deliberately.** ⬜ todo and
⏸️ deferred are exempt from the owner rule — an unassigned backlog is precisely
what "unassigned work does not start" permits. And unranked means "order not
decided yet": requiring a global priority judgement at the moment of filing
would tax exactly the behaviour the system exists to make cheap, which is filing
discovered work instead of absorbing it into whatever you were doing.

## The citation and promise checks

These are what make the tracking files load-bearing rather than decorative.

**Every id or TODO number cited anywhere must resolve.** Since ids are never
reused, a citation that does not resolve is a typo. Deliberate exceptions go in
`citations.deadRefs` **with a reason** — a dead reference should cost someone a
line of diff, because adding to that map is the act of declaring "yes, this
points at nothing, on purpose".

**A promise in a code comment must not name a finished task.** Comments say
things like `// F17.4-I1 drops this column`. The increment ships, the comment
stays, and the next reader believes it. One flow accumulated *three* such
orphaned promises, each found by hand an increment apart, plus one made to a
task id that never existed at all.

Two pieces of tuning in that check are load-bearing:

- **The 25-character window** between the id and the verb. A real promise reads
  `F17.4-I1 drops it` (1 character). A test fixture comment read
  `(F01.3-I3): student A takes the seat, B waitlists, A drops → B promoted` — a
  student dropping a *course*, 43 characters away. Widen the window and that
  line becomes a false positive.
- **Prose gets the id-existence check but not the promise check.**
  Documentation is written in the future tense on purpose ("F02.1-I10 replaces
  the stub"), so the heuristic that reads well against a code comment is pure
  noise against a design doc.

**Immutable directories are exempt** via `citations.sourceExclude`. A database
migration is a historical record: "F17.4-I1 drops user_id", written in an
August migration, was accurate then, and the file cannot be rewritten anyway
because the migration is checksummed.

**The tracking README is exempt** via `citations.docsExclude`. That document
*specifies the id grammar*, so its worked examples are necessarily fictional
ids. Without the exemption the scaffold fails on the repo's first commit — this
was caught during packaging, by committing the scaffold rather than trusting
that a green run on an unstaged tree meant anything. (`git ls-files` cannot see
files that are not added yet, so an untracked scaffold validates green for the
wrong reason.)

## Why the validator has no dependencies

It is pure Node ESM with no install step, and that is a design constraint, not
an accident: **the first commit in a repo is the one that adds the toolchain**,
and a tracking gate that needs the toolchain cannot gate it. It is also gate #1
in the pre-commit hook — cheapest first, so the common failure is reported in
milliseconds rather than after a test suite.

## Why the CI job has no path filter

The obvious filter is `on: pull_request: paths: ['plans/tracking/**']`. Do not
add it. If the job ever becomes a **required** check, a code-only PR gets no
report at all — and a required check that never runs blocks the PR forever. The
job is a checkout, a node, and one script with no install behind it. It costs
seconds. (A skipped job counts as passing; a job that never reports does not.)

## The self-test exists because these rules are heuristics

Three of the checks — the promise window, the citation resolver, the bold/plain
distinction — are pattern matches tuned against real text. A heuristic that has
been widened by one careless edit still returns green; it just stops catching
anything. That failure is invisible from the outside, which is why
`scripts/selftest.mjs` asserts both directions: rules that must fire, and rules
that must **not**.

The suite was mutation-tested when it was written, and one gap it found is worth
recording. The tracking-README exemption is implemented twice — `init.mjs`
writes `docsExclude` into the generated config, *and* the validator defaults the
key when absent. Removing either one alone changes no observable behaviour, so
the original scaffold check could not see it. There is now a check per path: one
scaffolding normally, one on a config with the key deleted. Redundancy in the
implementation needs redundancy in the tests, or half of it is unverified.

## Deliberately not built

- **Auto-insertion of a task at an arbitrary position.** `--new-task --apply`
  appends to the end of a section, because rank determines order and physical
  position is only a tiebreak. Inserting "in the right place" in the file would
  imply the file's order matters more than it does.
- **Cross-repo or multi-project rollup.** One repo, one tree.
- **Any notion of estimate, velocity, or burndown.** The queue answers "what
  next"; it does not predict when.
