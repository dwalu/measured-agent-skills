#!/usr/bin/env node
/**
 * Validate the skills tree against the Agent Skills spec, plus the checks the
 * host validators cannot or do not make.
 *
 * Gemini CLI ships `validate_skill.cjs`, which matches the description with
 *     /^description:\s*(?:'([^']*)'|"([^"]*)"|(.+))$/m
 * That captures the literal ">-" for a folded block scalar and then reports the
 * skill valid — so it is blind to the description, cannot enforce the 1024-char
 * limit, and cannot see anything about the body at all. This validator folds block
 * scalars properly and adds the checks that actually protect this corpus.
 *
 * Usage:
 *   node scripts/validate.mjs [--dir skills] [--quiet]
 *   node scripts/validate.mjs --self-test     # prove the failure paths fire
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DESC_MAX = 1024;
const DESC_WARN = 900;
const BODY_WARN_LINES = 500;
const TOC_MIN_LINES = 100;
const NAME_MAX = 64;

/** Parse SKILL.md into { name, description, body, bodyLines }. Folds >-/| scalars. */
export function parseSkill(text) {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { error: "no YAML frontmatter (must start with ---)" };
  let i = 1;
  const fm = [];
  while (i < lines.length && lines[i].trim() !== "---") fm.push(lines[i++]);
  if (i >= lines.length) return { error: "unterminated frontmatter" };
  const body = lines.slice(i + 1);

  const read = (key) => {
    const at = fm.findIndex((l) => new RegExp(`^${key}:`).test(l));
    if (at === -1) return undefined;
    if (new RegExp(`^${key}:\\s*[>|]`).test(fm[at])) {
      const cont = [];
      for (let j = at + 1; j < fm.length; j++) {
        if (/^\S/.test(fm[j])) break;
        cont.push(fm[j].trim());
      }
      return cont.filter(Boolean).join(" ");
    }
    const m = fm[at].match(new RegExp(`^${key}:\\s*(?:'(.*)'|"(.*)"|(.*))$`));
    return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : "";
  };

  return {
    name: read("name"),
    description: read("description"),
    extraKeys: fm
      .filter((l) => /^[a-z-]+:/.test(l))
      .map((l) => l.split(":")[0])
      .filter((k) => !["name", "description"].includes(k)),
    body: body.join("\n"),
    bodyLines: body.length,
  };
}

/**
 * Project names that must never appear in a portable skill. The mechanism ships with this
 * repo; the names do not — a public checkout should not carry anyone's private project
 * list. Supply them either way:
 *
 *   SKILLS_DENY="acme,widgets" node scripts/validate.mjs
 *   echo acme >> project-names.local     # one per line, '#' comments, gitignored
 *
 * The file is read from the PARENT of the skills directory, not the working directory, so
 * a self-test against a temp tree is genuinely unconfigured rather than picking this
 * repo's list up by accident.
 *
 * With no names configured the check cannot fire, and validateTree() warns that it was
 * skipped. A check that silently passes because it was never given anything to look for
 * is the vacuous green `proof-and-verification` §4 is about.
 */
export function projectDenyList(root) {
  const out = new Set();
  for (const raw of (process.env.SKILLS_DENY ?? "").split(",")) {
    const s = raw.trim().toLowerCase();
    if (s) out.add(s);
  }
  const f = path.join(path.dirname(path.resolve(root)), "project-names.local");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const s = line.replace(/#.*/, "").trim().toLowerCase();
      if (s) out.add(s);
    }
  }
  return [...out];
}

function validateTree(root, { quiet = false } = {}) {
  const errors = [];
  const warnings = [];
  const deny = projectDenyList(root);
  if (deny.length === 0)
    warnings.push(
      'project-leak check SKIPPED — no names configured (SKILLS_DENY=… or project-names.local)',
    );
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((n) => n !== "synced")
    .sort();

  const known = new Set(dirs);
  const sections = new Map(); // skill -> Set of top-level section numbers

  const parsed = new Map();
  for (const dir of dirs) {
    const p = path.join(root, dir, "SKILL.md");
    if (!fs.existsSync(p)) {
      errors.push(`${dir}: no SKILL.md`);
      continue;
    }
    const s = parseSkill(fs.readFileSync(p, "utf8"));
    if (s.error) {
      errors.push(`${dir}: ${s.error}`);
      continue;
    }
    parsed.set(dir, s);

    // --- spec-level ---
    if (!s.name) errors.push(`${dir}: missing name`);
    else {
      if (s.name !== dir) errors.push(`${dir}: name "${s.name}" must equal its directory name`);
      if (!/^[a-z0-9-]+$/.test(s.name)) errors.push(`${dir}: name must be hyphen-case [a-z0-9-]`);
      if (/^-|-$|--/.test(s.name)) errors.push(`${dir}: name has leading/trailing/double hyphen`);
      if (s.name.length > NAME_MAX) errors.push(`${dir}: name exceeds ${NAME_MAX} chars`);
    }
    if (!s.description) errors.push(`${dir}: missing description`);
    else {
      if (s.description.length > DESC_MAX)
        errors.push(`${dir}: description is ${s.description.length} chars (max ${DESC_MAX})`);
      else if (s.description.length > DESC_WARN)
        warnings.push(
          `${dir}: description ${s.description.length}/${DESC_MAX} — thin headroom, and the host validator cannot see it`,
        );
      if (/\n/.test(s.description)) errors.push(`${dir}: description contains a newline`);
    }

    // --- this corpus's own rules ---
    if (s.bodyLines > BODY_WARN_LINES)
      warnings.push(
        `${dir}: body is ${s.bodyLines} lines (guidance ${BODY_WARN_LINES}) — move detail to references/`,
      );

    // no project leak: this corpus is deliberately project-free
    const allFiles = walk(path.join(root, dir));
    for (const f of allFiles) {
      const txt = fs.readFileSync(f, "utf8");
      if (/TODO:/.test(txt))
        warnings.push(`${dir}: "TODO:" in ${path.relative(root, f)} (host validator warns on this)`);
      for (const name of deny) {
        const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (re.test(txt))
          errors.push(`${dir}: project leak — "${name}" appears in ${path.relative(root, f)}`);
      }
    }

    // reference files over N lines need a table of contents
    const refDir = path.join(root, dir, "references");
    if (fs.existsSync(refDir)) {
      for (const rf of fs.readdirSync(refDir)) {
        const rp = path.join(refDir, rf);
        if (!fs.statSync(rp).isFile()) continue;
        const rl = fs.readFileSync(rp, "utf8").split("\n");
        if (rl.length > TOC_MIN_LINES && !/^\s*(##\s*Contents|- \[)/m.test(rl.slice(0, 40).join("\n")))
          warnings.push(`${dir}: references/${rf} is ${rl.length} lines and has no table of contents`);
        if (!new RegExp(`references/${rf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(s.body))
          warnings.push(`${dir}: references/${rf} is never mentioned from SKILL.md`);
      }
    }

    // record this skill's own top-level section numbers, for §-reference checking
    const nums = new Set();
    for (const m of s.body.matchAll(/^##\s+(\d+)\./gm)) nums.add(m[1]);
    sections.set(dir, nums);
  }

  // --- cross-references resolve ---
  for (const [dir, s] of parsed) {
    // `skill-name` §N  and  bare skill-name mentions
    for (const m of s.body.matchAll(/`([a-z0-9-]{4,})`\s*§(\d+)/g)) {
      const [, target, num] = m;
      if (!known.has(target)) {
        errors.push(`${dir}: cites §${num} of "${target}", which is not a skill here`);
      } else if (sections.get(target)?.size && !sections.get(target).has(num)) {
        errors.push(
          `${dir}: cites "${target}" §${num}, but that skill has no top-level section ${num}`,
        );
      }
    }
    for (const m of s.body.matchAll(/^-\s+`?([a-z][a-z0-9-]{6,})`?\s+—/gm)) {
      const target = m[1];
      if (/^(the|and|for|use|when|note)$/.test(target)) continue;
      if (target.includes("-") && !known.has(target) && /behaviour|verification|tracking|delivery|runners|forensics|runtime|gates|restore|branch/.test(target))
        warnings.push(`${dir}: Related names "${target}", which is not a skill in this tree`);
    }
  }

  if (!quiet) {
    for (const e of errors) console.error(`  ERROR  ${e}`);
    for (const w of warnings) console.warn(`  warn   ${w}`);
    console.log(
      `\n${parsed.size} skills checked — ${errors.length} error(s), ${warnings.length} warning(s)`,
    );
  }
  return { errors, warnings, count: parsed.size };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", ".git"].includes(e.name)) walk(p, out);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ self-test */
/**
 * A validator whose failure path is untested is the defect this corpus warns about.
 * Each case asserts the SPECIFIC message, not merely that validation failed — a
 * check on "did it error" passes vacuously when the harness is broken.
 */
function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-selftest-"));
  const mk = (name, skillMd, extra = {}) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), skillMd);
    for (const [rel, content] of Object.entries(extra)) {
      const fp = path.join(d, rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
    return d;
  };
  const fm = (name, desc, body = "# x\n\nbody\n") => `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`;

  const cases = [
    {
      what: "a folded description over 1024 chars is caught (the host validator cannot see it)",
      build: () =>
        mk(
          "over-long",
          `---\nname: over-long\ndescription: >-\n${"  filler filler filler filler filler filler filler\n".repeat(25)}---\n\n# x\n`,
        ),
      expect: /description is \d+ chars \(max 1024\)/,
    },
    {
      what: "name not matching its directory is caught",
      build: () => mk("dir-name", fm("other-name", "a description")),
      expect: /must equal its directory name/,
    },
    {
      what: "a non-hyphen-case name is caught",
      build: () => mk("Bad_Name", fm("Bad_Name", "a description")),
      expect: /hyphen-case/,
    },
    {
      what: "a project leak is caught, for a name given at run time",
      build: () => mk("leaky", fm("leaky", "a description", "# x\n\nthis mentions AcmeCorp by name\n")),
      env: { SKILLS_DENY: "acmecorp" },
      expect: /project leak — "acmecorp"/,
    },
    {
      what: "an UNCONFIGURED leak check warns rather than passing quietly",
      build: () => mk("leaky2", fm("leaky2", "a description", "# x\n\nthis mentions AcmeCorp by name\n")),
      env: { SKILLS_DENY: "" },
      expectWarn: true,
      expect: /project-leak check SKIPPED/,
    },
    {
      what: "a dangling § cross-reference is caught",
      build: () => mk("dangler", fm("dangler", "a description", "# x\n\nsee `no-such-skill` §3\n")),
      expect: /is not a skill here/,
    },
    {
      what: "a § pointing at a section that does not exist is caught",
      build: () => {
        mk("target-skill", fm("target-skill", "a description", "# t\n\n## 1. only section\n"));
        return mk("citer", fm("citer", "a description", "# c\n\nsee `target-skill` §9\n"));
      },
      expect: /has no top-level section 9/,
    },
    {
      what: "a missing SKILL.md is caught",
      build: () => {
        const d = path.join(tmp, "empty-skill");
        fs.mkdirSync(d, { recursive: true });
        return d;
      },
      expect: /no SKILL\.md/,
    },
  ];

  // positive baseline: detects a harness that fails everything
  mk("good-skill", fm("good-skill", "a perfectly ordinary description", "# g\n\n## 1. fine\n"));

  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    c.build();
    const savedDeny = process.env.SKILLS_DENY;
    // every case is explicit about the denylist, so none of them depends on the ambient env
    process.env.SKILLS_DENY = c.env?.SKILLS_DENY ?? "selftest-never-matches";
    const { errors, warnings } = validateTree(tmp, { quiet: true });
    if (savedDeny === undefined) delete process.env.SKILLS_DENY;
    else process.env.SKILLS_DENY = savedDeny;
    const hit = (c.expectWarn ? warnings : errors).find((e) => c.expect.test(e));
    if (hit) {
      console.log(`  ✓ ${c.what}`);
      pass++;
    } else {
      console.error(`  ✗ ${c.what}`);
      console.error(
        `      expected /${c.expect.source}/ in ${c.expectWarn ? "warnings" : "errors"}, got: ` +
          JSON.stringify(c.expectWarn ? warnings : errors),
      );
      fail++;
    }
    // remove the fixture again so cases stay independent
    for (const n of fs.readdirSync(tmp)) {
      if (n !== "good-skill" && n !== "target-skill") fs.rmSync(path.join(tmp, n), { recursive: true, force: true });
    }
  }

  // the baseline must be clean, or every ✓ above could be a broken harness
  process.env.SKILLS_DENY = "selftest-never-matches";
  const base = validateTree(tmp, { quiet: true });
  if (base.errors.length === 0) {
    console.log("  ✓ positive baseline is clean (the suite is not failing everything)");
    pass++;
  } else {
    console.error(`  ✗ positive baseline reported errors: ${JSON.stringify(base.errors)}`);
    fail++;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nself-test: ${pass} passed, ${fail} failed`);
  return fail;
}

/* ------------------------------------------------------------------------ main */
const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  process.exit(selfTest() ? 1 : 0);
}
const dirIdx = args.indexOf("--dir");
const root = path.resolve(dirIdx !== -1 ? args[dirIdx + 1] : "skills");
if (!fs.existsSync(root)) {
  console.error(`no such directory: ${root}`);
  process.exit(1);
}
const { errors } = validateTree(root, { quiet: args.includes("--quiet") });
process.exit(errors.length ? 1 : 0);
