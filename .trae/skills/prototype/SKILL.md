---
name: prototype
description: Build a throwaway prototype to flesh out a design before committing to it. Routes between two branches — a runnable terminal app for state/business-logic questions, or several radically different UI variations toggleable from one route. Use when the user wants to prototype, sanity-check a data model or state machine, mock up a UI, explore design options.
---

# Prototype

A prototype is **throwaway code that answers a question**. The question decides the shape.

## Pick a branch

- **"Does this logic / state model feel right?"** → Build a tiny interactive terminal app.
- **"What should this look like?"** → Generate several radically different UI variations, switchable via URL param.

## Rules

1. **Throwaway from day one, clearly marked.** Locate prototype code near where it will be used. Name it so a casual reader sees it's a prototype.
2. **One command to run.** The user must be able to start it without thinking.
3. **No persistence by default.** State lives in memory.
4. **Skip the polish.** No tests, no error handling beyond what makes it runnable, no abstractions.
5. **Surface the state.** After every action, print/render the full relevant state.
6. **Delete or absorb when done.** Capture the answer somewhere durable (commit message, ADR, issue, or NOTES.md).
