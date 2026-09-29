---
name: pg-dump-and-restore
description: What a pg_dump archive actually guarantees and how a restore fails while reporting success — TABLE DATA ordered alphabetically rather than by dependency, so which tables survive a data-only restore is an accident of naming; the empty search_path a restore runs under, which breaks unqualified calls inside plpgsql triggers; --clean emitting DROP without CASCADE, so one dependent object leaves the old schema live and the archive's COPY refused; the two ways object ownership is silently lost; and what the exit status and "errors ignored" count do and do not tell you. Use when a restore drill passes but restores nothing, when a data-only load fails on foreign keys, when a function goes missing mid-restore, when a restored database has the wrong owner, or before trusting a backup you have not actually restored into a populated schema.
---

# pg_dump and pg_restore: what the archive guarantees, and how a restore lies

Measured with **pg_dump/pg_restore 16.14** against **PostgreSQL 16.14**.

**The client version matters as much as the server** for nearly everything here —
the archive format, the TOC layout, the `search_path` preamble, what `--clean`
emits and the exit-status behaviour are all properties of `pg_dump`/`pg_restore`,
not of the server. Record both when you record a measurement.

**The one thing to take away:** a restore reports success far more readily than it
achieves it, and every failure mode below was found only by restoring into a
**populated, realistic** schema. A drill against an empty database exercises none
of them.

---

## 1. What a custom-format archive is, and what its TOC orders

`pg_restore --file=-` prints the script the archive will actually run. Read it
before believing anything about what a restore will do.

**`TABLE DATA` entries are ordered alphabetically by table name, not by
dependency.** The post-data pass — constraints, indexes, triggers — runs after the
data, which is what lets a *full* restore into an *empty* database succeed despite
that ordering. But a `--data-only` restore, or a full archive into an
already-populated schema, runs with constraints live, so **a table loads only if
its parents happen to sort before it.**

Illustration, on one 49-table schema: `courses` is TOC entry 11, `tenants` is 43,
`terms` is 44. `terms` loads and keeps its rows; `courses` fails its foreign key to
`tenants` **32 entries early**; tables with no tenant reference load
unconditionally. **19 of 49 tables failed, all on foreign keys.**

The consequence is the part worth remembering: **the surviving set is not a
property anyone chose and cannot be read off the schema.** It changes whenever a
table is added or renamed. So *"a data-only restore mostly fails, so the damage is
bounded"* is not a safety argument — it is an accident of alphabetical order.

*Cross-reference:* `postgres-behaviour` §1 — `COPY` fires `BEFORE INSERT … FOR
EACH ROW` triggers, so the tables that *do* load are exactly the ones whose
triggers then rewrite the data being restored. A full restore escapes this only
because triggers are created in the post-data pass.

---

## 2. The restore runs with an empty `search_path`

`pg_dump` emits `SELECT pg_catalog.set_config('search_path', '', false)` and
`pg_restore` runs under it. **A `plpgsql` function that calls another function
unqualified therefore fails to resolve during the restore**, because a plpgsql body
resolves names at execution, not at definition:

```
ERROR: function app_allow_backdated_created_at() does not exist
```

— raised from a `BEFORE ROW` trigger the `COPY` statement never mentions. On one
50-table schema a `--data-only` restore failed **22 of 50 tables** this way.

**Reproduce it without a restore at all:** `SET LOCAL search_path=''`, then an
ordinary `INSERT` into a covered table. (And an `UPDATE` too, if the `ELSE` branch
also calls out.) That is the cheapest proof available and it needs no archive.

**Qualify the call sites; do not add `SET search_path` to the function.** Both fix
it, so it settles on cost — and a `SET` clause is a GUC save/restore on *every
call* of a per-row trigger. Measured, 50k-row inserts, µs/row on one machine:

| variant | µs/row |
|---|---|
| no trigger | 0.666 |
| trigger, bare unqualified calls | 1.567 |
| call sites qualified | 1.511 |
| fully qualified incl. `pg_catalog.clock_timestamp()` | 1.544 |
| `SET search_path` on the 2 trigger functions | 1.807 |
| `SET search_path` on all 5 functions in the chain | 2.805 |

Absolute numbers are one machine; the **ranking** is the portable finding:
qualification is free, pinning the whole chain nearly doubles the trigger's own
overhead. Pin only for the reason `SECURITY DEFINER` needs it — hijacking — which
never applies to a `SECURITY INVOKER` trigger function.

**Qualify `pg_catalog.` too, not just your own schema.** With
`search_path = 'evil, pg_catalog, public'`, an `evil.clock_timestamp()` makes the
trigger write a forged timestamp, silently. Qualifying only the app helpers leaves
that open; full qualification closes it, and so does a `SET` clause.

**Two traps when proving the fix.** `CREATE OR REPLACE FUNCTION` with no `SET`
clause **does** clear `proconfig` back to `NULL`, so a test that reads `proconfig`
back is vacuous under the qualification fix — it stays `NULL` either way. Assert
the **bodies** via `pg_get_functiondef` instead (no bare `app_`, no bare
`clock_timestamp(`). And the restore log carries
`CONTEXT: PL/pgSQL function public.<fn>() line N at IF` plus the table and the
offending row — it is typically the *driver* that drops the `CONTEXT` and leaves
you with the bare `ERROR:` line.

*Cross-reference:* `postgres-behaviour` §7 for why `SET search_path = ''` is the
correct zero-schema form (and how the quoted-list form silently is not).

---

## 3. `--clean` drops without `CASCADE`

`pg_restore --clean --if-exists --no-owner` into a populated database looks like
the safe way to restore over existing data. It is not.

**`--clean` emits `DROP TABLE` with no `CASCADE`.** Put a single dependent object
on the table — a view, an FK from a table the dump predates, anything an operator
added by hand — and the drop **fails, and the restore continues anyway**. What
happens next depends on the schema, and the difference is *only* whether the table
is `FORCE`d for row-level security:

**Not FORCEd** (measured on a minimal table): rows are **duplicated** — the old
ones were never removed and the archive's were added; the **primary key is gone**,
because it was dropped with the post-data pass and could not be recreated over
duplicate keys; and the **old trigger is still live**. All from one command,
reported only as `errors ignored on restore: 3`.

**FORCEd** (re-measured on a migrated 50-table schema — different, and worse): the
primary key *survives* the failed `DROP` and refuses the duplicate insert, so rows
are **not** duplicated. But the table keeps its `FORCE ROW LEVEL SECURITY`, the
restoring role is `NOBYPASSRLS`, and so the archive's `COPY` is **refused
outright**. The restore restores *nothing* while the bad data survives intact.
**42 of 50 ignored errors** were `query would be affected by row-level security
policy`.

**Spelling trap, and it is load-bearing:** Postgres writes **`row-level`**, with
the hyphen. An assertion grepping for the unhyphenated spelling matches nothing
while every one of those errors is exactly it.

Two rules follow. **When a drill exercises `--clean`, give the target a dependent
object**, or it only ever tests the easy case. And **which failure you get depends
on your fixture, so measure on the real schema** — the minimal-table outcome above
is not wrong, it is just a different schema's answer.

*Cross-reference:* `postgres-behaviour` §4 — the same
`query would be affected by row-level security policy` string is also what
`row_security = off` raises, so the message alone does not identify the cause.

---

## 4. Ownership is lost two different ways, and both report success

Once an object's **owner** carries a privilege — a `SECURITY DEFINER` function
owned by a `BYPASSRLS` role — the ownership is load-bearing, and a restore drops it
two ways:

1. **`--no-owner` drops every `ALTER … OWNER TO`.** 87 of them in one current dump,
   with no error and no warning.
2. **Without `--no-owner`, the statement can still fail.** The dump carries the
   function's `ALTER … OWNER TO` in the function's own TOC entry, and the schema's
   ACL in a **separate entry replayed last**. So restoring into a database where
   the new owner lacks `CREATE` on the schema fails that one statement, ignores the
   error by default, and leaves the object owned by the restoring role.

The symptom is a restored database that reported success and whose logins are
dead — a definer function returning NULL for every lookup.

**Grant the new owner `CREATE` on the schema permanently, in provisioning, not
temporarily in the migration.** The tempting version — grant, `ALTER OWNER`,
revoke — leaves the migrate path working and the restore path broken, and only the
migrate path has a test. **Provisioning runs before a restore, which is what makes
it the right home.**

Assert it afterwards:

```sql
SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE proname = '…';
```

`--clean` is orthogonal to this — all four cells of the `--clean` × `--no-owner`
cross-product were measured. And **a superuser restore hides all of it**, which is
the usual shape of a drill.

*Cross-reference:* `postgres-behaviour` §3 for why the ownership carries the
privilege in the first place, and the `must be able to SET ROLE` error that makes
the fix a provisioning change; §5 for the CI trap that a superuser drill makes
every one of these work.

---

## 5. Exit status and the "errors ignored" count

**`pg_restore` exits non-zero whenever it ignored anything.** Verified 16.14:

| case | result |
|---|---|
| full archive into a **populated** database, no `--clean` | `errors ignored on restore: 3`, **exit 1** |
| the same with `--exit-on-error` | aborts at the **first** error, **exit 1** |
| full archive into an **empty** database | no errors, **exit 0** |

**`--exit-on-error` controls abort-versus-continue, not the exit status.** So the
status is unconditional and **unranked**: identical for three benign
`already exists` notices and for a destroyed primary key. That is exactly what
teaches an operator to ignore it.

*Older notes claiming a restore that ignored errors exits 0 predate this
measurement — they are wrong.* Do not carry that forward; if a restore ignored
anything, expect exit 1.

The `N` in `errors ignored on restore: N` is fixture-specific (3, 42, 50 in the
cases above) and is a count of *ignored statements*, not a severity.

**None of this is a success signal, and neither is the archive's size.** A dump
taken with `--enable-row-security` against a non-superuser owner produces a
plausible byte count — the schema still dumps — and restores cleanly to an empty
database while carrying almost no rows (`postgres-behaviour` §4).

*Cross-reference:* `proof-and-verification` for what to assert instead — never the
exit status, never a row value read *before* the restore was supposed to change it,
and specifically: assert that a value the restore was meant to **change back**
actually changed; assert on the schema it was meant to rebuild (`pg_constraint` for
the primary key, `pg_trigger` for the triggers, a row count for duplication); and
make sure the assertion's spelling can match at all.

## Related

- `postgres-behaviour` — `COPY` and BEFORE ROW triggers, `DISABLE TRIGGER USER`
  versus `ALL` and why `--disable-triggers` is not by itself a working data-only
  restore, `row_security` raise-versus-filter, the privileges a non-superuser owner
  does and does not have, and `SET search_path` forms.
- `proof-and-verification` — fixture realism (an empty target proves nothing; give
  a `--clean` drill a dependent object), assertions that cannot match, and why a
  restore drill is the canonical vacuous green.
