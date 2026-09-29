# measured-agent-skills

[![License](https://img.shields.io/github/license/dwalu/measured-agent-skills)](LICENSE)

*An independent project. Not affiliated with or endorsed by Anthropic or Google.*

Portable engineering knowledge as [Agent Skills](https://agentskills.io) — `SKILL.md`
files with YAML `name`/`description` frontmatter, loaded on demand by the host agent
rather than pasted into every prompt.

**This repo is the single canonical copy.** Both hosts read it through symlinks, so there
is no export step and no drift: edit a skill here and Claude Code and Gemini CLI both see
the change immediately.

## What is in here

| | |
|---|---|
| `skills/` | 11 host-neutral skills. No project identifiers — enforced by the validator. |
| `AGENTS.md` | Always-on working preferences. Deliberately short; the depth is in skills. |
| `hosts/` | The per-host half: install paths, permission models, and each host's quirks. |
| `PROVENANCE.md` | What "measured" means here, and the corrections that shaped it. |
| `scripts/` | Validator, description normaliser. |

Repo-scoped skills — ones that name a particular project's tasks, hosts or workflows —
deliberately do **not** live here. They belong in that project's own repository under
`.claude/skills/`, versioned alongside the code they describe. The validator fails any
skill under `skills/` that names a project, so the boundary is enforced rather than
merely intended.

The skills:

`ci-merge-gates` · `container-image-delivery` · `loading-state-renders-the-falsy-branch`
· `node-and-vitest-runtime` · `pg-dump-and-restore` · `postgres-behaviour` ·
`prisma-behaviour` · `proof-and-verification` · `self-hosted-ci-runners` ·
`shell-and-git-forensics` · `work-tracking`

`proof-and-verification` is the hub — 8 of the other 10 point at it. If you read one,
read that one.

## Install

**Claude Code** — see `hosts/claude-code.md`:

```bash
for d in skills/*/; do ln -s "$PWD/$d" ~/.claude/skills/"$(basename "$d")"; done
```

**Gemini CLI** — see `hosts/gemini.md`. Note `--consent`, without which a scripted
install hangs on an interactive prompt rather than failing:

```bash
for d in skills/*/; do gemini skills link "./$d" --scope user --consent; done
gemini skills list
```

**Anywhere else** — a skill is a directory with a `SKILL.md`. Point your host at
`skills/` however it expects, or just read the files.

## Verify

```bash
node scripts/validate.mjs              # spec + this repo's own rules
node scripts/validate.mjs --self-test  # prove the validator's failure paths fire
```

The self-test matters more than the validation run. A validator whose failure path is
untested is exactly the defect `proof-and-verification` §4 is about, so each case asserts
the **specific** message and a positive baseline guards against a harness that fails
everything.

`scripts/normalize-descriptions.mjs` rewrites a folded `description: >-` into a
single-line plain scalar. That is not cosmetic: Gemini's bundled validator reads a folded
description as the literal string `">-"` and then reports the skill valid, so the
1024-character limit silently goes unchecked. `hosts/gemini.md` has the detail.

## Conventions

- `SKILL.md` body under 500 lines; detail moves to `references/` with a pointer saying
  when to read it. Reference files over 100 lines carry a table of contents.
- `scripts/` for executables, `references/` for on-demand prose, `assets/` for templates.
- `$SKILL` in a skill body means that skill's own directory; the host prints it on
  activation.
- Cross-references use the bare skill name and, where useful, a section number. The
  validator fails a `§N` pointing at a section that does not exist — so section numbering
  is a contract, not formatting.

## License

[MIT](LICENSE). Reuse, adapt and redistribute freely, including commercially;
keep the copyright notice.

One caveat that is not a legal one: the value here is that the claims were
measured, on the versions `PROVENANCE.md` stamps. A copy that drifts from its
measurements is worse than no copy, so if you change a claim, re-measure it — and
if you cannot reproduce one, say so in the skill rather than deleting it. "Did not
reproduce on X" is itself a measurement.
