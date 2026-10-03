# 001: Firstmate advisers for /stow, /updatefirstmate and backpass rounds

- Status: accepted (fork `Huy-Hieuu/compact-adviser` only)
- Date: 2026-10-03
- Scope: `packages/pi-extension` (Pi and omp); no other host

## Context

[firstmate](https://github.com/kunchenguid/firstmate) supervises a fleet of agent workers from a "home" checkout. Three of its maintenance actions have the same problem `/compact` had before this product: the person at the keyboard has to guess when to run them.

- `/stow` saves what the session learned (captain preferences, decisions, lessons, open work) into the home's memory files before a reset or compaction loses it.
- `/updatefirstmate` fast-forwards the home from `origin/main` and restarts the secondmates. It is safe only when nothing in the fleet is mid-flight.
- A backpass round mines recent agent sessions per repository into `AGENTS.md` and skill edits. Today a launchd job drops a firstmate inbox note every Sunday at 18:00, whether or not a repository has new material.

The captain asked for all three to be advised, or run automatically when chosen, using the machinery this product already has.

This is a departure from [VISION.md](../../VISION.md), which says the product "owns exactly one thing: the timing of `/compact`". The fork takes it on deliberately. The compact adviser itself is unchanged outside a firstmate home, and the new advisers are inert everywhere else, so the upstream product still behaves the same wherever firstmate is absent.

## Decision

### One adapter knows firstmate; everything else is reused

`src/firstmate-home.ts` is the only code that knows firstmate's on-disk layout. Every reader is read-only and needs no network, and each one answers "nothing" for a directory that is not a firstmate home.

- **Home detection** (`firstmateHome`) requires `bin/fm-inbox.sh`, `bin/fm-update.sh`, `.agents/skills/stow/SKILL.md`, `.agents/skills/updatefirstmate/SKILL.md` and a `state/` directory **at the session cwd itself**. Neither a subdirectory such as `projects/<repo>`, nor a worker worktree, nor `$FM_HOME` counts: workers inherit `$FM_HOME`, and only the session running in the home holds firstmate's memory. A home containing `.fm-secondmate-home` is a secondmate home. It gets stow advice only.
- **Update available** is read from firstmate's own `state/.tool-updates` cache (`fm-tool-updates-v1`), which `bin/fm-tool-update-check.sh` refreshes about every 15 minutes with read-only `ls-remote` probes. The adviser never fetches. A cache older than two hours, malformed, or without a `firstmate update available:` finding means no advice. `.git/refs/remotes/origin/main` is not used because only `fm-update.sh` fetches it, so it is routinely stale.
- **Fleet idle** has no flag in firstmate, so it is read from what firstmate leaves behind. The check covers the primary home and every secondmate home registered in `data/secondmates.md`. The fleet is busy when:
  - a `state/.control-<id>.lock` holds a live pid, which means `bin/fm-pr-merge.sh` is merging;
  - a live lane (one with a `state/<id>.meta` file) whose latest status event is `working` or `paused` names a hardware window (`hw-` id, hardware, downtime, maintenance window, `node.local`) or a release (release, publish);
  - a live lane is `paused` for validation (validation, verification, pipeline, no-mistakes, CI, checks, tests).

  These are keyword heuristics and they err toward "busy", so the cost of a false match is silence. `/firstmate-adviser status` names the lane that blocked the advice.
- **Backpass material** comes from `projects/` (each entry resolved to its real path) and from the agent's `sessions/<encoded cwd>/*.jsonl` directories. A session belongs to a repository when its header `cwd` is inside the checkout (the deepest checkout wins), is a git worktree whose `.git` points into it, or (for a worktree that has since been removed) sits under Orca's `orca/workspaces/<repo directory>/`. Commits are counted with `git rev-list --count --since` on `origin/main`, falling back to `HEAD`, from local refs only. A live `bp-*` lane whose meta `project=` resolves to the repository is an open round. Firstmate records no "last round", so the adviser keeps its own record (`<agentDir>/compact-adviser-backpass.json`). Each open round it sees is written there, and so is each note it drops.
- **Backpass auto** runs `bin/fm-inbox.sh note --request-id backpass-adviser-<year>-w<week>-<repos> -- <text>`, which is the same inbox note path the weekly job uses. The note names the repositories and the same `data/backpass-weekly/dispatch.py w<week>` command. The request id makes a repeat a replay. The plugin never runs backpass itself. The weekly launchd job stays as a fallback until the captain retires it.

The stow judgment reuses the compact judgment's TypeSafe transport (`ask`, extracted from `judge`), its `done` question verbatim, its response validation (`choice`), its snapshot (`snapshot`) and its sliding floor (`floorFor`). One question is new, `knowledge`: is there durable knowledge that is not yet written to a memory, notes or backlog file? Score = P(finished) × P(unsaved). It is a separate request, because the compact request body is byte-identical across four hosts (`lockstep.test.ts`) and must not grow a third question. The floor schedule is the compact one, so stow advice gets more eager as the context fills, which means before the host's own compaction.

Update and backpass are deterministic. They make no TypeSafe request.

### Gates, modes, consent and kill switches

Each adviser has the same modes as the compact adviser: `hint` (the default), `auto`, and `off`. Auto asks the same kind of first-use confirmation and saves `autoAcknowledged`. Settings live in `<agentDir>/compact-adviser-firstmate.json`, a separate file, because the shared `compact-adviser.json` validator drops unknown fields: an older version writing that file would silently erase these settings.

- `COMPACT_ADVISER_DISABLE` still beats everything: neither adviser family installs.
- `COMPACT_ADVISER_STOW_DISABLE`, `COMPACT_ADVISER_UPDATE_DISABLE` and `COMPACT_ADVISER_BACKPASS_DISABLE` each silence one adviser. They use the same truthy parse.

All three run at a settled checkpoint, with the compact adviser's local gates: TUI only, idle, no pending messages, an empty editor, and a final `stop` answer that has not been seen yet. Per adviser:

| Adviser | Checks before any network | Advice |
| --- | --- | --- |
| stow | mode, key, at least 20,000 context tokens (configurable), not snoozed; at least 3 exchanges and 10,000 new tokens since the last `/stow` | judged `stowDue`; hint "Run /stow", or auto sends `/stow` |
| update | primary home, a fresh firstmate finding not already run, the fleet idle | if `stowDue`: "Run /stow first, then /updatefirstmate" and auto waits; else hint "Run /updatefirstmate", or auto sends it once per finding |
| backpass | primary home; recounted at most every 30 minutes | for each repository with no open round, due when sessions ≥ 8 or commits ≥ 20 since its last round (both configurable; a repository with no record counts from a week back) |

A `/stow` or `/updatefirstmate` is observed as a user message on the branch, whether the person typed it or auto sent it (`/skill:stow` counts too). It clears `stowDue`, and for update it marks the current finding as done. Deterministic hints repeat for the same finding only after 10 exchanges. All hints share one widget (`compact-adviser:firstmate`), which is cleared on input like the compact hint.

### Stow comes first

- **Compaction the compact adviser starts:** the compact adviser awaits `stowFirst(ctx)` before its final gate. If stow is due, the hint becomes "Run /stow first, then /compact", and auto mode does not compact at that checkpoint.
- **Host compaction (manual, threshold or idle):** when stow is due and stow is in acknowledged auto mode, the first such compaction is cancelled once, `/stow` is sent, and the person is told to compact again. Overflow and retry compactions (`reason: "overflow"`, `willRetry: true`) are never held, because the turn cannot continue without them. In hint mode nothing is cancelled. The person gets one warning that the session is compacting before `/stow` ran.
- **Update:** never advised plainly, and never run automatically, while stow is due.

### Settle trigger on omp

omp, the Pi fork this fleet runs, has no `agent_settled` event: it is absent from the 18.4.12 binary. omp also still reports the session busy while `agent_end` handlers run. The firstmate advisers therefore treat a final `agent_end` (`willContinue` not `true`) as the checkpoint and wait up to 5 s for `isIdle()`. Once any `agent_settled` arrives, which marks a Pi host, `agent_end` is ignored. `snapshot()` falls back to `getBranch()` where omp lacks `buildContextEntries`.

## Consequences

- The fork's scope is wider than the product VISION states. The compact adviser's own behaviour, settings and lockstepped policy did not change. One exception: in a firstmate home its hint can name `/stow` first, and auto can skip a checkpoint.
- The stow question and its floor are **unmeasured**. VISION refuses unevaluated heuristics. The mitigations are that stow ships in hint mode, auto needs explicit consent, and the eval harness (`packages/pi-extension/eval/`) is the place to measure it before anyone tunes it.
- The fleet-idle checks are keyword heuristics over status prose. A lane that describes a release or a validation in words the patterns miss will not block an update. Status shows which lane blocked one when the patterns did match.
- The existing compact adviser listens only on `agent_settled`, so under omp it never fires. That is pre-existing and left unchanged here. The firstmate advisers do fire under omp.
- One extra TypeSafe request per eligible settled checkpoint in a firstmate home.

## Alternatives considered

- **Add `knowledge` to the compact request.** Rejected: it would fork the byte-identical cross-host body.
- **Cancel every compaction while stow is due.** Rejected: it fights the person's own `/compact`, and it breaks overflow recovery.
- **Run backpass from the plugin.** Rejected: dispatch is firstmate's job. The adviser only drops the note.
- **Honour `$FM_HOME` or walk up from cwd.** Rejected: workers and `projects/` clones would inherit the home.
- **Store settings in `compact-adviser.json`.** Rejected: older versions would strip the fields.

## Verification

- `npm run check` in `packages/pi-extension`:
  - `test/firstmate.test.ts` covers the adapter, the policy and the stow judgment;
  - `test/firstmate-adviser.test.ts` covers the host wiring;
  - the existing compact suite is unchanged and green.
- A live omp 18.4.12 check is throwaway by construction and leaves nothing installed. omp loaded the branch build for one process only (`omp --no-extensions -e packages/pi-extension/src/index.ts --no-tools --no-skills --no-session`), with `TYPESAFE_API_KEY` exported from the saved settings. That process ran in a fresh clone of the firstmate home (with an empty `state/`) and in a plain directory with the same `AGENTS.md`.
  - The stow hint fired in the clone and not in the plain directory, where `/firstmate-adviser status` reported the advisers inert.
  - After `/stow please`, the update hint appeared for a fresh `state/.tool-updates` finding.
  - `~/.omp/plugins` and `~/.omp/agent` were not modified. The npm plugin stayed at its installed version throughout, so there was nothing to restore.
