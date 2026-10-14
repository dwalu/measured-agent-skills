# Port forwarding from a runner VM to the host

Split out of `self-hosted-ci-runners` ("The fact that bites outside CI") to
keep the skill body under the 500-line guidance. **Read this when** a local
tool is talking to something that is not yours, when a host port is held by
the VM tool's own process, or before turning forwarding off on a runner.

## How wide it is

With no rule, Lima forwards every port a guest process listens on, on
`127.0.0.1`. Other VM tools' user-mode networking does the same or something
similar. One runner's host-agent log, counted after a few weeks of use, held
"Forwarding TCP" events for Postgres, Redis, both mail-catcher ports, three app
ports, two worker ports, a screenshot suite's app port, and about 120
short-lived high ports nobody chose. Each of those shadows, or can, whatever on
the host listens there, because `127.0.0.1` beats a container published on
`*:<port>` for anything that dials IPv4 loopback.

Measured consequences, each once:
- a local screenshot run whose browser started rendering the CI job's app
  halfway through, signed out, so the whole run's pictures had to be discarded;
- a "free this port" helper that killed the forwarding process and so stopped
  the VM mid-job;
- a reset script one matching password away from running `DROP DATABASE`
  inside the runner.

## The probe

Start a listener inside the guest on `127.0.0.1` and one on `0.0.0.0`, wait a
few seconds for the host agent's poll, and ask the host who holds those ports:

```bash
limactl shell <vm> -- bash -s <<'EOF'
nohup python3 -c '
import socket, time
for host, port in (("127.0.0.1", 39123), ("0.0.0.0", 39124)):
    s = socket.socket(); s.bind((host, port)); s.listen(); globals()[str(port)] = s
time.sleep(25)' >/dev/null 2>&1 &
EOF
sleep 12
lsof -nP -iTCP:39123 -iTCP:39124 -sTCP:LISTEN   # limactl here = forwarded
```

Run it **before** changing anything. A probe that has never seen a forward
cannot tell fixed from broken. Check the host ports are free first, or the
answer belongs to someone else.

After the fix the host agent logs `TCP (except for SSH) and UDP port
forwarding is disabled`, and holds only its SSH ports:

```bash
lsof -nP -iTCP -sTCP:LISTEN -a -c limactl   # only 127.0.0.1:<ssh> ports
```

## Applying it

Edit the instance's `lima.yaml` and restart the VM. Do one VM at a time, after
its runner reports idle, so the other lane keeps taking work. Back up the
config first, and restore it and restart if the VM fails to start or the probe
still sees a forward. A lane should never be left down on a bad config.

Measured on Lima 2.2.1 (macOS host, VZ driver, two Ubuntu 24.04 runner VMs),
2026-10-14: both probes forwarded before the change and neither after, and
both runners came back online without re-registering.

## Why moving local ports is not a substitute

Giving local services ports CI does not use reaches only the ports you choose,
not the standard service ports (database, cache, mail) both sides use, and not
the short-lived ones. It is also not stable: in the measured case CI already
used the port local runs had moved to for safety. With forwarding off, local
and CI may share ports freely.
