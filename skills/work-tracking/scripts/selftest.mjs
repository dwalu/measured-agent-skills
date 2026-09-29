#!/usr/bin/env node
// Self-test for the work-tracking skill.
//
//   node <skill>/scripts/selftest.mjs [--keep]
//
// Scaffolds a throwaway repo in a temp directory, then exercises every gate the
// system claims to have — including the ones that must NOT fire, which is the
// half that decays silently. Run it after touching validate-tracking.mjs or any
// template; it is the only thing standing between an edit and a rule that
// quietly stops catching anything.
//
// --keep leaves the scratch repo on disk and prints its path.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEEP = process.argv.includes('--keep');
const REPO = mkdtempSync(join(tmpdir(), 'work-tracking-selftest-'));

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const why = fn();
    if (why) failures.push(`${name}\n      ${why}`);
    else { passed++; return; }
  } catch (e) {
    failures.push(`${name}\n      threw: ${e.message.split('\n')[0]}`);
  }
}

/** Run a command; never throws. Returns {code, out} with stdout+stderr merged. */
function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

const git = (...args) => run('git', args);
const validate = (...args) => run('node', ['scripts/validate-tracking.mjs', ...args]);

const FLOW = join(REPO, 'plans/tracking/flows/F00-foundations.md');
const SRC = join(REPO, 'src/index.ts');
let pristineFlow = '';
let pristineSrc = '';
const restore = () => { writeFileSync(FLOW, pristineFlow); writeFileSync(SRC, pristineSrc); };

/** Mutate the flow file with one replacement, validate, restore. */
function mutating(from, to) {
  const raw = pristineFlow;
  if (!raw.includes(from)) { restore(); return { out: `FIXTURE DRIFT: flow file has no "${from}"`, code: -1 }; }
  writeFileSync(FLOW, raw.replace(from, to));
  const r = validate();
  restore();
  return r;
}

/** A rule fires: the run must fail AND say why in recognisable words. */
function fires(from, to, expect) {
  const r = mutating(from, to);
  if (r.code === -1) return r.out;
  if (r.code === 0) return `validator stayed green`;
  if (!r.out.includes(expect)) return `failed, but for the wrong reason — wanted "${expect}", got:\n      ${r.out.split('\n').filter((l) => l.includes('-')).slice(0, 1).join('')}`;
  return null;
}

// ---------------------------------------------------------------------------

console.log(`work-tracking selftest → ${REPO}\n`);

git('init', '-q', '.');
git('config', 'user.email', 'selftest@example.invalid');
git('config', 'user.name', 'Selftest Runner');
mkdirSync(join(REPO, 'src'), { recursive: true });
writeFileSync(SRC, 'export const x = 1;\n');

const init = run('node', [join(HERE, 'init.mjs')]);
check('init scaffolds without error', () =>
  init.code === 0 ? null : `exit ${init.code}\n      ${init.out}`);

pristineFlow = readFileSync(FLOW, 'utf8');
pristineSrc = readFileSync(SRC, 'utf8');

// The regression this exists for: `git ls-files` cannot see untracked files, so
// an unstaged scaffold validates green for the wrong reason. Everything below
// runs with the tree ADDED.
git('add', '-A');
check('a freshly scaffolded, git-added repo validates clean', () => {
  const r = validate();
  return r.code === 0 ? null : `exit ${r.code}\n      ${r.out.split('\n').slice(0, 3).join('\n      ')}`;
});

// The exemption above is belt AND braces: init.mjs writes docsExclude into the
// config, and the validator defaults it when the key is absent. The scaffold
// check exercises only the first, so removing the default alone would go
// unnoticed. This exercises the second, on a hand-minimal config — the shape a
// repo gets when someone writes tracking.config.json themselves.
check('the tracking README is exempt even with no docsExclude key', () => {
  const path = join(REPO, 'tracking.config.json');
  const saved = readFileSync(path, 'utf8');
  const cfg = JSON.parse(saved);
  delete cfg.citations.docsExclude;
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  const r = validate();
  writeFileSync(path, saved);
  return r.code === 0
    ? null
    : `the README's grammar examples were treated as citations:\n      ${r.out.split('\n').slice(1, 3).join('\n      ')}`;
});

// ---- the commit gate ------------------------------------------------------

git('config', 'core.hooksPath', '.githooks');

check('commit with no task trailer is blocked', () => {
  const r = git('commit', '-m', 'chore: scaffold');
  return r.code !== 0 && r.out.includes('Task: <id>') ? null : `exit ${r.code}: ${r.out.slice(0, 200)}`;
});
check('commit with [skip-task] is allowed', () => {
  const r = git('commit', '-m', 'chore: scaffold [skip-task]');
  return r.code === 0 ? null : r.out.slice(0, 300);
});
check('commit naming an ACTIVE task is allowed', () => {
  appendFileSync(SRC, '// work\n');
  pristineSrc = readFileSync(SRC, 'utf8');
  git('add', '-A');
  const r = git('commit', '-m', 'feat: a thing\n\nTask: F00.1-I2');
  return r.code === 0 ? null : r.out.slice(0, 300);
});
check('commit naming a DONE task is blocked', () => {
  appendFileSync(SRC, '// more\n');
  git('add', '-A');
  const r = git('commit', '-m', 'feat: nope\n\nTask: F00.1-I1');
  const blocked = r.code !== 0 && r.out.includes('already done');
  git('reset', '-q', '--hard', 'HEAD');
  pristineSrc = readFileSync(SRC, 'utf8');
  return blocked ? null : `exit ${r.code}: ${r.out.slice(0, 200)}`;
});

// ---- the structural rules (each must FIRE) --------------------------------

check('checkbox / emoji disagreement', () =>
  fires('- [x] `F00.1-I1`', '- [ ] `F00.1-I1`', 'checkbox is [ ]'));

check('in-review with no PR link', () =>
  fires('— ⬜', '— 🟦', "no 'PR #<n>' link"));

check('blocked with no reason', () =>
  fires('— ⬜', '— ⛔', "no '(blocked: reason)'"));

check('duplicate TODO number', () =>
  fires(
    '- [x] `F00.1-D1`',
    '- [ ] `F00.1-I9` **TODO-1** · **Rank:** 900 · **Owner:** X · dup — ⬜\n- [x] `F00.1-D1`',
    'duplicate id or TODO number `TODO-1`',
  ));

check('a bold TODO used as a citation', () =>
  fires('Work tracking conventions', 'Work tracking **TODO-1** conventions', 'not immediately after the task id'));

check('a rank written with a # prefix', () =>
  fires('**Rank:** 200', '**Rank:** #200', 'malformed **Rank:**'));

check('a malformed task id', () =>
  fires('`F00.1-I2`', '`F00.1-X2`', 'is malformed'));

check('a task filed under the wrong feature', () =>
  fires('`F00.1-I2`', '`F00.2-I2`', 'does not belong to feature F00.1'));

check('a stale rollup (status flip without --write)', () =>
  fires('# F00 — Foundations', '# F00 — Foundation Works', 'rollup is stale'));

// ---- citations + promises -------------------------------------------------

function withSource(line) {
  writeFileSync(SRC, pristineSrc + line + '\n');
  git('add', '-A');
  const r = validate();
  restore();
  git('add', '-A');
  return r;
}

check('source citing a task that does not exist', () => {
  const r = withSource('// F09.9-I1 will handle the rest');
  return r.code !== 0 && r.out.includes('does not exist in the tracking files') ? null : `exit ${r.code}`;
});

check('a code comment promising what a DONE task will do', () => {
  const r = withSource('// F00.1-I1 removes this shim once the scaffold lands');
  return r.code !== 0 && r.out.includes('still promises') ? null : `exit ${r.code}`;
});

// The half that decays silently: rules that must NOT fire.
check('NOT fired: the same promise about an OPEN task', () => {
  const r = withSource('// F00.1-I2 removes this shim');
  return r.code === 0 ? null : `false positive:\n      ${r.out.split('\n').slice(1, 3).join('\n      ')}`;
});

check('NOT fired: a matching verb 43 characters from the id', () => {
  const r = withSource('// see F00.1-I1: the seat is taken, the waitlist advances, and A drops out later');
  return r.code === 0 ? null : `false positive:\n      ${r.out.split('\n').slice(1, 3).join('\n      ')}`;
});

// ---- --new-task -----------------------------------------------------------

check('--new-task allocates the next TODO and a midpoint rank', () => {
  const r = validate('--new-task', 'F00.1', '--after', 'F00.1-I2', '--title', '**Filed**');
  if (r.code !== 0) return r.out.slice(0, 200);
  if (!r.out.includes('**TODO-2**')) return `did not allocate TODO-2:\n      ${r.out.split('\n')[0]}`;
  if (!/\*\*Rank:\*\* \d+/.test(r.out)) return `no rank in the emitted line`;
  return null;
});

check('--new-task without --apply writes nothing', () => {
  const before = readFileSync(FLOW, 'utf8');
  validate('--new-task', 'F00.1', '--title', '**Dry**');
  return readFileSync(FLOW, 'utf8') === before ? null : 'the flow file changed on a dry run';
});

check('--new-task --apply inserts a valid line', () => {
  const r = validate('--new-task', 'F00.1', '--after', 'F00.1-I2', '--title', '**Filed** — evidence', '--apply');
  if (r.code !== 0) return r.out.slice(0, 200);
  validate('--write');
  git('add', '-A');
  const v = validate();
  if (v.code !== 0) return `the inserted line does not validate:\n      ${v.out.split('\n').slice(1, 3).join('\n      ')}`;
  return readFileSync(FLOW, 'utf8').includes('F00.1-I3') ? null : 'F00.1-I3 is not in the flow file';
});

check('--new-task --after refuses when there is no gap', () => {
  // I3 was just inserted at the midpoint; wedge a task onto I2's exact rank so
  // the pair becomes adjacent, then ask to insert between them.
  const raw = readFileSync(FLOW, 'utf8');
  const bumped = raw.replace(/(`F00\.1-I3`.*?\*\*Rank:\*\* )\d+/, '$1201');
  writeFileSync(FLOW, bumped);
  validate('--write');
  const r = validate('--new-task', 'F00.1', '--after', 'F00.1-I2');
  const ok = r.code !== 0 && r.out.includes('no gap between rank');
  writeFileSync(FLOW, raw);
  validate('--write');
  git('add', '-A');
  return ok ? null : `exit ${r.code}: ${r.out.slice(0, 160)}`;
});

check('--new-task refuses an unknown feature', () => {
  const r = validate('--new-task', 'F99.9');
  return r.code !== 0 && r.out.includes('no feature') ? null : `exit ${r.code}`;
});

// ---- --renumber -----------------------------------------------------------

const queueOrder = () => {
  const r = validate('--json');
  return JSON.parse(r.out).queue.map((q) => q.id).join(',');
};

check('--renumber --apply preserves queue order exactly', () => {
  const before = queueOrder();
  const r = validate('--renumber', '--apply');
  if (r.code !== 0) return r.out.slice(0, 200);
  validate('--write');
  const after = queueOrder();
  if (before !== after) return `order changed\n      before: ${before}\n      after:  ${after}`;
  const ranks = [...readFileSync(FLOW, 'utf8').matchAll(/\*\*Rank:\*\* (\d+)/g)].map((m) => Number(m[1]));
  return ranks.every((n) => n % 100 === 0) ? null : `ranks are not on a 100-grid: ${ranks.join(',')}`;
});

check('--renumber without --apply writes nothing', () => {
  const before = readFileSync(FLOW, 'utf8');
  validate('--renumber');
  return readFileSync(FLOW, 'utf8') === before ? null : 'the flow file changed on a dry run';
});

// ---- machine-readable output ----------------------------------------------

check('--json is parseable and carries the queue', () => {
  const r = validate('--json');
  const j = JSON.parse(r.out);
  if (!j.ok) return `ok:false — ${JSON.stringify(j.errors.slice(0, 1))}`;
  if (!Array.isArray(j.queue) || !j.queue.length) return 'empty queue';
  if (!/^TODO-\d+$/.test(j.nextTodo)) return `bad nextTodo: ${j.nextTodo}`;
  const t = j.queue[0];
  for (const k of ['id', 'rank', 'status', 'label']) if (!(k in t)) return `queue entry missing ${k}`;
  return null;
});

check('--next prints the head of the queue', () => {
  const r = validate('--next', '2');
  return r.code === 0 && r.out.includes('F00.1-I2') ? null : `exit ${r.code}: ${r.out.slice(0, 160)}`;
});

// ---- report ---------------------------------------------------------------

console.log('');
if (failures.length) {
  console.log(`❌ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.log(`   ✗ ${f}\n`);
} else {
  console.log(`✅ all ${passed} checks passed`);
}

if (KEEP) console.log(`\nscratch repo kept at ${REPO}`);
else rmSync(REPO, { recursive: true, force: true });

process.exit(failures.length ? 1 : 0);
