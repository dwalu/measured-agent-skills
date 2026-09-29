---
name: work-tracking
description: Set up and operate a Markdown work-tracking system in a repo — flows → features → tasks, with TODO numbers as stable identity, a separate Rank field as movable priority, a generated queue, and git hooks + CI that refuse a commit whose tracking is inconsistent. Use when starting a project that needs a durable plan, when a repo's work list has drifted from its code, or when filing/picking/reordering tracked work in a repo that already has it.
---

# Markdown work tracking

A work list that lives in the repo, in the same diff and review and history as
the code it describes, and that **CI refuses to let drift**. Built and hardened
over ~285 tasks in a production codebase; this packages it to install anywhere.

Two ideas carry most of the value, and both are things people get wrong by
default:

1. **Identity and priority are separate fields.** A task's number is cited in
   commit messages and design docs, so it can never move. Priority changes every
   week. One field cannot do both jobs — the attempt is why hand-kept backlogs
   rot.
2. **The order is generated, never hand-written.** A hand-maintained ordered
   list gets copied into a status doc and a roadmap, and then all three drift,
   invisibly, because nobody diffs prose against prose.

`references/reference.md` has the full rationale and the failure modes each rule exists to
prevent. Read it before changing a rule; the non-obvious ones look arbitrary
until you know what they cost.

*(`$SKILL` below is this skill's own directory — the host prints it when the
skill activates; on Claude Code it is `~/.claude/skills/<name>`, on Gemini CLI
`~/.gemini/skills/<name>`.)*

## Install into a repo

```bash
node $SKILL/scripts/init.mjs
```

Idempotent — existing files are reported and left alone. It writes
`scripts/validate-tracking.mjs` (dependency-free, copied in so the repo stays
self-contained), `tracking.config.json`, the tracking documents, `.githooks/`,
and a GitHub Actions workflow. Useful flags: `--dir`, `--prefix`, `--owner`,
`--trailer`, `--lenient`, `--no-hooks`, `--no-ci`, `--force`.

Then, once per clone: `git config core.hooksPath .githooks`

**Adopting into an existing backlog?** Pass `--lenient`. Owner and rank default
to hard errors, which is right for a greenfield repo and hostile to a repo with
200 unannotated tasks — it would fail every commit until the backlog caught up.
Flip `strict` back on in `tracking.config.json` once it has.

**Finish the install by pointing your agent instructions at it.** A rule the
agent never reads is a rule the agent breaks. Put these in `CLAUDE.md` /
`AGENTS.md`:

- Pick work from `QUEUE.md`, never from a TODO number.
- Every commit ends with a `Task: <id>` trailer, or `[skip-task]`.
- Flip the task's status in its flow file, then run `--write`, in the same PR.
- File discovered work with `--new-task` instead of absorbing it.

## The model

```
Spec  →  Flow (F01)  →  Feature (F01.2)  →  Task (F01.2-D1 design / F01.2-I1 implementation)
```

One file per flow. Ids are permanent and never reused.

A task line carries, in this order:

```markdown
- [ ] `F02.1-I7` **TODO-41** · **Rank:** 800 · **Owner:** Ada · <what is wrong, and how you know> — ⬜
```

| Field | Job | Moves? |
|---|---|---|
| `` `F02.1-I7` `` | where the work sits in the spec | never |
| `**TODO-41**` | which discovered problem this is | **never** — it is cited in prose |
| `**Rank:** 800` | what to do next; lower first | **freely** — nothing cites it |
| `**Owner:**` | whose it is | freely |
| emoji | ⬜ 🟨 🟦 ✅ ⛔ ⏸️ | freely |

Rank and Owner both resolve **task → feature → flow**, so the common case is one
`- **Rank:** 300` on a feature heading covering all its tasks, with the odd task
pulled out of line inline.

## Daily use

```bash
node scripts/validate-tracking.mjs --next          # what to work on
node scripts/validate-tracking.mjs --json          # same, machine-readable

# file discovered work — allocates the TODO number and a rank, inserts the line
node scripts/validate-tracking.mjs --new-task F02.1 --after F02.1-I6 \
  --title "**Short claim** — the evidence" --apply

# after flipping a status / editing a rank, always:
node scripts/validate-tracking.mjs --write

# gaps run out after ~6 midpoint inserts in one place:
node scripts/validate-tracking.mjs --renumber          # dry run
node scripts/validate-tracking.mjs --renumber --apply
```

`--renumber` remaps the distinct rank values onto 100, 200, 300… That is a
monotone remap, so every relative order, every tie and the whole inheritance
structure survive unchanged. It is safe *only* because ranks are uncited — which
is the entire reason the field exists separately from the TODO number.

## Writing a good task

**State what is wrong and how you know, not what to build.** The fix is usually
obvious once the problem is stated precisely, and a task written as a claim can
be checked against reality later — a task written as a plan cannot.

Bad: `Add retry to the email sender.`
Good: `**A failed send is only a log line, so "the OTP never arrived" is not
answerable.** Five call sites send outside the transaction; a throw turns a
committed side effect into a 500…`

The `--title` you pass to `--new-task` becomes the queue label, so lead with a
bold one-line claim and put the evidence after it.

## What the gates actually catch

Run on every commit and every PR:

- checkbox and emoji disagree; 🟦/✅ with no `PR #<n>`; ⛔ with no reason
- malformed or duplicate ids — **including duplicate TODO numbers**, which is
  the one race the scheme has (two concurrent PRs taking the next free number)
- a bold `**TODO-n**` written anywhere but immediately after its own task id —
  a citation in bold parses as *owning* another task's number
- a rank written as `#110` — the PR-link parser would read it as a PR
- a feature marked ✅ with unfinished tasks; same for a flow
- `MASTER.md` or `QUEUE.md` stale — a status flip that forgot `--write`
- **any task id or TODO number cited anywhere that resolves to nothing**
- **a code comment promising something a ✅ task will do** — either the promise
  was kept and the comment is stale, or it was dropped and nobody owns it

The last two are what make the tracking files load-bearing rather than
decorative. They are also the ones with tuning behind them — see
`references/reference.md`.

## What the gates structurally cannot catch

Three failures live in the gap between what a generated queue reads and what a
human wrote. None of them makes a validator red, because each produces a **legal**
state.

**A numeric priority field cannot see a dependency stated in prose.** Ranks are set
one task at a time, at filing, from what that task is worth on its own. The
*relationship* between two tasks gets written into the prose of whichever was filed
second — where no generator reads it. Found in one review: a task at rank 1300
whose own text said a positive result "supersedes `<other>` outright", while that
other task sat at rank **585**. An expensive build refactor was ordered ahead of
the cheap experiment that could have deleted it, for weeks, and nothing flagged it
because both ranks were individually defensible.

> Before trusting a queue's order, grep the task texts for
> `supersede|subsume|gated on|do after|blocks|instead of` and check each hit's rank
> against the rank of the task it names.

**An obligation must not move just because the task holding it moved.** One task
said to "re-measure before overriding anything" — then it was gated behind a
design task and re-ranked to 1300, parking the measurement that could invalidate
**eight** ranked tasks *behind* those eight tasks. Taking it cost one log read and
deferred two of them outright.

> Before re-ranking or deferring a task, grep its prose for
> `measure|re-measure|before overriding|report`. If it owns a number other tasks
> are priced on, take the measurement now or lift the obligation onto a task that
> stays near the head.

This is the same blind spot in the other direction: the first is a *dependency* the
queue cannot read, the second is *evidence*.

**A scripted status edit matched on a task id rewrites every line that cites it.**
Task lines cite each other constantly — `**Needs:**` fields and prose both name ids
— and those lines also end in a status marker. A per-line edit keyed on the id
(`perl -i -pe 's/— ⬜$/— 🟨/ if /<id>/'`) silently flipped **five other
tasks** from todo to in-progress. The id is not a line identifier; the only thing
unique to a task's own line is that it **starts** with it.

> Anchor any scripted tracking edit on the line start — ``^- \[[ x]\] `<id>` `` —
> then run `git diff --numstat` and require exactly `1 1`.

A validator cannot catch this one either: a citing task flipped to in-progress is a
legal state, so the wrong statuses pass validation and reach the rollup.

*Related:* the `proof-and-verification` skill for the general form — a relation
between two written things lives in the text of whichever was written second, where
no generator, no grep-by-topic and no go-to-definition will find it.

## Config

`tracking.config.json`, all keys optional:

| Key | Default | Notes |
|---|---|---|
| `dir` | `plans/tracking` | |
| `idPrefix` | `F` | |
| `defaultOwner` | git `user.name` | used by `--new-task` |
| `commitTrailer` | `Task` | |
| `strict.owner` / `strict.rank` | init writes `true` | `false` = advisory |
| `spec.requiredSections` | `[]` | `[4,5,6]` makes `MASTER.md` report §-coverage |
| `citations.source` / `.docs` | see file | missing paths skipped silently |
| `citations.sourceExclude` | `[]` | immutable dirs, e.g. DB migrations |
| `citations.docsExclude` | the tracking README | **keep it** — that doc specifies the id grammar, so its examples are fictional ids |
| `citations.deadRefs` | `{}` | numbers burned on purpose, with the reason |

A burned number — allocated, never used — goes in `deadRefs` rather than being
reissued. A number pointing at work someone invented later is worse than a gap;
the gap is honest about what was lost.

## Changing the skill

```bash
node $SKILL/scripts/selftest.mjs   # --keep to inspect the scratch repo
```

29 checks against a throwaway scaffolded repo: the commit gates, every
structural rule, the citation and promise checks, `--new-task`, `--renumber`
order-preservation, and `--json`. Run it after touching
`validate-tracking.mjs`, `init.mjs`, or any template.

Four of them assert a rule does **not** fire — a promise about an *open* task, a
matching verb 43 characters from an id, and both dry runs writing nothing. That
half is the half that decays silently: a rule that stops catching anything still
looks green, and only a false-positive test notices when a heuristic has been
widened into uselessness.

The suite is itself mutation-tested. Breaking the duplicate-TODO claim, widening
the promise window, or making `--renumber` non-monotone each turns exactly one
check red. Worth knowing if you edit it: the README exemption is deliberately
redundant — `init.mjs` writes `docsExclude` into the config *and* the validator
defaults it — so removing either alone is invisible, and there is a check per
path.
