# Parallel dispatch — what the evidence actually shows (2026-09-28 / 29)

Whether the builders of the orchestration-enforcement task ran **concurrently** rather
than one after another, recorded by the lead observing the filesystem.

**An earlier version of this document overclaimed and a senior reviewer caught it.** It
asserted that write events interleave and run windows overlap "in every round"; that is
true of one round of four. The corrected position is below. The overclaim is left on the
record rather than quietly rewritten, because a proof document that inflates its own
result is worth less than a smaller honest one.

## Method

Each round's sub-agents were dispatched in a **single tool-call block**. A sampler
(`stat -c %Y` every 2 s, started before dispatch) recorded the modification time of each
builder's target file. A write event below is a change in that file's mtime — the lead
watching the disk, not an agent claiming progress. Run windows, where given, come from
the harness's own `duration_ms`, which the lead does not author.

Roughly 1,900 samples over five rounds. The raw CSVs lived in the session scratchpad and
are **not committed**, so the timestamps here are not independently re-derivable after
the fact. The event lists are reproduced in full; that is the part that carries whatever
argument this document makes.

## What each round proves

| Round | Evidence | Verdict |
|---|---|---|
| One | Interleaved writes **plus** harness run windows for all three builders | **Concurrency shown** |
| Two | Write events only, sorted by agent; no run windows | Consistent with concurrency, **does not prove it** |
| Three | Three agents' writes interleaved within 26 s | **Concurrency shown** |
| Four | Write events only, sorted by agent; no run windows | Consistent with concurrency, **does not prove it** |
| Five | Not sampled | No evidence recorded |

Two rounds of four sampled carry a real proof. The other two are consistent with parallel
dispatch and with serial execution alike, and are recorded as such.

## Round one — dispatched 21:50:39

| Assignment | Model | Window (harness `duration_ms`) |
|---|---|---|
| B1 | **opus** | 21:50:40 → 21:56:31 (351 s) |
| B2 | **sonnet** | 21:50:40 → 21:55:55 (315 s) |
| B3 | **sonnet** | 21:50:40 → 22:00:58 (618 s) |

```
21:51:51 … 21:53:16   B1(opus)    scripts/team_plan_check.cjs          (12 writes)
21:54:45              B2(sonnet)  tests/release_tools/team_plan_check.test.cjs
21:55:45              B3(sonnet)  CLAUDE.md
21:56:00 … 21:56:33   B3(sonnet)  docs/CLAUDE_TEAM_LEAD.md             (4 writes)
```

At 21:55:45 all three were alive: B1 had 46 s left, B2 had 10 s left, B3 was writing. B2's
write at 21:54:45 falls inside B1's window. This rests on one observed write plus two
harness-reported windows — the windows are the load-bearing part and they are not
filesystem observation.

## Round two

```
22:27:13   C4(opus)    .github/workflows/backend-quality-gates.yml
22:27:13   C4(opus)    package.json
22:27:28   C4(opus)    .github/workflows/backend-quality-gates.yml
22:29:37   C1(opus)    scripts/team_plan_check.cjs
22:29:47 … 22:30:41    C3(sonnet)  docs/CLAUDE_TEAM_LEAD.md            (6 writes)
```

The events are fully ordered by agent (C4, then C1, then C3) and C2 never appears in the
sampled window. That is exactly the shape serial execution produces. **No concurrency is
demonstrated here.** The agents were dispatched in one block and their handbacks arrived
interleaved, but this document only claims what the samples show.

## Round three — the one that proves it

```
23:09:54 … 23:13:37    D1(opus)    scripts/team_plan_check.cjs
23:13:46 … 23:15:37    D2(sonnet)  tests/release_tools/team_plan_check.test.cjs
23:16:19               D3(opus)    docs/CLAUDE_TEAM_LEAD.md
23:16:43               D1(opus)    scripts/team_plan_check.cjs
23:16:45               D3(opus)    docs/CLAUDE_TEAM_LEAD.md
23:17:28               D2(sonnet)  tests/release_tools/team_plan_check.test.cjs
```

D1's write at 23:16:43 falls **strictly between** two of D3's (23:16:19 and 23:16:45), and
D2 writes on both sides of that span. Three agents, three files, interleaved at
sub-minute granularity. Serial execution cannot produce this ordering.

## Round four

```
23:55:34 … 23:55:48    E3(sonnet)  docs/CLAUDE_TEAM_LEAD.md
23:56:49               E1(opus)    scripts/team_plan_check.cjs
00:00:34               E2(sonnet)  tests/release_tools/team_plan_check.test.cjs
```

Again fully ordered by agent, no run windows captured. **No concurrency demonstrated.**

## Why the writes never collided

Each builder held a disjoint set of paths, declared in its plan and checked by
`scripts/team_plan_check.cjs` before dispatch — `writer_overlap` reports zero for rounds
one, two and three. Rounds **four and five have no plan file at all** (see below), so for
those the disjointness was enforced only by the packets the lead wrote, and verified
after the fact from `git status`: every changed file mapped to exactly one assignment's
grant. That is weaker than a checked plan and is recorded as such.

The guarantee is **static**, from the plan, not a runtime sandbox. There is no guard
enforcing a builder's `forbidden` list inside a shared worktree, which
`docs/CLAUDE_TEAM_LEAD.md` states plainly.

## Process failures this document is evidence of

- **Round three** was dispatched before its plan was written and checked.
- **Rounds four and five** were dispatched with **no plan file at all**, in the change
  whose own `CLAUDE.md` addition says a plan that does not print `TEAM_PLAN_PASS` is not
  dispatched. Round four's omission was found by a senior reviewer, not by the lead.
- The all-plans pinning control therefore has no row for rounds four or five: they are the
  rounds with no machine-checked coordination artefact.

All three are also recorded in the `claude` slot of `PROJECT_STATUS.md`.
