---
name: ci-merge-gates
description: Decide what may become a required status check on a protected branch, and add one without freezing the repo — the skipped-versus-absent mechanism, the merge-then-require-then-read-back ordering, what a "green" run does and does not prove, and why a concurrency group can silently cancel the job you cared about. Use when a pull request is blocked by a check that never reports, when a required check is stuck `Expected — Waiting for status`, when renaming or path-filtering a CI job, when a job's failure looks like weather rather than the diff, when a merge went in on a run that was actually red, or when promoting an advisory job to required.
---

# Required checks and what green means

Branch protection is the one CI setting that can lock a repository against
everybody including you, and the two mistakes that do it are both mechanical
rather than a matter of judgement. This is those mechanics, plus what a green
run is actually evidence of.

## Skipped counts as passing. Absent blocks forever.

The single most useful fact, and the one that decides how you write a
conditional job:

| The job… | GitHub records | A required context is |
|---|---|---|
| runs and passes | `success` | satisfied |
| is skipped by a job-level `if:` | `skipped` | **satisfied** |
| is skipped because a **path filter** excluded it | *nothing at all* | **never satisfied — the PR is blocked forever** |
| is renamed | reports under the new name | never satisfied under the old one |

So a job that must not run on every pull request has exactly one safe shape:
**let the job start, and gate it with a job-level `if:`.**

```yaml
jobs:
  changes:                       # always runs; cheap; computes the filters
    outputs:
      code: ${{ steps.filter.outputs.code }}

  heavy:
    needs: changes
    if: needs.changes.outputs.code == 'true'    # SAFE — reports `skipped`
    # on:  paths: ['src/**']                    # UNSAFE — reports nothing
```

A documentation-only pull request then reports `heavy: skipped`, which counts as
passing, and merges. Using `on.paths` for the same job blocks that pull request
permanently, and the failure looks like a stuck check rather than a
configuration error.

**Never rename a job that is a required context.** Required checks are matched
**by name** — including the exact spacing of a name like `lint · typecheck ·
test`. A renamed job reports under a name nothing requires, while the required
one never reports at all. `runs-on` is safe to change precisely because it is
not part of a check's identity; the display name is not.

## Adding a required check: merge, then require, then read back

**In that order, and the order is the whole point.** A required context that no
run has ever produced blocks every open pull request the moment you add it —
including the one that introduces the job. So:

1. **Merge the job first**, while it is still advisory. Let it run on the
   default branch at least once and confirm it does what you think.
2. **Then add it to the required set.**
3. **Then read the protection back from the API** and confirm the list is what
   you meant. Do not trust the write's return value or the settings page.

```bash
# read (the source of truth)
gh api repos/OWNER/REPO/branches/main/protection \
  --jq '.required_status_checks.contexts'

# write — send the WHOLE list; this replaces, it does not append
gh api -X PATCH repos/OWNER/REPO/branches/main/protection/required_status_checks \
  -f 'contexts[]=changes' -f 'contexts[]=lint' -f 'contexts[]=e2e' ...
```

That write **replaces** the context list. Read first, add to what you read, send
the union — otherwise adding one check silently drops the others, and nothing
tells you.

**Before promoting a job, ask what it depends on that you don't control.** A job
that downloads anything unretried is a job that converts bad weather into a
repo-wide merge freeze, especially with `enforce_admins` on and no bypass route.
*Adding a required check is also adding every network dependency that check
has* — including the ones you added to the job last week for a test fixture. If
you cannot retry it, do not require it yet.

The honest reversal test is worth writing down when you decline: *name the
condition under which this becomes required.* One repo left an image job
advisory for exactly one reason — an unretried upload on the merge path — and
required it two weeks later, in the increment that moved the upload off the
merge path. The decision was cheap to revisit because the condition had been
written down rather than the conclusion.

## What green does not prove

**`gh run watch --exit-status` has exited 0 on a run that failed.** Do not gate
a merge on the watcher's exit code. Ask for the conclusion:

```bash
gh run view <RUN_ID> --json status,conclusion -q '.status + " / " + .conclusion'
gh pr checks <PR> --json name,bucket -q '.[] | select(.bucket!="pass")'
```

**A green end-to-end job can contain a retried test.** Playwright and most
runners retry on CI and exit 0 when a test eventually passes, reporting `1
flaky`. A genuinely dropped async path is indistinguishable from a slow one in
the summary line.

```bash
gh run view <RUN_ID> --log --job <JOB_ID> | grep -icE 'flaky'
```

Do not "stabilise" a flake by raising its timeout before knowing whether it is a
slow test or a real defect. That fixes one and conceals the other.

**A "failed" job with no failing step is infrastructure, not your diff.** The
discriminator, which works on any provider that exposes per-step status:

> A real failure marks **exactly one step** `failure`. Infrastructure leaves
> every step past some point `null` — nothing failed, the run simply stopped
> being reported.

```bash
gh api repos/OWNER/REPO/actions/jobs/<JOB_ID> --jq '.steps[] | "\(.conclusion)\t\(.name)"'
```

Corroborate before rerunning: several jobs dying **simultaneously on different
machines** is not a diff. Neither is a job that fails having uploaded no logs.
Then rerun **once**; a second identical failure at the same step is no longer
weather and should be diagnosed as a real defect.

**A `SKIP` inside a passing script is the same trap one level down.** A suite
that reports `12 passed, 0 failed, 1 skipped` and exits 0 is green to every gate
above it. Watch what the skip predicate actually tests: a check that decides
"this platform is unsupported" by **running the tool under test** and treating a
non-zero exit as the answer turns *any bug in that tool* into a silent skip. One
`NameError` skipped the entire machine-asserting half of a suite on two runners
and reported green, twice. Skip on a fact about the **environment** the code
cannot influence (`uname`, a missing binary, an unset connection URL); if the
environment is right and the tool then fails, that is a FAIL, never a SKIP. And
print the counts — the skip was visible only because the line said `1 skipped`.

**A check that asserts the machine proves it about one machine.** Most checks are
about the diff, and the diff is the same everywhere. A check that asserts the
*runner* — disk, clock, daemon state — is different: a run's jobs spread across
lanes, which lane takes which is not stable, so one green run covers **the lane
that job landed on** and says nothing about the others. Two consecutive greens do
not fix that either. Pair it with something that runs on every job on every lane
— a runner job hook — and treat the required check as the thing that makes a
regression impossible to scroll past rather than the thing that finds it.

**Skipped is not the same as passed when you are the one reading it.** `skipped`
satisfying a required context is a feature for prose-only pull requests and a
trap when you are checking whether your change was exercised. Confirm the step
you care about actually ran:

```bash
gh api repos/OWNER/REPO/actions/jobs/<JOB_ID> --jq '.steps[] | select(.name|test("Publish")) | .conclusion'
```

## Concurrency groups eat the job you cared about

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

On a pull request this is correct — a superseded run is waste. On the **default
branch it is a bug**, and a subtle one. Any convention that pushes to the
default branch twice in quick succession — a feature merge followed minutes
later by a docs or tracking commit — puts both pushes in the same group, so the
second cancels the first. The job that gets cancelled is reliably the
**longest** one, because it is the only one still in flight. If that is your
publish, deploy, or release job, it silently stops happening and **nothing goes
red**.

One repo lost image publishing for weeks this way: the last successful publish
was three increments old, no check ever failed, and the pinned digest quietly
had no commit behind it.

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

Queue on the default branch; cancel everywhere else.

Two related traps once this is in place: two runs on the **same ref** now
*queue* rather than cancel, so if you are measuring parallelism you must use
different refs to measure anything at all. And a job whose whole purpose is
conditional on the branch should say so in an `if:`, not rely on being cancelled.

## A checklist for promoting a job to required

- [ ] The job runs on the default branch and has been green there at least once.
- [ ] Its name is final. Renaming it later blocks every open pull request.
- [ ] It is conditional via a job-level `if:`, never `on.paths`.
- [ ] Every network fetch it makes is retried, or it does not fetch.
- [ ] It has a `timeout-minutes` sized by arithmetic, not by guess — an
      unbounded job inherits the six-hour default and holds a runner all day.
- [ ] The path it guards is exercised by pull requests, not only by the rare
      event it exists for. A step that only runs when it matters is a step
      nobody has tested.
- [ ] If it asserts the **machine** rather than the diff, something else covers
      the lanes this run did not land on.
- [ ] The existing context list was read back and the write sent the union.
- [ ] The protection was read back **after** the write.

## Related

- **`self-hosted-ci-runners`** — the machine-versus-diff question in much more
  depth, including the lease-expiry tell, if your runners are your own.
- **`container-image-delivery`** — the publish job that most often ends up in
  this conversation, and why moving it off the merge path is what makes it
  requirable.
