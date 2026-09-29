# Work Tracking

File-based, Markdown work tracking that decomposes the project into discrete,
status-tracked units of work. **Keeping it consistent is a prerequisite to
committing** (git hooks + CI — see [Enforcement](#enforcement)).

Everything here is plain Markdown in the repo. That is the point: the work list
lives in the same diff, the same review and the same history as the code it
describes, so a change to the plan and the change to the code arrive together or
not at all.

## Hierarchy

```
Spec  →  Flow ({{PREFIX}}01)  →  Feature ({{PREFIX}}01.2)  →  Design / Implementation tasks ({{PREFIX}}01.2-D1 / -I1)
```

- **Flow** — an end-to-end user journey (one file in `flows/`).
- **Feature** — a shippable capability within a flow (`## ` heading).
- **Task** — a unit of work under `### Design` or `### Implementation`.

## IDs — stable, never reused

| Level | Pattern | Example |
|-------|---------|---------|
| Flow | `{{PREFIX}}<NN>` | `{{PREFIX}}01` |
| Feature | `{{PREFIX}}<NN>.<n>` | `{{PREFIX}}01.2` |
| Design task | `{{PREFIX}}<NN>.<n>-D<k>` | `{{PREFIX}}01.2-D1` |
| Implementation task | `{{PREFIX}}<NN>.<n>-I<k>` | `{{PREFIX}}01.2-I1` |

## TODO numbers — identity, not order

Task ids say *where* work sits in the spec. **TODO numbers say which discovered
problem it is**, so work found mid-increment gets filed rather than absorbed:

```markdown
- [ ] `{{PREFIX}}02.1-I7` **TODO-41** · **Rank:** 800 · **Owner:** {{OWNER}} · <what is wrong, and how you know> — ⬜
```

`<n>` increments across the whole repo, not per flow. Allocate it with the tool,
never by eye:

```bash
node scripts/validate-tracking.mjs --new-task {{PREFIX}}02.1 --after {{PREFIX}}02.1-I6 --title "**Short claim** — evidence"
```

**A number, once spent, is never reused and never renumbered.** Commit messages,
design docs and source comments cite TODO numbers in prose, and prose is not
something any tool can re-point.

**Numbers therefore cannot encode priority.** The two jobs are incompatible: a
number that can never move cannot also express an order that changes. Order
lives in [Rank](#rank--the-order-of-the-work).

**Bold means ownership; plain means citation.** A bold `**TODO-n**` is legal only
immediately after its own task id. Anywhere else, write it plain:

```markdown
- [x] `{{PREFIX}}02.1-D3` … filed on the way through: TODO-44 … — ✅ PR #12
```

This is enforced, and it is not a style rule: a citation written in bold parses
as the *owner* of a number belonging to another task, which is a false duplicate
the moment uniqueness is checked.

### Burned numbers

A number allocated but never used is **burned**, not backfilled — a number
pointing at work someone invented later is worse than a gap, because the gap is
honest about what was lost. Declare it in `citations.deadRefs` in
`tracking.config.json` with the reason, or the citation check will (correctly)
call it a typo.

## Rank — the order of the work

`**Rank:** <n>` carries priority. **Lower runs first. Nothing cites a rank**,
which is the entire point: it can be rewritten freely, exactly where a TODO
number cannot.

Rank resolves by precedence — the same precedence Owner uses:

> **inline task rank → feature rank → flow rank → unranked**

Set it on the feature heading when its tasks are interchangeable, and inline on a
task to override:

```markdown
## {{PREFIX}}00.1 — Toolchain
- **Rank:** 4200                                          ← every task here, unless…

- [ ] `{{PREFIX}}00.1-I9` **TODO-28** · **Rank:** 3400 · … — ⬜   ← …this one, which runs earlier
```

Ranks are **spaced by 100** so inserting between two tasks edits exactly one line
in one file. No neighbour is touched, so two PRs inserting at different points
produce disjoint diffs and cannot conflict — which a single central ordered list
would not give you.

**Ties are legal and mean "the order between these does not matter."** They break
deterministically on `(rank, file, line)`. Requiring unique ranks would re-create
the concurrent-allocation race one layer up: two PRs both inserting "just before
Stage B" both pick 150. If the relative order genuinely matters, give the tasks
distinct ranks rather than relying on where they happen to sit in the file.

A rank is a plain positive integer, 1–9999, with **no `#`** — a `#` is read as a
PR link. A missing rank is legal and means "order not decided"; those tasks sort
last, in their own section of the queue.

When the gaps run out (about six successive midpoint inserts in one place):

```bash
node scripts/validate-tracking.mjs --renumber          # dry run — shows every change
node scripts/validate-tracking.mjs --renumber --apply
```

This remaps the distinct rank values onto 100, 200, 300… — a monotone remap, so
every relative order, every tie and the whole inheritance structure survive
untouched. It is safe *because ranks are uncited*.

## The queue

[`QUEUE.md`](QUEUE.md) is generated from the ranks — **do not edit it by hand.**
It answers "what do I work on next", and it lists unranked and ⛔ blocked tasks
in separate sections so it can never quietly imply a blocked task is actionable.
The validator prints the top 3 on every hook run and every CI job.

## Status legend

| Marker | Status | Meaning |
|--------|--------|---------|
| ⬜ | todo | Not started |
| 🟨 | in_progress | Being worked on |
| 🟦 | in_review | PR open (requires a `PR #<n>` link) |
| ✅ | done | Merged (checkbox `[x]`, requires a `PR #<n>` link) |
| ⛔ | blocked | Needs `(blocked: reason)` |
| ⏸️ | deferred | Intentionally out of current scope |

Rollup: a **feature** is ✅ only when all its tasks are ✅; a **flow** is ✅ only
when all its features are ✅. `MASTER.md`'s rollup table is auto-generated.

## Authoring format

```markdown
# {{PREFIX}}01 — Enrollment & Registration

- **Spec:** §6.4, §6.2
- **Phase:** 1c
- **Status:** ⬜ todo

## {{PREFIX}}01.1 — Catalog browse & search

- **Spec:** §6.4
- **Rank:** 300
- **Owner:** {{OWNER}}
- **Status:** ⬜ todo

### Design
- [ ] `{{PREFIX}}01.1-D1` Catalog data model — ⬜

### Implementation
- [ ] `{{PREFIX}}01.1-I1` Catalog query API — ⬜
- [ ] `{{PREFIX}}01.1-I2` Browse/search UI — ⬜
- [ ] `{{PREFIX}}01.1-I3` E2E: browse & filter — ⬜
```

Enforced: every flow/feature has `**Spec:**` and `**Status:**`; every task id is
well-formed, unique, and nested under the right parent; the checkbox and the
emoji agree (`[x]` ⇔ ✅); 🟦/✅ tasks carry a `PR #<n>`; ⛔ tasks carry a reason;
`MASTER.md` and `QUEUE.md` are fresh.

## Owner

Work does not start unassigned. Record `**Owner:**` under the feature heading, or
inline on a task. ⬜ todo and ⏸️ deferred are exempt — an unassigned backlog is
exactly what "does not start" permits.

## Citations that must resolve

Two checks make the tracking files load-bearing rather than decorative:

- **Every task id and TODO number cited anywhere** — in prose or in a source
  comment — must resolve to something that exists. Ids are never reused, so a
  citation that does not resolve is a typo.
- **A promise in a code comment must not name a finished task.** `// F17.4-I1
  drops this column` outlives the increment that kept it. When the named task is
  ✅, either the promise was kept and the comment is stale, or it was dropped and
  nobody owns it — both need a human, and the fix differs.

## How to update

1. Edit the relevant `flows/*.md`: change the task's checkbox + emoji, add
   `PR #<n>` when it enters review or merges.
2. Regenerate: `node scripts/validate-tracking.mjs --write`.
3. Commit with the task trailer. The pre-commit hook re-validates.

## Enforcement

- **commit-msg hook** — every commit message ends with a trailer
  `{{TRAILER}}: <id>` referencing an existing, not-yet-done task. Exemptions:
  merge/revert commits, or any message containing `[skip-task]`.
- **pre-commit hook** — runs the validator; blocks on any inconsistency.
- **CI** — re-runs the validator on every PR.

```bash
node scripts/validate-tracking.mjs           # validate
node scripts/validate-tracking.mjs --write   # regenerate MASTER + QUEUE, then validate
node scripts/validate-tracking.mjs --next    # what's at the head of the queue
node scripts/validate-tracking.mjs --json    # machine-readable state
```
