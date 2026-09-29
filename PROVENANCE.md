# What "measured" means here, and why it is stated

These skills are not a style guide. Nearly every claim in them is a **measurement**: a
command that was run, an exact error string that was printed, a byte count or a timing
that was observed. That is the whole reason they are worth carrying between hosts — an
agent can re-derive advice, but it cannot re-derive a number it has never seen.

So the conventions below are load-bearing, not decoration.

## Read the version stamps

Behaviour that depends on a version says so. `postgres-behaviour` and `prisma-behaviour`
each end with a `## Version dependence` section; the measurements were taken on
**PostgreSQL 16 / 16.14**, **Prisma 6.19.3**, **Node v26.10.0**, **Vitest 3.2.7 / Vite
7.3.6**, **TypeScript 5.9.3**, and shell claims are labelled per shell (**bash 5.3.20**,
**zsh 5.9.2**, **fish 4.9.3**) because they genuinely diverge.

A claim without a stamp was observed on the version above and is not known to be
version-specific. That is weaker than a stamp, and is phrased that way on purpose.

## Ratios are findings; absolutes are ranges

Where a number was taken more than once, the ratio held and the absolute did not. Two
runs of the same throughput probe twenty minutes apart on one laptop disagreed **3× on
the ceiling while the ratios did not move at all**. So the skills report ratios as
conclusions and absolutes as ranges, and size from the low end.

## The retractions are part of the content

Six claims in this corpus turned out to be false, and each was found the same way — not
by re-reading, but by being forced to re-measure or to read two notes against each other.
They are documented rather than quietly deleted, because a consumer who re-derives a
retracted claim pays the cost again:

| claim | reality |
|---|---|
| A custom-format archive written to a seekable file is ~2× the same dump to a pipe ("the TOC is written twice") | **Byte-identical** — 393,262 both ways compressed, 1,106,046 uncompressed, on the same 571-entry schema. The stated mechanism cannot produce a doubling: seeking back to rewrite the TOC overwrites bytes. |
| A restore that ignored errors exits 0 | **Exits 1.** `--exit-on-error` controls abort-versus-continue, not the exit status. Verified on 16.14. |
| `git checkout HEAD -- <paths>` is an alternative to `git stash push -- <paths>` | They are not interchangeable. Stash captures before removing; checkout discards with no capture, destroying exactly the uncommitted work a later restore was meant to return. |
| Under a jsdom test environment `import.meta.url` is an `http` URL | It is **always** `file:`. Vite rewrites the *literal* `new URL(rel, import.meta.url)` pattern against the page location; capturing the value into a variable first defeats the rewrite. |
| A list of required CI status checks, given as five | There were **eight**. An incomplete enumeration under a heading that said "never rename a CI job" would have told a reader that renaming three of them was safe. |
| An uplink of ~250 KB/s, quoted for weeks | **~550 KB/s**, re-measured off the first publish that actually succeeded. Numbers remembered from failed runs are a biased sample. |

The pattern in all six is the same, and it is the thesis of `proof-and-verification` §1:
**the measurements held up and the reasoning did not.** Every error was a claim about how
two things relate — a cause, a quantifier, a severity — not a claim about whether
something exists.

## If you change a skill

- Keep measurements verbatim. A number retyped is a number that can drift, which is how
  the uplink figure came to be asserted three different ways in three places.
- If you cannot reproduce a claim, say so in the skill rather than deleting it. "Did not
  reproduce on X" is itself a measurement.
- Run `node scripts/validate.mjs` and its `--self-test`. The section-number
  cross-references are a contract: 8 of 11 skills cite `proof-and-verification`, several
  by section.
