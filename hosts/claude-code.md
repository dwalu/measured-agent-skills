# Claude Code specifics

Read with `../AGENTS.md`. This file holds only what depends on Claude Code itself.

## Install

Skills live at `~/.claude/skills/<name>/SKILL.md`. This repo is the canonical copy, so
each one is a **symlink** into it rather than a duplicate:

```bash
ln -s "$PWD/skills/<name>" ~/.claude/skills/<name>
```

Verified: Claude Code follows the symlink for both discovery and invocation, so a single
file serves this host and Gemini simultaneously and drift is structurally impossible.

Put `AGENTS.md`'s content at `~/.claude/CLAUDE.md` (Claude Code does not read
`AGENTS.md`), or keep a symlink so the two cannot diverge.

## When a command is refused by the permission classifier

Host-level VM/daemon lifecycle commands and `DROP DATABASE` are refused in auto mode, in
both compound and bare form. Reads in the same shape usually go through, so diagnosis is
mine and only the mutation is blocked.

**Do not retry the command in a different shape** — two retries burn a round trip each
and change nothing. Write the whole sequence to a script in the session scratchpad, then
ask me to run `! bash <path>`; the `!` prefix runs it in-session so the output lands in
the conversation.

- Make the script **idempotent and self-verifying** — it may be run once and not easily
  re-run.
- **A check that also passes on the broken state proves nothing.** An "is the mount
  gone?" test using `ls <path>` succeeded on the empty mountpoint that survives an
  unmount, and reported failure on a step that had worked.
- Fold the read-only assertions into the end of the same script rather than a follow-up
  turn, and keep destructive preconditions in it too.

## Harness facts worth knowing

- **The Bash tool's shell is zsh**, not fish — `$0` and `ps -p $$ -o comm=` both report
  zsh, `ZSH_VERSION` is set. This matters because the shell decides several failure
  modes; see `shell-and-git-forensics` §6 and `proof-and-verification` §5, where each
  claim is labelled per shell.
- zsh does **not** word-split unquoted variables, so a `for` loop over a captured
  multi-word string silently iterates once. Bitten three times in one session.
- A no-match glob **aborts the command** under zsh (bash passes the literal through), so
  a one-glob negative result can be "nothing ran" rather than "nothing found".
