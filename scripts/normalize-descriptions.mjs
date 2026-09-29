#!/usr/bin/env node
/**
 * Rewrite each SKILL.md's `description` from a folded block scalar (`>-`) to a
 * single-line plain scalar.
 *
 * Why: Gemini CLI's runtime uses a real YAML loader and reads either form fine, but
 * its bundled validator/packager matches
 *     /^description:\s*(?:'([^']*)'|"([^"]*)"|(.+))$/m
 * which captures the literal string ">-" for a block scalar. It then reports
 * "Skill is valid!" while being blind to the description entirely — so it cannot
 * enforce the 1024-character limit. A single-line PLAIN scalar hits the `(.+)$`
 * branch and is read correctly by both.
 *
 * Plain (unquoted) rather than quoted on purpose: several descriptions contain double
 * quotes, and the validator's quoted branches stop at the first quote character, so
 * quoting would reintroduce the same blindness.
 *
 * Refuses to write if folding would change the description's text, and refuses to
 * produce a description that is not legal as a plain scalar.
 *
 * Usage: node scripts/normalize-descriptions.mjs [--apply] [--dir <skills-dir>]
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dirIdx = args.indexOf("--dir");
const ROOT = dirIdx !== -1 ? args[dirIdx + 1] : path.join(process.cwd(), "skills");

/** Split a SKILL.md into { pre, frontmatterLines, post } without touching body bytes. */
function splitSkill(text) {
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return null;
  let i = 1;
  const fm = [];
  while (i < lines.length && lines[i].trim() !== "---") fm.push(lines[i++]);
  if (i >= lines.length) return null; // unterminated frontmatter
  return { fm, body: lines.slice(i + 1).join("\n") };
}

/** Fold a block scalar or read a plain/quoted one. Returns {desc, startIdx, endIdx}. */
function readDescription(fm) {
  const start = fm.findIndex((l) => /^description:/.test(l));
  if (start === -1) return null;
  const head = fm[start];
  if (/^description:\s*[>|]/.test(head)) {
    const cont = [];
    let j = start + 1;
    for (; j < fm.length; j++) {
      if (/^\S/.test(fm[j])) break; // a new top-level key ends the scalar
      cont.push(fm[j].trim());
    }
    return { desc: cont.filter(Boolean).join(" "), start, end: j - 1 };
  }
  const m = head.match(/^description:\s*(?:'(.*)'|"(.*)"|(.*))$/);
  const raw = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
  return { desc: raw.trim(), start, end: start };
}

function plainUnsafe(desc) {
  const bad = [];
  if (/:\s/.test(desc)) bad.push("contains ': '");
  if (/\s#/.test(desc)) bad.push("contains ' #'");
  if (/^[-?:,[\]{}#&*!|>%@`"']/.test(desc)) bad.push(`starts with indicator ${desc[0]}`);
  if (/\n/.test(desc)) bad.push("contains a newline");
  return bad;
}

let changed = 0;
let skipped = 0;
let failed = 0;

for (const name of fs.readdirSync(ROOT).sort()) {
  const p = path.join(ROOT, name, "SKILL.md");
  if (!fs.existsSync(p)) continue;

  const original = fs.readFileSync(p, "utf8");
  const split = splitSkill(original);
  if (!split) {
    console.error(`  FAIL ${name}: no parsable frontmatter`);
    failed++;
    continue;
  }
  const read = readDescription(split.fm);
  if (!read) {
    console.error(`  FAIL ${name}: no description key`);
    failed++;
    continue;
  }

  if (read.start === read.end && !/^description:\s*[>|]/.test(split.fm[read.start])) {
    console.log(`  skip ${name}: already single-line (${read.desc.length} chars)`);
    skipped++;
    continue;
  }

  const unsafe = plainUnsafe(read.desc);
  if (unsafe.length) {
    console.error(`  FAIL ${name}: not plain-safe — ${unsafe.join("; ")}`);
    failed++;
    continue;
  }
  if (read.desc.length > 1024) {
    console.error(`  FAIL ${name}: description is ${read.desc.length} chars (max 1024)`);
    failed++;
    continue;
  }

  const fm = [
    ...split.fm.slice(0, read.start),
    `description: ${read.desc}`,
    ...split.fm.slice(read.end + 1),
  ];
  const rebuilt = ["---", ...fm, "---", split.body].join("\n");

  // Identity guard: re-read the description out of the rebuilt file and require it to
  // match byte for byte. The whole point is to change the encoding, never the text.
  const check = readDescription(splitSkill(rebuilt).fm);
  if (!check || check.desc !== read.desc) {
    console.error(`  FAIL ${name}: round-trip changed the description — not writing`);
    failed++;
    continue;
  }
  if (splitSkill(rebuilt).body !== split.body) {
    console.error(`  FAIL ${name}: body changed — not writing`);
    failed++;
    continue;
  }

  const warn = read.desc.length > 900 ? `  (WARN ${read.desc.length}/1024, thin headroom)` : "";
  if (apply) {
    fs.writeFileSync(p, rebuilt);
    console.log(`  ok   ${name}: folded → plain, ${read.desc.length} chars${warn}`);
  } else {
    console.log(`  plan ${name}: folded → plain, ${read.desc.length} chars${warn}`);
  }
  changed++;
}

console.log(
  `\n${apply ? "rewrote" : "would rewrite"} ${changed}, skipped ${skipped}, failed ${failed}`,
);
if (!apply) console.log("(dry run; pass --apply)");
process.exit(failed ? 1 : 0);
