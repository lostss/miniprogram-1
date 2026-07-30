---
name: setup-matt-pocock-skills
description: Sets up an `## Agent skills` block in CLAUDE.md/AGENTS.md and `docs/agents/` so the engineering skills know this repo's issue tracker, triage label vocabulary, and domain doc layout. Run before first use of `to-issues`, `to-prd`, `triage`, `diagnose`, `tdd`, `improve-codebase-architecture`, or `zoom-out`.
disable-model-invocation: true
---

# Setup Matt Pocock's Skills

Scaffold the per-repo configuration that the engineering skills assume:

- **Issue tracker** — where issues live (GitHub by default; local markdown also supported)
- **Triage labels** — the strings used for the five canonical triage roles
- **Domain docs** — where `CONTEXT.md` and ADRs live

## Process

### 1. Explore

- `git remote -v` — is this a GitHub repo? Which one?
- `AGENTS.md` / `CLAUDE.md` — does either exist?
- `CONTEXT.md` / `CONTEXT-MAP.md` at the repo root
- `docs/adr/` directories
- `docs/agents/` — prior output already exist?

### 2. Present and ask (one section at a time)

**Section A — Issue tracker.** Default: GitHub if remote points there. Options: GitHub, GitLab, Local markdown (`.scratch/`), or Other.

**Section B — Triage label vocabulary.** Five canonical roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. Ask if any need custom label strings.

**Section C — Domain docs.** Confirm layout: single-context (one `CONTEXT.md` at root) or multi-context (`CONTEXT-MAP.md`).

### 3. Write

Pick file to edit: `CLAUDE.md` (preferred) or `AGENTS.md`. Never create one when the other exists.

Create `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`.

Add `## Agent skills` block to the chosen file with summaries and links to the docs.
