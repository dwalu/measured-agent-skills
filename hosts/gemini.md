# Gemini CLI / Antigravity specifics

Read with `../AGENTS.md`. Everything here was verified against **Gemini CLI v0.46.0**
installed locally, not taken from docs.

## Install

```bash
gemini skills link ./skills/<name> --scope user --consent
gemini skills list                      # confirm it appears, Enabled
```

Three things that are easy to get wrong:

- **`--consent` is not optional in a script.** Without it the command opens an
  interactive confirmation and a non-interactive run **hangs indefinitely** rather than
  failing. That is a hang, not an error, so it looks like a slow install.
- `link` creates a real **symlink** into this repo (verified with `readlink`), so edits
  here are live. `install` copies and will drift.
- After installing, an interactive session needs `/skills reload` before the new skill is
  visible; the agent cannot run that for you.

For a consumer with no checkout, skills are installable straight from the repo:

```bash
gemini skills install <git-url> --path skills
```

## Context files

Default name `GEMINI.md`; the `context.fileName` setting accepts an **array**, so one
file can serve several hosts:

```json
{ "context": { "fileName": ["AGENTS.md", "GEMINI.md"] } }
```

Global `~/.gemini/GEMINI.md` and workspace files are **concatenated into every prompt**.
Keep them minimal and let skills carry the depth — see the budget below.

Antigravity CLI reads `AGENTS.md` natively and adds activation modes (`always_on`,
`model_decision`, `glob`, `manual`). It also enforces hard limits: **24 KB per rules file
and a 20,000-token aggregate budget** for everything always-on. This corpus is ~40–45k
tokens, so **bundling the skills into a context file is not merely wasteful, it does not
fit.** As skills the always-on cost is only the ~7 KB of metadata.

## The validator is blind to a folded description — and still says it is valid

Gemini ships `builtin/skill-creator/scripts/validate_skill.cjs`, which reads the
description with:

```js
/^description:\s*(?:'([^']*)'|"([^"]*)"|(.+))$/m
```

Against `description: >-` (a YAML folded block scalar) that captures the literal string
**`">-"`** — two characters — and then prints `✅ Skill is valid!`. So it cannot enforce
the 1024-character limit, and a description that quietly grew past the limit would still
validate.

The **runtime** is fine: `parseFrontmatter` calls a real YAML loader first and only falls
back to a regex if that throws. So a folded description loads correctly and the skill
triggers normally — I confirmed a 972-character folded description round-trips into
`gemini skills list` in full.

Two consequences, both already handled in this repo:

1. Every description here is a **single-line plain scalar**, so the host validator sees
   the real text and its length check works. Plain rather than quoted on purpose:
   several descriptions contain double quotes, and the validator's quoted branches stop
   at the first quote.
2. `scripts/validate.mjs` folds block scalars properly and fails above 1024 while warning
   above 900, because two descriptions sit at 972 and 942 with little headroom.

## Known collision

Antigravity global rules and Gemini CLI global context **both write
`~/.gemini/GEMINI.md`** (gemini-cli issue #16058). Prefer workspace-scoped
`.agents/skills/` and a per-repo `AGENTS.md` over anything global.

## Which CLI

Gemini CLI consumer request-serving was retired in favour of Antigravity CLI (`agy`)
while the open-source CLI remains maintained. `.agents/skills/` is read by **both**, so
the artifact survives the transition; only the install path differs:

| | Gemini CLI | Antigravity CLI |
|---|---|---|
| global skills | `~/.gemini/skills/` | `~/.gemini/antigravity-cli/skills/` |
| workspace skills | `.gemini/skills/` | `.agents/skills/` |
