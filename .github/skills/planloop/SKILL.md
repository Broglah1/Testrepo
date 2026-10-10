---
name: planloop
description: Run planloop (Plan → Build → Review with the planner and the judge) in this repository — from a terminal or from VS Code Copilot chat — and the pull-request description contract builders must follow (Decisions, Follow-ups, planloop-status classifications).
---

# planloop

planloop is driven from outside Copilot by a CLI (`planloop/` in the copilot-planloop repo). It
calls Copilot one turn at a time, validates every reply in code, keeps all state itself, and decides
every transition. The models never decide a transition.

## Running it

Prerequisites: Node ≥ 22, `git`, `gh` (authenticated), and the Copilot CLI (`npm i -g @github/copilot`).
Install the driver once with `cd <copilot-planloop>/planloop && npm install && npm link`, which puts a
`planloop` command on PATH. Run every command from the root of a clean checkout of this repository
(normally `main`).

**The complete, current command list is `planloop help`.** When the user asks which planloop
commands exist — or types `/planloop` with nothing after it, or with a first word that is not a
command in that list (`/planloop add a login page`) — run `planloop help` and show its output
verbatim in a code block. Do not paraphrase it, rebuild it as a table, or guess which command they
meant. In short:

- `planloop pbr [--dry|--auto-approve] <task>` — Plan → Build → Review. Never merges.
- `planloop plan [--dry|--auto-approve] <task>` — plan only, then one build turn (edits left uncommitted).
- `planloop intake "<task>"`, `planloop answer <Qn> <option number | own words>`, then
  `planloop pbr --intake` (or `plan --intake`) — answer the planner's up-front questions across separate
  commands, then plan with them.
- `planloop qa [--dry|--auto-approve] [pr]` — the judge reviews an existing PR until clean.
- `planloop qa-preview <pr>` — what a review would cover, with no model calls.
- `planloop approve-plan`, `planloop revise-plan [feedback]`, `planloop deny-plan` — decide on the pending plan.
- `planloop resume [--auto-approve]`, `planloop cancel`, `planloop clean` — recover or stop a run.
- `planloop board`, `planloop board-intake`, `planloop board-run`, `planloop board-move <issue> <column>` — the board.
- `planloop bootstrap` — install the reviewed hooks, agents and this skill on the default branch.

Models: each role runs on a pinned model — `planloop/planloop.config.json` `models`, or
`PLANLOOP_MODEL` (all roles) / `PLANLOOP_MODEL_PLANNER` / `_JUDGE` / `_BUILDER`; unset roles use the
driver's built-in defaults. planloop refuses every Fable, Astra and Opus fast-mode model and `auto`.

## Driving planloop from VS Code Copilot chat

**Always add `--no-input` to every planloop command you run** (for example
`planloop intake --no-input "<task>"`). Your terminal looks interactive to planloop, so without the
flag some commands type-prompt in it: the planner's up-front questions (plain `pbr`/`plan`,
`board-intake`), `revise-plan` with no feedback, a clarifying question mid-run, and the "Type
`approve`" gate for leftover findings. Those are the user's decisions. Never answer a planloop
prompt in the terminal yourself, even if VS Code offers to reply for you. With `--no-input` nothing
prompts: up-front questions go through `intake` / `answer` (`board-intake` records the recommended
options instead), plan changes through `revise-plan <feedback>`, leftover findings through
`resume --auto-approve`, each run only after asking the user, and a mid-run question is recorded as
unanswered.

When the user asks you (the VS Code chat agent) to run planloop, run the commands above in the
terminal from the repository root, one at a time, in the foreground. Each can take several minutes;
wait for it to exit and read everything it printed. Never type into a running planloop process — it
takes no input from you; every human decision goes through the separate commands below.

- **Plan → Build → Review** (`/planloop pbr <task>` or "run planloop on …"):
  1. Run `planloop intake "<task>"`. Show the user every question it prints with all its options,
     and ask them to choose (use the ask-questions tool if you have it). Never answer for them.
  2. For each answer run `planloop answer <Qn> <option number>` or `planloop answer <Qn> <their words>`.
     Questions they skip use the recommended option.
  3. Run `planloop pbr --intake`. Show the user the full plan and intent brief it prints, then ask:
     approve, revise (with what feedback), or deny. Run `planloop approve-plan`,
     `planloop revise-plan <feedback>` or `planloop deny-plan` accordingly. After approve-plan the
     driver builds, opens the PR and runs the judge's review rounds by itself; report the result lines.
- **Review an existing PR**: `planloop qa <pr>`.
- **Paused review with residual findings**: tell the user, and run `planloop resume --auto-approve`
  only if they explicitly accept the residuals; otherwise `planloop resume`.
- **Board** (see "The board" below for where cards come from):
  1. `planloop board` — sync and show it. Cards are created from unchecked `docs/TODO.md` lines that
     name a spec (`Spec: \`docs/specs/….md\` §1 "…"`); any other open issue sits in Triage until
     `planloop board-move <issue> backlog` makes it a card. Do not create issues by hand for this.
  2. `planloop board-intake` — runs the planner's intake for every Backlog card and posts the brief on each.
     It cannot take answers from chat: every question is recorded "not answered — use the recommended
     option". Tell the user so; they can edit a card's brief comment on GitHub before the next step.
  3. `planloop board-run` — builds the Ready cards one at a time (plan approved by the judge, PR with
     `Closes #N`, the TODO line ticked, the judge's review) and leaves each approved card in Needs you.
  4. Report each card's Needs-you comment; the user merges. `planloop board` afterwards moves merged
     cards to Done.

Rules: never merge a pull request and never run `gh pr merge` (the repository's deny hook blocks it;
report the denial instead of working around it). Never edit `.github/hooks/`, `.github/agents/` or
this skill to make a run pass. If planloop refuses to start because the checkout has uncommitted
changes, tell the user — do not stash or commit their work yourself. Never check out another branch
(including a planloop PR's branch) in this checkout: planloop builds from the checkout's current
commit, so it must stay on `main`. planloop builds and reviews in its own worktrees; to inspect a PR
use `gh pr view <n>` and `gh pr diff <n>`, and to run its tests ask the user first.

## The board

Labels are the source of truth: `planloop` plus one of `pl:backlog`, `pl:ready`, `pl:in-progress`,
`pl:needs-you`, `pl:done`. Work enters as an unchecked `docs/TODO.md` line with a `Spec:` reference
(usually added in a docs PR first), or as an existing issue moved with `board-move <issue> backlog`.
Columns: Backlog → (`board-intake`) Ready → (`board-run`) In progress → Needs you → (merge) Done.
`board-move <issue> <backlog|ready|needs-you|in-progress|done>` moves a card by hand.

## Roles

- **Planner** (`.github/agents/planner.agent.md`): read/search tools only.
- **Judge** (`.github/agents/judge.agent.md`): read/search tools only — no shell, no write.
- **Builder**: Copilot's default agent, in a driver-owned sanitized workspace. The preToolUse hook
  (`.github/hooks/planloop.json`) denies `gh pr merge`, merges into main, pushes to anything but the
  PR head, and every force push. Merging is always the human's action.

## Pull-request description contract (builders)

- **Decisions** — every choice you made that the plan or brief did not decide, plus any small
  out-of-scope fix you made in a file this PR already changes (a few lines, no behaviour change
  outside the card, no schema change beyond the plan).
- **Follow-ups** — every other problem you noticed but did not fix: one bullet each, saying what is
  wrong, where (path and symbol), and why it matters. Omit the heading if there are none. On a board
  card planloop files them as one checklist issue in Triage.
- Board cards: put `Closes #N` in the description and tick the card's `docs/TODO.md` line.

## Classifying a review finding instead of fixing it

Reply to the finding's thread (or `gh pr comment <pr>` for a file-level finding) with:

```
planloop-status: out-of-layer | accepted-residual | product-decision
rationale: <why>
ref: <issue or URL>            (optional)
finding: <pl-id>               (file-level findings only)
```

Only classifications from the account the driver runs as are accepted. A classified finding stops
blocking and goes to the human's residual gate; a human reply `planloop-status: reopen` reopens it.
