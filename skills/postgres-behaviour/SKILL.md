---
name: postgres-behaviour
description: Postgres behaviour that costs a day when you assume it — the order defaults, BEFORE triggers and CHECK constraints actually run in; which ADD COLUMN rewrites the table; who row-level security applies to and who silently bypasses it; why an RLS failure is an empty result rather than an error; the privileges a non-superuser owner does and does not have for bulk loads and restores; when a WHERE clause is not a guard; and the psql/GUC mechanics that rewrite your SQL before the server sees it. Use when a migration's backfill updated zero rows, when a trigger overwrote a value a caller supplied, when a constraint became unsatisfiable, when ADD COLUMN took a table lock you did not expect, when a query returns nothing under one role and everything under another, when SECURITY DEFINER returns NULL, when pg_restore or a data-only load fails on privileges, when an ORDER BY is right under one plan and reversed under another, or when a psql variable does not interpolate.
---

# Postgres behaviour worth knowing before you assume it

Every fact here was measured against a running server, mostly Postgres 16, and
each one has cost real time at least once. Versions are stated where the
behaviour depends on them.

**The single most expensive theme: under `FORCE ROW LEVEL SECURITY` a
non-superuser table owner is subject to its own policies, and the failure mode is
a silent empty result rather than an error.** Development and CI usually own the
database as a superuser, where none of §3 or §4 is reachable — so these are the
bugs that only appear once the deployment's real roles exist.

## 1. The write path: defaults, then BEFORE triggers, then CHECK

Postgres builds the tuple — applying column defaults — **before** any `BEFORE ROW`
trigger runs. Inside the trigger, `NEW.<col>` carries **no evidence of who put it
there**: a value the caller sent and a value the default supplied are
indistinguishable.

**The one exception is an explicit `NULL`,** and it is load-bearing. `INSERT …
(col) VALUES (NULL)` skips the default and reaches the trigger with
`NEW.col IS NULL`, even on a `NOT NULL DEFAULT` column. So a trigger that assigns
the column unconditionally has been acting as a **NOT NULL rescue** — add an
opt-in and the same insert now fails the constraint.

Consequence: a trigger cannot implement *keep the value if the caller meant it*.
The only expressible rule is **the caller owns this column for this transaction**
(a transaction-local GUC on the branch that needs it).

**CHECK constraints are evaluated against the row the trigger returned**, not the
row the caller sent. A trigger assigning a column unconditionally can therefore
make a constraint on that column unsatisfiable — including the usual
"rows that predate this migration are exempt" shape:

```sql
CHECK (e164 IS NOT NULL OR created_at < TIMESTAMP '<migration time>')
```

Attach a timestamp-assigning trigger and the exempt branch is unreachable for
every new row. No warning; the migration applies.

**`COPY` is not a bulk bypass** — it fires `BEFORE INSERT … FOR EACH ROW` like any
insert. A restore that loads rows into a schema whose triggers already exist
stamps every restored row with restore time. A full `pg_dump --format=custom`
restore escapes this only because `pg_restore` creates triggers *after* the data
load — an ordering property of the archive, not a guarantee anyone wrote down. It
breaks silently under a `--data-only` restore into a live schema, or a row-by-row
import built on an NDJSON export.

**Clocks:** an insert that *omits* the column keeps the DEFAULT, and
`CURRENT_TIMESTAMP` is **transaction start** — so every row written in one
transaction ties (see §6, where that tie becomes a wrong answer). An ORM binding
defaults client-side writes the *application host's* clock instead. If a trigger
is going to set the column anyway, give it **no default at all**.

Before attaching a column-assigning trigger, grep the migrations for CHECK
constraints naming that column, and for existing writers that pass it a derived
value.

**A sequence gives you assignment order, not commit order.** Sequences are
non-transactional: the transaction holding `seq = 5` can commit *after* the one
holding `seq = 6`, and a rollback leaves a permanent gap. So a `bigserial` is a
stable total order at **read** time but not at **write** time — "the previous row"
is unknowable at INSERT unless every writer serialises through one lock, which is
usually a worse cure than the disease. If you need write-time ordering, that is a
design constraint to solve, not a column to add.

## 2. DDL versus DML: rewrites, generated columns, transactional DDL

**Which `ADD COLUMN` rewrites the table** — measured on PG16 with
`pg_relation_filenode()` before and after, which is the whole test:

| DDL | filenode | rewrite |
|---|---|---|
| `ADD COLUMN … timestamp(6)` (nullable, no default) | unchanged | no |
| `ADD COLUMN … uuid` (nullable, no default) | unchanged | no |
| `ADD COLUMN … NOT NULL DEFAULT now()` | unchanged | **no** |
| `ADD COLUMN … NOT NULL DEFAULT clock_timestamp()` | **changed** | **yes** |

Since **PG11** a non-volatile default is evaluated once and stored as the column's
"missing value", so existing rows are never touched. `now()` is STABLE and gets
that treatment; `clock_timestamp()` is VOLATILE and must be evaluated per row,
which means writing every row. The two obvious server-clock defaults are **not
interchangeable**, and the difference is a full rewrite on a live table.

**DDL is not subject to RLS; DML is.** Measured with a
`NOSUPERUSER NOBYPASSRLS` owner on a FORCEd table:

| as the owner | result |
|---|---|
| `ALTER TABLE … ADD COLUMN seq bigserial` | succeeds, **fills existing rows in insertion order** |
| `SELECT …` with no tenant GUC set | **0 rows** |
| `UPDATE … SET seq = …` | **`UPDATE 0`** — silent, no error |

So the expand half of a migration works and any corrective pass over the same rows
does nothing. A migration has no tenant GUC set, so a row-counting `DO`-block
guard counts zero and **passes for the wrong reason**.

**Make the backfill itself DDL** when the value comes from another column on the
same row and the migrating role cannot SELECT the table:

```sql
ALTER TABLE t ADD COLUMN c <type> GENERATED ALWAYS AS ("source") STORED;
ALTER TABLE t ALTER COLUMN c DROP EXPRESSION;   -- PG13+
ALTER TABLE t ALTER COLUMN c SET NOT NULL;
```

A generated expression reads every row regardless of row security; `DEFAULT`
cannot (it is a constant) and `UPDATE` is filtered. `DROP EXPRESSION` keeps the
computed values and leaves an ordinary column — `is_generated = NEVER`, no
`column_default` — so a trigger owns it from the next write and no census can tell
it apart. **Assert `pg_attribute.attgenerated = ''` in the migration:** a column
left GENERATED rejects every trigger write, and `SET NOT NULL` passes either way.

The genuine-backfill route also works: `ALTER TABLE t NO FORCE ROW LEVEL
SECURITY` → `UPDATE` → `FORCE` again, and it restores cleanly. Either way make
the following `ALTER COLUMN … SET NOT NULL` the assertion — against an
un-backfilled table it fails with `contains null values`, which a vacuous row
count cannot fake.

**`CREATE TRIGGER` is transactional**, like most Postgres DDL. To test a
`TG_TABLE_NAME` branch you can attach the function to the **real** table inside a
`BEGIN`, insert, assert, and `ROLLBACK` — `pg_trigger` goes back to zero. A
throwaway probe table cannot test that branch at all: the probe is not called what
the guard looks for, and the real name is taken. Caveat: the transaction holds an
`ACCESS EXCLUSIVE` lock on the real table for its duration — fine in one
self-contained test, wrong in a shared fixture.

**A generated column's expression must be IMMUTABLE, and `concat_ws` is not.**
Postgres marks `concat_ws`, `concat` and `format` **STABLE**, so a generated column
rejects all three. Build the expression from `||`, `coalesce`, `nullif` and `btrim`,
which are immutable.

**PG16 cannot convert a column to generated in place** — there is no
`ALTER COLUMN … SET GENERATED` for stored columns, so it is `DROP COLUMN` +
`ADD COLUMN … GENERATED`. Lossless for a genuinely derived value, but it moves the
column to the end of the table and silently *corrects* any row whose stored value
had drifted — which may be the evidence you were about to investigate.

**A rename carries dependent objects by OID, not by name.** `ALTER TABLE … RENAME`
preserves everything that depends on the table, but leaves the *names* of
constraints, indexes and policies referring to the old table name. Inbound foreign
keys are fine, because their names derive from the child table. The rest need doing
by hand — `ALTER TABLE … RENAME CONSTRAINT`, `ALTER INDEX … RENAME TO`,
`ALTER POLICY … ON <new_table> RENAME TO` — and the first two are **not**
interchangeable: `RENAME CONSTRAINT` cannot find an index-backed unique index,
while renaming a constraint *does* rename its backing index.

**`DEFERRABLE` only applies to constraints, and a partial unique index cannot be
one.** So there is no deferral to ask for and the check fires at end-of-statement.
"It is all one transaction, so ordering does not matter" is wrong here in a way
that typechecks, passes review, and only fails against a real database — demote
before you promote. When the unique key is a column the failing statement never
names, the error points somewhere unhelpful.

## 3. Row-level security: who it applies to, who bypasses it

**Referential integrity bypasses RLS.** Postgres evaluates RI triggers with row
security off, so under FORCE RLS a session can insert a row whose foreign key
points at a parent it cannot read. Measured as a `NOSUPERUSER NOBYPASSRLS` role
with the tenant GUC set to one tenant, in a rolled-back transaction:

- `SELECT count(*) …` for the invisible parent row → **0**
- `INSERT` referencing that same id → **`INSERT 0 1`**
- the same insert with an id belonging to no row → FK violation

So **an FK gives you no tenant isolation**, and dropping one costs none either.

**`BYPASSRLS` means policies are not consulted at all.** "Append-only by database
policy" — FORCE RLS plus SELECT and INSERT policies and deliberately no
UPDATE/DELETE policy — is only true for the roles RLS applies to. **A missing
policy denies; it never revokes.** Two independent mechanisms must agree before
"the database enforces this" is true, and the half nobody re-reads is a blanket
`GRANT … ON ALL TABLES` issued in an unrelated earlier migration. Check
`pg_policy` for the table *and* the table's grants for every role, with
`rolbypassrls` in hand.

**`SECURITY DEFINER` does not mean "bypasses RLS".** It runs as the function's
**owner**, and a function created by a migration is owned by whoever ran the
migration — and `FORCE ROW LEVEL SECURITY` is precisely the flag that stops
exempting the owner. Measured on a throwaway database (owner
`NOSUPERUSER NOBYPASSRLS`, one FORCEd table, a tenant policy, the definer reader
granted to a separate app role): FORCE on → **NULL**; `NO FORCE` → the row; FORCE
on plus `BYPASSRLS` on the owner → the row.

Fixing it is a provisioning change, not a migration: `ALTER FUNCTION … OWNER TO
<role>` run as the owner fails with `ERROR:  must be able to SET ROLE "<role>"`,
so that role membership has to be granted, and the new owner also needs `CREATE`
on the schema. A restore loses the ownership again unless provisioning covers it.

## 4. `row_security`: raise versus filter, and dumps under RLS

`row_security = off` asks Postgres to **raise** rather than filter. Measured as a
`NOSUPERUSER NOBYPASSRLS` owner, `INSERT`, `UPDATE` **and** `SELECT` on a FORCEd
table all raise:

```
query would be affected by row-level security policy
```

The same setting is **inert** on an RLS-enabled table the role owns that is not
forced. So `row_security = off` on a migration or maintenance connection converts
every silent zero-row failure into a loud one, stays quiet while a table is
legitimately un-forced, and is the only mechanism that covers a table forced
*mid-run*. The cost is that any statement legitimately touching a forced table now
raises, so existing callers must be allowlisted first.

**The diagnostic rule that follows:** when an RLS error disappears after you add a
flag, check whether the flag changed *raise* into *filter* before believing it.
The question is not "does it succeed now" but "how many rows did it return, and
which role's policies decided that". A role with no tenant GUC set sees **zero
rows from every tenant-scoped table**, successfully.

**`pg_dump --enable-row-security` against a non-superuser owner** produces a dump
that succeeds with a plausible byte count — the schema still dumps — and restores
to an empty database.

## 5. Privileges for bulk loads and restores

Measured on **Postgres 16** with a throwaway `NOSUPERUSER NOBYPASSRLS` role owning
its own tables:

| mechanism | non-superuser owner |
|---|---|
| `ALTER TABLE … DISABLE TRIGGER USER` | **works** |
| `ALTER TABLE … DISABLE TRIGGER ALL` | `permission denied: "RI_ConstraintTrigger_…" is a system trigger` |
| `SET session_replication_role = replica` | `permission denied to set parameter` (SUSET) |

`pg_restore --disable-triggers` emits the **ALL** form — verify with
`pg_restore --file=-` — so it is unavailable to a deliberately non-superuser
deployment role, even though the `USER` form, which is enough, is available.
`GRANT SET ON PARAMETER session_replication_role TO <role>` (**PG15+**) lifts the
third.

And the `USER` form leaves referential-integrity triggers enabled, so a
`--data-only` restore still fails on FK ordering: **disabling triggers is not by
itself a working data-only restore.**

**A role reading through a policy is not told which key collided.** A unique
violation raised for such a role omits the offending key's description, so a client
library has no columns to report — the same insert as the table's **owner** names
them. It is the role, not the transaction. Any test that asserts a constraint *by
name or by columns* has to run its violating write as the owner (still satisfying
the policy's `WITH CHECK` on a FORCEd table), and should say in a comment why,
because it reads like an oversight.

**A composite foreign key with mixed nullability is MATCH SIMPLE by default**, which
means "if any column of the key is NULL, the constraint is not checked at all". That
is usually the behaviour you want for an optional-reference-plus-required-discriminator
pair — no code, no check — but it is a default worth stating out loud in the
migration, because `MATCH FULL` is what a reader may assume.

**The CI trap for all of §3–§5:** a drill running as the `postgres` superuser makes
every one of these work, so a fix built on the privileged routes is green in CI and
broken in deployment. Test under a provisioned non-superuser role or you are
testing nothing.

**`pg_stat_activity` hides other sessions' fields from an unprivileged role.**
`min(xact_start)` — the natural watermark for "how far back is the oldest open
transaction" — reads **NULL** for every session but your own unless the reader is
superuser or a member of `pg_read_all_stats`. Measured as an unprivileged
application role: **6 sessions, 0 visible `xact_start`; after
`GRANT pg_read_all_stats`, 1.** A monitoring query built this way returns a
confident, wrong answer rather than an error — and dev and CI, which usually own
the database as superuser, would never see it missing. This is the §3–§5 CI trap
again, in a read path.

**`pg_dump` holds one snapshot for the whole backup.** So a long dump keeps a
transaction open for its entire duration, and any watermark derived from the oldest
open transaction does not advance until the backup finishes. Budget for that before
treating such a watermark as a liveness signal.

## 6. Planner behaviour: when a predicate is not a guard, and ordering ties

**A `WHERE` clause does not stop Postgres evaluating a select-list function on
excluded rows.** Filtering `relkind = 'S'` while calling
`has_sequence_privilege(role, c.oid, 'SELECT')` in the select list failed with:

```
ERROR:  "pg_toast_153292" is not a sequence
```

The planner is free to evaluate the function before — or instead of — applying the
qualifier. Force the filter to happen first with `WITH x AS MATERIALIZED (…)`, or
a `CREATE TEMP TABLE` of the filtered rows, then call the function against that.
Once materialized, `count(*) FILTER (WHERE …)` gets many counts in one pass.

Adjacent trap: a `LIMIT 1` written on the last branch of a `UNION ALL` applies to
the **whole union**, silently returning one row instead of all of them.

**An index can hide a missing tiebreaker.** Measured on PG16 with six rows written
in one transaction sharing an identical `created_at`:

| plan | `ORDER BY created_at DESC` | `ORDER BY created_at DESC, seq DESC` |
|---|---|---|
| Index Scan Backward on `(tenant_id, created_at, seq)` | **correct** | correct |
| `Sort` over `Seq Scan` | **exactly reversed** | correct |

Within a tie, btree order *is* `seq` order, so a backward index scan resolves the
tie the way you wanted without the query ever asking — and a `Sort` over a seq
scan is what a small table gets. Force the other plan inside the transaction:

```sql
SET LOCAL enable_indexscan = off;
SET LOCAL enable_bitmapscan = off;
```

State the guarantee as *the order holds under every plan*: the `ORDER BY` provides
that, the index only provides the speed.

## 7. Session, GUC and psql mechanics that rewrite your SQL

**`set_config(name, NULL, true)` stores an empty string, not NULL.**
`current_setting(name, true)` afterwards returns `''`. So the reader guard is:

```sql
NULLIF(current_setting('app.x', true), '')::uuid
```

and only the `NULLIF` is load-bearing — drop it and every absent-value case fails
with `invalid input syntax for type uuid: ""`. A caller-side `?? ""` changes
nothing at the database.

**Quoting a whole `search_path` list makes it one identifier**, and Postgres raises
nothing, because a search_path may legally name a schema that does not exist:

```sql
BEGIN;
SET LOCAL search_path = 'a, b, public';
SELECT current_schemas(false);          --  {}                <- zero schemas
SELECT current_setting('search_path');  --  "a, b, public"     <- one name
ROLLBACK;
```

Unquoted is what you meant: `SET LOCAL search_path = a, b, public;` →
`{a,b,public}`, minus any that do not exist. `SET search_path = ''` is different
and correct — an empty string really is a list of zero schemas, which is what
`pg_dump`/`pg_restore` emit. Assert `current_schemas(false)` equals the list you
intended.

**psql substitutes `:'var'` during lexing and skips dollar-quoted strings.** So
`DO $$ … EXECUTE format(…, :'password') … $$` does not fail with "undefined
variable": the `:` reaches the server and you get `syntax error at or near ":"`,
which reads like a SQL bug rather than a psql one. To pass a psql variable into
DDL, build the statement and execute it:

```sql
SELECT format('CREATE ROLE app_role LOGIN PASSWORD %L NOSUPERUSER', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role')
\gexec
```

`\gexec` is also the only way to make `CREATE DATABASE` conditional, since it
cannot run inside a transaction or a `DO` block. Guard required variables with
`\if :{?name}` / `\else` / `\quit` / `\endif` — an unset variable otherwise
interpolates as literal text.

## Version dependence

- **Measured on PG16:** the `ADD COLUMN` rewrite table (§2), the trigger-disable
  privilege table (§5), the ordering/tiebreaker table (§6).
- **PG15+:** `GRANT SET ON PARAMETER session_replication_role`.
- **PG13+:** `ALTER COLUMN … DROP EXPRESSION`.
- **PG11+:** the non-volatile `ADD COLUMN` default stored as a "missing value".
- Everything else was observed on 16 and is not known to be version-specific.
  §6's function-evaluation behaviour is a statement about what the planner is
  *free* to do, not a guarantee about what it always does.

## Related

`pg-dump-and-restore` for archive and restore mechanics beyond privileges;
`proof-and-verification` for why several of the traps above pass vacuously as
tests — a row count under RLS, a tiebreaker test that never forces the plan, a
red proof that removes the caller's guard instead of the load-bearing one.
