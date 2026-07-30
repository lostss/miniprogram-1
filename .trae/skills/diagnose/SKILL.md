---
name: diagnose
description: Rigorous diagnosis loop for hard bugs and performance regressions. Reproduce → Minimise → Hypothesise → Instrument → Fix → Regression-test. Use when user says "diagnose this"/"debug this", reports a bug, says something is broken/erroring/failing, or describes a performance regression.
---

# Diagnose

## Phase 1 — Build a feedback loop

This is the core skill. If you have a fast, deterministic, agent-runnable pass/fail signal that detects the bug, you can find the cause. If you don't, staring at code won't help.

Invest disproportionate effort here. **Be aggressive, creative, refuse to give up.**

Ways to build a feedback loop (try in roughly this order):
1. Write a **failing test** at a seam that reaches the bug.
2. Use **curl / HTTP scripts** against a running dev server.
3. Use **CLI invocation** with fixed inputs, diff stdout against known-good snapshots.
4. Use **headless browser scripts** (Playwright/Puppeteer).
5. **Replay captured traces**.
6. **One-shot test fixtures** — spin up minimal subset of system.
7. **Property/fuzz test loop** — run 1000 random inputs, look for failure patterns.
8. **Bisection tooling** — automate "start state X, check, repeat".
9. **Diff loop** — process same input through old vs new version.
10. **HITL loop script** — last resort. Script the human's clicks.

**Build the right feedback loop and the bug is 90% fixed.**

Iterate the loop itself: make it faster, more precise, more deterministic. A 2-second deterministic loop is a debugging superpower.

**Non-deterministic bugs:** target higher reproduction rate, not clean repro. 50% flaky is debuggable; 1% isn't.

**When you truly cannot build a loop:** stop, state it explicitly. List what you tried. Ask the user for environment access, captured artifacts, or permission for temporary production instrumentation.

**Do not enter the hypothesis phase without a loop.**

## Phase 2 — Reproduce

Run the loop, observe the bug. Confirm:
- [ ] The loop produces the failure the **user** described.
- [ ] The failure is repeatable (or has high enough rate for non-deterministic bugs).
- [ ] Exact symptoms are captured.

**Do not advance without reproduction.**

## Phase 3 — Hypothesise

Generate **3-5 ranked hypotheses** before testing any. Each must be **falsifiable**.

> Format: "If <X> is the cause, then <changing Y> makes the bug disappear / <changing Z> makes it worse."

Present the ranked list to the user before testing. They may reorder with domain knowledge.

## Phase 4 — Instrument

Each probe must answer one specific prediction from Phase 3. **Change one variable at a time.**

Tool preference:
1. **Debugger / REPL inspection** — a breakpoint beats ten logs.
2. **Targeted logging at hypothesis boundaries.**
3. Never "log everything and grep".

Tag debug logs with unique prefix like `[DEBUG-a4f2]`. Clean up at the end.

## Phase 5 — Fix + Regression test

Write the regression test **before** the fix — but only if there's a **correct seam**.

If no correct seam exists, that's a finding. Document it.

If a correct seam exists:
1. Turn minimal repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix.
4. Watch it pass.
5. Re-run Phase 1 loop on the original scenario.

## Phase 6 — Cleanup & Retrospective

- [ ] Original repro no longer occurs
- [ ] Regression test passes (or seam gap documented)
- [ ] All `[DEBUG-...]` instrumentation removed
- [ ] Throwaway prototypes deleted
- [ ] Hypothesis proven correct noted in commit/PR message

**Then ask: what would have prevented this bug?** Hand off to `/improve-codebase-architecture` if architecture changes are needed.
