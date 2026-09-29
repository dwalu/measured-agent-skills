#!/usr/bin/env node
// Scaffold the Markdown work-tracking system into a repository.
//
//   node <skill>/scripts/init.mjs [options]
//
// Options (all optional):
//   --dir <path>       where tracking lives            (default plans/tracking)
//   --prefix <letter>  id prefix                       (default F)
//   --owner <name>     default owner for --new-task    (default: git user.name)
//   --trailer <key>    commit trailer key              (default Task)
//   --lenient          owner/rank stay warnings        (default: strict errors)
//   --no-hooks         skip .githooks + core.hooksPath
//   --no-ci            skip the GitHub Actions workflow
//   --force            overwrite files that already exist
//
// Idempotent: existing files are left alone and reported, unless --force.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TPL = join(HERE, 'templates');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (name) => process.argv.includes(`--${name}`);

function gitOut(args, fallback = null) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

const ROOT = gitOut(['rev-parse', '--show-toplevel']);
if (!ROOT) {
  console.error('❌ not inside a git repository — run `git init` first (the citation checks read `git ls-files`)');
  process.exit(2);
}

const DIR = String(arg('dir', 'plans/tracking')).replace(/^\/+|\/+$/g, '');
const PREFIX = String(arg('prefix', 'F'));
const TRAILER = String(arg('trailer', 'Task'));
const OWNER = String(arg('owner', gitOut(['config', 'user.name'], 'UNSET: set defaultOwner')));
const FORCE = has('force');
const STRICT = !has('lenient');

const vars = { DIR, PREFIX, TRAILER, OWNER };
const render = (s) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

const created = [];
const skipped = [];

function put(relPath, contents, { exec = false } = {}) {
  const abs = join(ROOT, relPath);
  if (existsSync(abs) && !FORCE) { skipped.push(relPath); return false; }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  if (exec) chmodSync(abs, 0o755);
  created.push(relPath);
  return true;
}

const tpl = (name) => render(readFileSync(join(TPL, name), 'utf8'));

// 1. The validator itself, copied in rather than referenced. The repo must stay
//    self-contained: CI and a fresh clone cannot reach into ~/.claude.
put('scripts/validate-tracking.mjs', readFileSync(join(HERE, 'validate-tracking.mjs'), 'utf8'), { exec: true });

// 2. Config.
put(
  'tracking.config.json',
  JSON.stringify(
    {
      dir: DIR,
      idPrefix: PREFIX,
      defaultOwner: OWNER,
      commitTrailer: TRAILER,
      strict: { owner: STRICT, rank: STRICT },
      spec: { requiredSections: [] },
      citations: {
        enabled: true,
        source: ['src', 'packages', 'apps', 'lib', 'e2e'],
        sourceExclude: [],
        docs: ['docs', 'plans', '.claude', '*.md'],
        // The tracking README specifies the id grammar, so its worked examples
        // are fictional ids by necessity. Keep it here.
        docsExclude: [`${DIR}/README.md`],
        deadRefs: {},
      },
    },
    null,
    2,
  ) + '\n',
);

// 3. The tracking documents.
put(`${DIR}/README.md`, tpl('README.md'));
put(`${DIR}/MASTER.md`, tpl('MASTER.md'));
put(`${DIR}/QUEUE.md`, tpl('QUEUE.md'));
put(`${DIR}/flows/${PREFIX}00-foundations.md`, tpl('flow.md'));

// 4. Hooks.
if (!has('no-hooks')) {
  put('.githooks/commit-msg', tpl('commit-msg'), { exec: true });
  put('.githooks/pre-commit', tpl('pre-commit'), { exec: true });
}

// 5. CI.
if (!has('no-ci')) put('.github/workflows/tracking.yml', tpl('tracking.yml'));

// 6. Generate MASTER + QUEUE so the tree is valid on the very first run.
let genOut = '';
try {
  genOut = execFileSync('node', [join(ROOT, 'scripts/validate-tracking.mjs'), '--write'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
} catch (e) {
  genOut = (e.stdout ?? '') + (e.stderr ?? '');
}

// ---- report ----------------------------------------------------------------

console.log(`\nwork-tracking → ${ROOT}\n`);
for (const f of created) console.log(`  created  ${f}`);
for (const f of skipped) console.log(`  exists   ${f}  (left alone — pass --force to overwrite)`);
console.log(`\n${genOut.trim()}\n`);

const hooksPath = gitOut(['config', 'core.hooksPath']);
console.log('Next:');
if (!has('no-hooks') && hooksPath !== '.githooks') {
  console.log('  1. Enable the hooks (once per clone):');
  console.log('       git config core.hooksPath .githooks');
  if (hooksPath) {
    console.log(`     ⚠️  core.hooksPath is currently \`${hooksPath}\` — merge the two hook`);
    console.log('        scripts by hand rather than clobbering what is already there.');
  }
}
console.log(`  2. Replace the placeholder task in ${DIR}/flows/${PREFIX}00-foundations.md.`);
console.log(`  3. Add a flow per user journey: cp that file to ${DIR}/flows/${PREFIX}01-<slug>.md`);
console.log(`  4. Point your agent instructions (CLAUDE.md / AGENTS.md) at ${DIR}/README.md`);
console.log('     and state the two rules that need a human to hold them:');
console.log(`       • every commit ends with a "${TRAILER}: <id>" trailer`);
console.log(`       • pick work from ${DIR}/QUEUE.md, never from a TODO number`);
if (STRICT) {
  console.log('\n  Owner and rank are ERRORS in this repo (greenfield default). If you are');
  console.log('  adopting this into an existing backlog, set strict.owner/strict.rank to');
  console.log('  false in tracking.config.json until the annotations catch up.');
}
console.log('');
