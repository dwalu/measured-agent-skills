---
name: self-hosted-ci-runners
description: Run GitHub Actions on your own machines — the lane model and why a lane is a whole VM, how much capacity you actually have, and above all how to tell a machine problem from a bad diff before you read the diff. Use when CI stops picking up work, when a job is refused with zero steps or `runner_name` empty, when a job dies with `Abandoned` or fails at `actions/checkout` before any code runs, when several jobs fail at the same instant on different machines, when a job "fails" having produced no logs, when runs queue behind each other, when a pass depends on state a clean machine would not have, when the runners need maintaining from the inside (a disk that fills and kills jobs in setup, a guest clock that drifts or steps, a job hook that must be installed or verified), when a timing test fails only in CI or a timeout fires early, or when deciding whether self-hosting is worth it at all.
---

# Self-hosted CI runners

Self-hosting is usually adopted for cost and kept for **speed**: on a developer
machine with a warm dependency store, jobs start instantly and run faster than
a hosted runner. The real cost turns out not to be the machine — it is that
**you have now taken on a class of failure that looks exactly like a bug in your
code**, and that is what most of this skill is about.

## Is it worth it?

Reasonable when: the repo is **private** with few contributors; jobs are heavy
enough that hosted minutes bite; and dependency caches are large, because a
persistent store is most of the win.

Unreasonable the moment the repo is public or gains an untrusted contributor.
**A self-hosted runner executes whatever a pull request contains, on a machine
inside your network.** Tear them down at that moment — do not schedule a
re-evaluation. And keep the surface narrow: do not mount the host filesystem
into a runner VM (`limactl start --mount-none`, or the equivalent). A single
reintroduced `mounts: - location: "~"` gives every pull request read access to
your home directory, `~/.ssh` included.

## The lane model

A **lane** is one runner that can hold one job. Three facts follow, and they
explain most mistakes made with self-hosted CI.

**1. A lane should be a whole VM, not a second runner service on one host.**
Any job that declares `services:` publishes them on **fixed** host ports —
Postgres on 5432, Redis on 6379, a test server on its own port. Two such jobs on
one machine fail with `port is already allocated`. A VM per lane gives each its
own network namespace. Add capacity by **cloning a VM**, never by installing a
second runner inside an existing one; the alternative is rewriting every
workflow to use dynamic service ports.

**2. Service containers are a Linux-runner-only feature.** If a macOS or Windows
runner is also registered and can match your `runs-on` labels, the cheap jobs
pass and every job that touches a container fails with *"container operations
are only supported on Linux runners"*. `runs-on: [self-hosted, linux]` — the
label is load-bearing, not descriptive. Labels are AND-ed, and matched
case-insensitively.

**3. Jobs spread across lanes, and nothing pins which.** Consequences worth
knowing before you read a run:

- Per-job timings move 20–40% with contention. A job that got slower is **not**
  by itself evidence about your diff — check what shared the host
  (`runner_name` on the sibling jobs) first.
- **One lane silently offline halves capacity without failing anything.** The
  degraded state persists until a human notices a confusing red check.
- A job `queued` while every runner reports `busy=true` is a **queue, not a
  hang**.
- Adding a lane does nothing for a *single* run whose critical path is one long
  job. It only helps concurrent runs. Cutting the long job is the other lever.

### The fact that bites outside CI

**A running job publishes the guest's service ports on the host's loopback.**
While any job with a `services:` block runs, `127.0.0.1:5432` is the *runner's*
Postgres — not your development one. The symptom is a local tool failing
authentication, or finding an unrecognisable schema, while `docker exec … psql`
works perfectly; and it comes and goes with CI.

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN     # a VM process here means a job is running
```

On macOS `localhost` resolves to `::1` and reaches Docker, while `127.0.0.1` is
IPv4 and the VM gets there first. **Write `localhost`, never `127.0.0.1`, in
anything that talks to your local stack** — and derive URLs from config rather
than hardcoding a host. The dangerous outcome is not the auth failure; it is the
case where the credentials happen to match and your reset script runs `DROP
DATABASE` inside a CI runner.

## Is it the machine or my diff?

Work this before reading the diff. The order matters — each check is cheaper
than the one after it.

### The step-shape discriminator

> **A real failure marks exactly one step `failure`. Infrastructure leaves every
> step past some point `null`** — nothing failed; the run simply stopped being
> reported.

```bash
gh api repos/OWNER/REPO/actions/jobs/<JOB_ID> \
  --jq '{conclusion,runner_name,steps:[.steps[]|{n:.name,c:.conclusion}]}'
```

Two more shapes that are never a diff:

- **`runner_name: ""` with `steps: []` and a ~3s duration** — the job was never
  assigned. Cause is offline runners, changed labels, or a `runs-on` that no
  longer matches. `gh run view --log` returns `log not found` because nothing
  ran, so use the job API.
- **A job that "fails" having uploaded no logs**, especially at a round number
  of minutes.

### The corroborators

- **Several jobs dying at the same instant on different machines.** Independent
  machines do not fail together for a code reason.
- **A failure at `actions/checkout` or during `setup-node`**, before any of your
  code runs. Both lanes losing a run at a cache restore is a slow link, not your
  diff.
- **An independent poller logging a network error** (`net/http: TLS handshake
  timeout` against the API) within a minute of the failure — the same blip seen
  from the other side.

### The lease-expiry tell — arithmetic, not correlation

This is the strongest single piece of evidence, and it is exact.

A runner renews a lease on its job every few minutes and writes the new expiry
to its own diagnostic log. If the runner loses its connection, GitHub gives up
on the job **at the moment the lease expires** — so the failure timestamp equals
a number written in the log *before* the failure. That is arithmetic, not a
guess.

```bash
# the SECOND-newest Runner log is the one for the job that just died
ls -t ~/actions-runner/_diag/Runner_*.log | sed -n 2p | xargs tail -5
```

Look for a final line of the form:

```
[06:11:35Z … ] Successfully renew job <guid>, job is valid till 06:21:34
```

If your jobs are marked failed at **06:21:34** and the log ends there with no
error of its own, the runner stopped talking to GitHub at 06:11:35 and
everything after is bookkeeping. Nothing in the diff can produce that.

**A retry wrapper cannot outlive the lease it started under.** If a step stalls
long enough to need a retry, the stall itself may already have burned through the
job's server-side lease — so the next attempt starts ineligible and dies almost
immediately, and neither the diff, nor the retry count, nor the job's timeout
ceiling is involved. On one run a wrapper correctly logged *"failed on attempt 1 of
3; retrying in 30s"* and attempt 2 was killed **16 seconds in** with
`The operation was canceled`, with the job's timeout at 120 minutes and only 26
elapsed. Two cheap checks discriminate it, and neither is the `null`-steps one
above: the failing step reads **`cancelled`**, not `failure`; and the job's API
`completed_at` is **earlier** than the last timestamp in its own log — `10:20:32`
against a final log line at `10:35:52` — meaning the server had already given up
before the runner stopped producing lines. On that shape, do not read the diff and
do not raise the retry count: confirm the runners are online, then
`gh run rerun <id> --failed`.

### `Abandoned`, and why the usual liveness check misses it

The most expensive variant: a blip breaks the runner's long-poll session,
GitHub fails the in-flight job, and the runner keeps a **live process that
stops taking work**.

| Vantage point | What you see |
|---|---|
| Checks UI | one context `fail`, often at a round ~10m, no output |
| Job steps API | `cancelled`/`failure` mid-step, everything after it `null` |
| Runner journal | `Job <name> completed with result: Abandoned` — **then nothing at all** |
| `systemctl status` | `active (running)` — useless here |
| Runners API | `offline` — but it says that when nothing is wrong too |

So **`systemctl status` cannot detect this**, and neither can the API's `status`
field. Any watchdog you build must probe *whether work is actually accepted*,
not process state and not GitHub's status field.

A transient `Conflict. Retrying until reconnected.` for up to ~100 s right after a
clean restart is normal — the server is still expiring the dead instance's session.
A **permanent** conflict means something local is still alive, or another machine
shares the identity; measure before calling it wedged.

Recovery: restart the runner service on each affected lane, then
`gh run rerun <RUN_ID> --failed`. **Once, and once only** — a second identical
failure at the same step is a real defect, and rerunning a third time is how a
genuine break gets mistaken for flakiness. A clean retry with no code change is
the confirmation that the diff was never involved.

Three things worth checking on any runner you inherit. Whether the unit file has
`Restart=` at all — without it, a listener that *exits* leaves the lane down
indefinitely, and per the lane model that degrades silently. Whether anything at all
notices a lane going quiet.

And whether `KillMode=process` is set **alongside** `Restart=`, because the pair is
a trap that neither directive is on its own. `KillMode=process` signals only the
unit's main process, which is fine for a graceful `systemctl stop` — the main
process forwards the signal to its children. It breaks the moment `Restart=` is
added, because an *unclean* exit, the only case `Restart=` exists for, forwards
nothing: systemd restarts the unit while the old process tree keeps running in the
same cgroup, so you have **two complete stacks**, and the orphan usually holds
whatever exclusive resource the new instance needs — a session, a lock, a port. The
new instance then fails forever while `systemctl status` reports `active`. Run
`systemctl show <svc> -p Restart,KillMode` and read **both**; the fix is
`KillMode=mixed`, where SIGTERM still goes only to the main process but the cgroup
empties on stop.

## The health check, and why most of it is not evidence

```bash
gh api repos/OWNER/REPO/actions/runners \
  --jq '.runners[]|"\(.name) \(.status) busy=\(.busy) labels=[\([.labels[].name]|join(","))]"'
```

**`status` from this endpoint is a hint, not evidence.** It has reported every
runner `offline` across repeated checks while they were provably live — their
own diagnostic logs showing `Listening for Jobs`, the API reachable in half a
second from inside the VM, and a dispatched job picked up immediately. It lags
hardest right after a restart or a lost connection, which is exactly when you
are looking at it.

Two readings that **are** evidence:

```bash
# what the runner itself believes — the source of truth
sudo journalctl -u actions.runner.<OWNER>-<REPO>.<RUNNER_NAME> -n 20 --no-pager

# whether it will take work — the only conclusive probe
gh run rerun <RUN_ID> --failed && gh api repos/OWNER/REPO/actions/runs/<RUN_ID>/jobs \
  --jq '.jobs[]|select(.status!="completed")|"\(.name)\t\(.status)\trunner=\(.runner_name)"'
```

**Never restart a runner on the strength of an `offline` reading alone** — if it
is mid-job, the restart is what kills the job.

The service name embeds the runner name, so it differs per lane. Restarting the
wrong one is the easiest way to fix nothing.

## "The runner is persistent, so the cache is warm" is a claim about paths

Persistence buys you nothing for a cache that lives inside a directory a setup
action recreates. The specific case, because the shape recurs across package
managers: pnpm's default store is `$PNPM_HOME/store`, and under
`pnpm/action-setup@v4` that resolves *inside the directory the action reinstalls
itself into on every job* — so on a persistent runner the store is destroyed and
rebuilt from the network every job, and a `cache:` restore that looks redundant is
doing real work.

**Only the `--store-dir` flag relocates it.** Measured on pnpm 10.33.0,
`PNPM_STORE_DIR`, `PNPM_STORE_PATH`, `npm_config_store_dir` and
`NPM_CONFIG_STORE_DIR` all leave `pnpm store path` at the default. So an
`env:`-block version of the fix **passes CI and silently reverts the change** — the
guard has to assert the **argv** the install ran with, not that the install
succeeded. Point at a parent directory and let the tool append its own
store-format subdirectory, which differs across releases and platforms.

Two consequences worth holding together, because each is the other's precondition:
once the store really is outside anything an action recreates, a cache restore
becomes pure waste — one project measured **206 MB per job, about 1.03 GB per
code-touching run** being restored into a store that was then destroyed. Remove the
flag and both halves invert silently.

`.npmrc` is not the place either, when the repo is also a Docker build context:
`COPY . .` carries it into the image build, which then runs its own install.

**Diagnose persistence by reading a run as a lane timeline, not as a job list.**
One job per lane at a time, so a later job's cold cache disproves persistence
outright.

## Reading a green run on a persistent runner

**The machine is not clean, and `actions/checkout` does not make it clean.** It
cleans the tree; the dependency store, the work directory, installed packages
and stopped containers all persist. So a pass can depend on state a fresh
machine would not have — and a failure can be impossible to reproduce anywhere
else.

When a failure looks impossible, or a pass looks too easy, clear the workspace
and re-run before trusting either. **Each lane has its own work directory, and
which lane a job lands on is not stable**, so clear every lane or the next run
may reuse exactly the state you meant to discard.

**Measure capacity changes without pushing code.** `gh run rerun <RUN_ID>`
re-runs a *completed* run on the same tree, so timings are comparable against
that run's own previous numbers, cost nothing, and need no commit. Read results
from the jobs API — `runner_name` is the field that says which lane did the
work — never from the run summary. To measure *concurrency* the two runs must be
on **different refs**, or a concurrency group will queue or cancel one of them
and you will measure nothing.

## The guest clock is a lane property, and it can be wrong

A VM guest can end up running **two time managers at once** — the hypervisor's
guest agent syncing to the host, and an NTP daemon the guest image ships enabled.
They do not cooperate. Measured on one pair of runners: the NTP daemon polled
over the hypervisor's user-mode NAT, where the round trip is 315–386 ms and
**asymmetric**, derived a third of a second of offset from it, and drove the
guest clock **~2.2% fast**; the guest agent then stepped the clock back to the
host's every ~10 s — a backwards jump of a median **229 ms, ~356 times an hour**.

Two consequences, and the second is the one nobody predicts:

- **Any two wall-clock readings less than a step apart can come back out of
  order.** A pair _d_ apart straddles a step with probability ≈ _d_ / step
  interval. Tests that write a timestamp and then compare it to a later one fail
  intermittently, only in CI, with no diff to blame.
- **Every timeout fires early**, by the slew, because the monotonic clock carries
  the same adjustment. A 30 s test deadline expires at ~29.3 s of real time.
This is a **guest-versus-host** clock problem, not a **container-versus-runner**
one, and the two are easy to conflate when only one of them is real. A `services:`
container has no time namespace of its own — GitHub Actions does not configure one,
so it shares the runner's kernel `CLOCK_REALTIME` directly. Confirmed by reading
`clock_timestamp()` from a Postgres service container: three samples all landed
strictly inside the host's own before/after sampling window. So a millisecond-scale
timestamp-ordering `CHECK` failure in CI is **not** explained by "the runner and the
database are two different clocks" — that hypothesis is ruled out for any
`services:`-based database. Look instead at who actually writes each column (a
client-bound ORM default collapses two writers into one, leaving only a genuine
backwards step as an explanation — see `prisma-behaviour`) and at precision
mismatches between differently-scaled timestamp columns.

None of this applies to a local Docker Desktop VM on macOS, which *does* have its
own drifting clock relative to the Mac host — measured at ~70 ms ahead, with
container Postgres reading later than `date` on the host. That is a
development-machine problem, not a lane problem.

### Diagnosing it

```sh
# is more than one thing managing time?
systemctl is-active systemd-timesyncd chronyd ntpd
# what has the kernel been told to do about it?
python3 -c 'import ctypes;…'   # adjtimex: freq (ppm x 65536), offset, status
```

Then measure, because the state above tells you what is *configured*, not what is
*happening*:

- **`CLOCK_REALTIME − CLOCK_MONOTONIC` detects steps and not slew.** Both carry
  the same adjusted rate, so a frequency correction cancels in the difference and
  only a `settimeofday`-style step survives. Sample at 10–20 Hz for longer than
  the suspected step interval.
- **`CLOCK_MONOTONIC` against `CLOCK_MONOTONIC_RAW` measures the slew**, inside
  the guest, with no host round trip. RAW is the un-slewed hardware counter.

### Three traps, all of which cost time here

- **The number with a name is the wrong number.** `Frequency=32768000` in
  `timedatectl` is the kernel's 500 ppm maximum — **0.05%**, forty-four times too
  small to explain a 2.2% error, and *exactly* what remains after the fix. The
  term that moves the clock is `offset`, the phase correction, and the frequency
  ceiling does not bound it.
- **Stopping the daemon is half the repair.** The kernel keeps the last frequency
  correction and a pending phase offset that drains over about a minute. Measured
  immediately after the stop, a working repair still shows the symptom. Zero both
  explicitly and wait for the drain before measuring anything.
  Zeroing means an explicit `adjtimex` call with
  `ADJ_FREQUENCY | ADJ_OFFSET | ADJ_STATUS`, clearing `STA_PLL` — a plain service
  stop never issues it. Watch the units change under you while you do: `offset`
  reads in **nanoseconds** while `STA_NANO` is set and in **microseconds** once the
  PLL is cleared, so the same underlying value prints as `163405418` and then
  `163405` with nothing having actually happened — do not mistake that jump for the
  drain completing.
- **Disabling may not survive a boot.** Check the hypervisor's own provisioning
  and boot scripts for who starts the unit — one of them started the NTP daemon on
  every boot and waited for it to synchronise, so `disable` alone silently
  reverted on the next restart, and `mask` would have failed the boot for a guest
  that genuinely needed it. Read the script's guard condition before choosing
  between them.

### Keep it fixed

Two detectors, and neither substitutes for the other. A **job-started hook** can
read the causes instantly — is a second daemon running, is the kernel at its slew
ceiling — and re-apply the fix on **every job on every lane**; it should not fail
the job, because a stepping clock makes results *probabilistically* wrong and
blocking all of CI over it costs more than the defect. A **required check** that
samples for longer than the step interval is what actually goes red, and it only
asserts the lane that job landed on.

## Maintaining the fleet from inside the runner

A persistent machine accrues state that no workflow step can reliably fix, and
the reason is structural: **the worst failures happen before your steps run.** A
disk that fills kills the job in `Set up job`, while the runner is writing its
own diagnostic log — no test output, no diff, and an `if: always()` cleanup step
that never fires precisely when it was needed. A clock that drifts corrupts
results your steps produce without failing anything at all.

So fleet maintenance belongs **on the runner, not in the workflow**.

### Job hooks beat a timer

Self-hosted runners run a script of your choosing before and after every job:

```
ACTIONS_RUNNER_HOOK_JOB_STARTED=<runner>/hooks/preflight.sh
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=<runner>/hooks/cleanup.sh
```

They are configured on the machine, so they are outside the workflow and survive
a job that dies in setup. The reflex alternative is a `systemd` timer, and the
hook is better for a reason that is easy to miss: **a runner executes one job at
a time**, so the completed hook runs when nothing on that machine is building.
A timer does not know that, and an unattended prune firing mid-build can evict a
base image or a cache layer out from under it. The hook *removes* that race
rather than guarding against it, and it fires exactly when the garbage is made.
The started hook is the only place a repair can rescue a job that would
otherwise die before its first step.

### Make the destructive half safe by construction

Whatever the hook prunes, prefer flags whose semantics are already narrow over an
allowlist you have to maintain — dangling-only images, anonymous-only volumes.
Then a base image or a named volume holding real data survives *unnamed*, which
is what you want on a machine where re-pulling costs minutes. Show both
directions in a test: widening the flag must redden it.

### Verifying a hook is live — usually only one check works

**Do not look for the variables in the runner's process environment.** The
listener reads its `.env` itself and applies it in-process, which never rewrites
`/proc/<pid>/environ`; the generated service unit has no `EnvironmentFile`.
Grepping the environment therefore returns zero for a **working** install — a
check with no passing state, which will send you rewriting an installer that was
fine. (The general form: when a program loads its own config at runtime, there is
no environment to grep. Assert the configured *behaviour*.)

The one assertion that can fail for the right reason is a **real job's log**. So:

- **Make every hook print on the healthy path, not only on failure.** A guard
  that is silent when it passes leaves no evidence it ran at all, and the job log
  is the only evidence available.
- Include a number that varies — free space, a measured drift — because two jobs
  printing *distinct* figures is how you know you covered two lanes rather than
  one lane twice.

### Two things that will waste an afternoon

- **The installer's own instructions are part of the installer.** A service
  wrapper that refuses unless invoked *from* the runner root (`Must run from
  runner root or install is corrupt`) fails silently when its output is
  redirected — so an installer can report success having restarted nothing.
- **The installed copy drifts from the repo copy.** CI tests the repo copy; a
  runner nobody re-installed is running untested code. Stamp the commit into each
  installed file and print it, so drift is diagnosable rather than suspected.

## Building a lane

Prefer **cloning a healthy VM** to rebuilding. Rebuild only when there is no
healthy one left. The shape, whatever your VM tool:

1. A Linux VM, 4 vCPU / 6–8 GiB, no host mounts, a fixed disk large enough for
   image builds and a dependency store.
2. **Docker Engine inside the VM** — not a desktop daemon on the host. Service
   containers must be reachable on the runner's own loopback.
3. Register the runner with the labels your workflows match, install it as a
   service, start it. Registration tokens expire in about an hour, so fetch one
   immediately before use:
   ```bash
   gh api -X POST repos/OWNER/REPO/actions/runners/registration-token --jq .token
   ```
4. Set the VM to autostart on host reboot.
5. **Leave exactly one thing managing the clock** — see the section above. A
   stock cloud image ships an NTP daemon enabled, and the hypervisor's guest
   agent is usually the better one to keep.

Nothing else needs provisioning by hand — toolchain setup actions, browser
installs and `apt-get` in jobs all work, given passwordless sudo.

**Architecture is a real decision.** A hosted `ubuntu-latest` is x86-64; an
Apple-silicon VM is aarch64. Common service images publish both, but language
runtimes, native database engines and browser builds will be arm64. That is
usually fine and occasionally not; the knob is building the VM x86-64 instead,
at a large emulation cost.

## Related

- **`ci-merge-gates`** — what a green run proves, and how to require a check
  without freezing the repo. The `null`-steps discriminator appears there too,
  because it is needed before you know whose fault a red check is.
- **`container-image-delivery`** — if these runners are also your publish path,
  their uplink is probably the binding constraint.
