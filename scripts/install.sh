#!/usr/bin/env bash
# Link every skill in this repo into one or both hosts. Idempotent and self-verifying:
# safe to re-run, and it asserts the result instead of assuming the commands worked.
#
#   scripts/install.sh            # both hosts, whichever are present
#   scripts/install.sh claude
#   scripts/install.sh gemini
#
# Refuses to clobber an existing real directory: it reports and skips rather than delete
# work that might not be in this repo.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS="$REPO/skills"
WANT="${1:-both}"
rc=0
count() { ls -1 "$SKILLS" | wc -l | tr -d ' '; }

install_claude() {
  local dest="$HOME/.claude/skills" n=0 bad=0 name target
  [ -d "$HOME/.claude" ] || { echo "claude: no ~/.claude, skipping"; return 0; }
  mkdir -p "$dest"
  echo "claude: linking into $dest"
  for d in "$SKILLS"/*/; do
    name="$(basename "$d")"; target="$dest/$name"
    if [ -L "$target" ]; then
      [ "$(readlink "$target")" = "${d%/}" ] || { echo "  ! $name: link points elsewhere"; rc=1; }
      continue
    fi
    [ -e "$target" ] && { echo "  ! $name: real path exists at $target, not touching it"; rc=1; continue; }
    ln -s "${d%/}" "$target" && n=$((n+1))
  done
  echo "  linked $n new"
  for d in "$SKILLS"/*/; do
    name="$(basename "$d")"
    [ -r "$dest/$name/SKILL.md" ] || { echo "  ! $name: SKILL.md unreadable via $dest"; bad=1; }
  done
  if [ "$bad" = 0 ]; then echo "  verified: all $(count) readable through the link"; else rc=1; fi
}

install_gemini() {
  local n=0 missing=0 listed name
  command -v gemini >/dev/null 2>&1 || { echo "gemini: CLI not on PATH, skipping"; return 0; }
  echo "gemini: linking (--consent is required, or a scripted run hangs on a prompt)"
  for d in "$SKILLS"/*/; do
    name="$(basename "$d")"
    [ -L "$HOME/.gemini/skills/$name" ] && continue
    if timeout 60 gemini skills link "$d" --scope user --consent >/dev/null 2>&1; then
      n=$((n+1))
    else
      echo "  ! $name: link failed or timed out"; rc=1
    fi
  done
  echo "  linked $n new"
  # verify against what the host reports, not against the filesystem
  listed="$(cd /tmp && timeout 60 gemini skills list 2>/dev/null)"
  for d in "$SKILLS"/*/; do
    name="$(basename "$d")"
    grep -q "^$name \[" <<<"$listed" || { echo "  ! $name: not reported by 'gemini skills list'"; missing=1; }
  done
  if [ "$missing" = 0 ]; then
    echo "  verified: all $(count) reported by the host"
  else
    rc=1
  fi
  echo "  note: an interactive session needs /skills reload to see new skills"
}

case "$WANT" in
  claude) install_claude ;;
  gemini) install_gemini ;;
  both) install_claude; install_gemini ;;
  *) echo "usage: $0 [claude|gemini|both]"; exit 2 ;;
esac

[ "$rc" = 0 ] && echo "OK" || echo "FINISHED WITH PROBLEMS (see ! lines)"
exit "$rc"
