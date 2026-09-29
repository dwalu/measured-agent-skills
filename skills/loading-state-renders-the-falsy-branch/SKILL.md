---
name: loading-state-renders-the-falsy-branch
description: An in-flight query renders the component's negative branch, because data?.x and data?.x ?? [] cannot distinguish "not loaded yet" from "loaded and false or empty". One mechanism with three faces — a real user briefly sees the not-yet-configured UI and can act on it, a Playwright empty-state marker fires as a render gate while the page is still loading, and a test that waits on the wrong branch fails as "element was detached from the DOM, retrying" followed by a timeout. Use when a UI flashes the wrong state on load, when an E2E test is flaky around data arrival, when an empty-state testid is being used to wait for a page, or when a Playwright locator reports detached and you are about to blame a re-render loop.
---

# A still-loading query renders its falsy branch

One mechanism, three places it surfaces. Written against
**@tanstack/react-query v5** and **Playwright 1.49**.

```tsx
const levels = overview.data?.gradeLevels ?? [];   // [] while loading
mfaStatus.data?.totp.enrolled ? <Manage/> : <Enroll/>   // <Enroll/> while loading
```

**Optional chaining and `?? []` are `false`-shaped during the in-flight window.**
They cannot distinguish *not loaded yet* from *loaded, and the answer is no*. Every
consequence below is that one fact.

In React Query v5 the flag to gate on is **`isPending`** — "no data yet".
`isLoading` is the narrower derived form (`isPending && isFetching`). For the
never-loaded case they agree, but `isPending` is the canonical v5 term and the one
to reach for.

---

## 1. The product face: a user sees the negative branch and can act on it

A sign-in page rendering `mfaStatus.data?.totp.enrolled ? <manage> : <enroll>` with
no pending guard shows the **enroll** button to a user who *is* enrolled, for as
long as the query is in flight. That is a UI flash, which sounds cosmetic — until
the enroll endpoint has no already-enrolled guard of its own, at which point a
session that could never pass step-up can overwrite the second factor.

**The rule is not "add a spinner".** It is that **the UI is not the
authorization.** A branch that renders because data has not arrived is not a
decision anybody made, so any endpoint it can reach needs its own server-side
guard. Gate the render on `isPending` *and* guard the mutation — the first is
correctness, the second is the actual security boundary.

---

## 2. The test-authoring face: an empty-state marker is not a render gate

`data-testid="empty-grade-levels"` rendered on `levels.length === 0` appears
**while the page is still loading**, so waiting for it proves nothing about the
page being ready. The test then asserts against a page that has not settled, and
fails somewhere unrelated.

Two gates that do work:

- Wait for a marker rendered on the **loaded** branch — something that exists only
  once data has arrived.
- Render an explicit tri-state (`pending` / `empty` / `populated`) and wait for the
  state you mean, so "empty" is a fact rather than a default.

Note that `locator.count()` does **not** auto-wait — it returns whatever is true at
that instant, which is usually the loading branch. Neither does `evaluateAll`. Only
the assertion and action APIs retry.

---

## 3. The debugging face: "detached from the DOM" is usually a branch flip

Playwright's `element was detached from the DOM, retrying` followed by a timeout
most commonly means **the conditional branch flipped under you** — the element you
matched was rendered by the loading branch, and React replaced it when the data
arrived — not that the component is re-rendering in a loop.

Check the branch before you go looking for a loop: read the query's options for a
`refetchInterval` or an unstable key, and confirm whether the two branches render
different elements at the same position.

> This is a specific instance of a general discipline: **falsify the cause before
> you file it.** Asserting the re-render-loop reading here led to two tracking
> tasks that had to be withdrawn. `proof-and-verification` §1 has the general form
> — *record what you ruled out, not a guess.*

## Related

- `proof-and-verification` §2 — the neighbouring case, where absent markup is used
  to prove an *authorization* gate blocked something. Same "empty DOM is
  ambiguous" family, different fix: there you assert a render spy or a request log,
  because the two worlds are "mounted and returned null" versus "never ran". Here
  the two worlds are "still loading" versus "loaded and negative".
- `node-and-vitest-runtime` — the backend counterpart, where a failure is
  converted into a success signal rather than a branch.
