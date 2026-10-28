# Walkthrough — Plan

## Vision

Claude-driven interactive code walkthroughs. Opens files, highlights code, shows inline explanations, narrates with TTS. Works standalone via npm or embedded in cockpit.

## Current Status

**v0.4.0** — Tool surface consolidated from 8 → 5 tools. Merged `explain_code`, `clear_explanations`, `walkthrough_status` into `walkthrough` (dispatches by args: 1-step-with-explanation → inline explain, 1-step-no-explanation → highlight only, N-steps → tour, `action: "clear"` → clear bubbles, `action: "next|prev|goto|stop|pause|resume"` → navigate, empty → status). Kept `show_code` as the ergonomic quick-highlight alias. Renamed `walkthrough_voice` → `walkthrough_voice_selection`. Dispatch logic lives in `src/use-cases/walkthrough-dispatcher.ts` as `WalkthroughDispatcherUseCase` (class with `execute()`, discriminated union result, pure — matches the architecture skill's use-case shape and project-organization skill's naming conventions). `makeSUT()` factory in tests. `WalkthroughStep.explanation` now optional. Tool descriptions rewritten using the `tool-descriptions` skill (3–4 sentence template + sibling disambiguation + explicit "proper usage: highlights[] for multi-point steps, no numbered lists for TTS").

**v0.3.1** — Coordinator is a position-based state machine (`stepIndex`, `phase`, `highlightIndex`). Computes `WalkthroughState` on demand, pushes via a latest-value slot (no stale queue). Shell subscribes with `for await`, calls `coordinator.next("auto")` after each state. Manual `next("manual")` / `prev("manual")` invalidate the pending auto via `skipNextAuto`. Status label shows `Step N/M · Highlight X/Y` during highlights. Selection clears on stop; file switch delay is 150ms.

## Bugs

- [x] **TTS reads literal `\n\n` aloud** — fixed, `stripMarkdown` converts escaped newlines and all newlines to spaces
- [x] **Walkthrough state dies between MCP tool calls** — fixed, narration loop exits when voice is off instead of racing through all steps
- [x] **TTS plays without bridge connection** — fixed, checks bridge result before starting narration
- [x] **`explain_code` doesn't highlight lines** — fixed, explanations don't refocus terminal so selection stays visible
- [x] **Auto-advance delay not configurable** — fixed, `autoplay` and `autoplayDelay` added to persisted config
- [x] **Unguarded `JSON.parse` in socket handler** — fixed with try/catch + 400 response
- [x] **Trusted markdown renders LLM command URIs** — fixed, sanitization in `explanations.ts`
- [x] **PowerShell metacharacter injection in TTS** — fixed, uses EncodedCommand
- [x] **VS Code engine mismatch** — both now at `^1.100.0`
- [ ] **`goto`, `pause`, and `resume` silently no-op in the extension** — the dispatcher, bridge, and MCP server all forward these actions correctly, but `vscode-extension/src/extension.ts:113–122` only handles `next`/`prev`/`stop` and falls through to `return { ok: true }` for everything else. Result: caller gets success, nothing happens. `goto` without a step is a no-op of a no-op. Needs: wire the three missing actions into the coordinator (pause/resume block the auto-advance loop; goto jumps to `step` and validates bounds, with a sensible default — either reject without a step or jump to 0).

## Next

### Autoplay
- Add `autoplay` and `autoplayDelay` to persisted config
- `autoplay: true` = auto-advance + auto-navigate. Manual next/prev still work as overrides (cancel current TTS, jump immediately).
- `autoplay: false` = manual next/prev only. TTS still plays per step if voice is on.
- Step wait time when autoplay is on: `max(tts_duration, reading_time) + autoplayDelay`
  - `tts_duration` — actual time TTS takes to finish
  - `reading_time` — estimated visual reading time (word count, code block complexity)
  - `autoplayDelay` — user-configured additive linger time (default 0)
- Different strategies for reading_time — TBD

### ~~Sub-range highlighting during narration~~ (done)
- Teleprompter bubble: text builds up as TTS narrates each highlight, current section bold
- Selection moves through code sub-ranges in sync with narration

### ~~Move TTS into VS Code extension~~ (done)
- TTS lives in extension, keybindings trigger narration, MCP server is thin passthrough

### Step restart
- `Cmd+Shift+↑` restarts current step from the beginning (re-narrate explanation + highlights)
- Useful when you missed something or want to re-listen

### Walkthrough export/import
- Save walkthroughs to JSON files so they can be replayed later
- Export: save current walkthrough steps + highlights to `.walkthrough.json`
- Import: load a `.walkthrough.json` and start the walkthrough
- Enables sharing walkthroughs between team members
- Agent can generate a walkthrough once, user replays it anytime

### Distribution and installation
- One-command install for all clients: `npx add-mcp @joelwetzel/mcp-walkthrough --name walkthrough`
- Auto-detects Claude Code, Cursor, VS Code, Codex, Windsurf — writes config for each
- Skill ships with the package (`.claude/skills/mcp-walkthrough/`)
- Update README with one-liner install + skill setup

### ~~Extract modular core~~ (done)
- Split into `editor.ts`, `explanations.ts`, `walkthrough.ts`
- `extension.ts` is thin wiring
- Cockpit imports via adapter with constructor injection

### ~~Coordinator simplification~~ (done)
- Replaced the `runNarration` blob with a position-based state machine
- Computes `WalkthroughState` on demand (no precomputed flat list)
- Latest-value slot replaces the channel — push overwrites, no stale queue
- `next("manual"|"auto")` / `prev("manual"|"auto")` handle autoplay and stale-auto suppression in the coordinator
- Autoplay lives in `next("auto")` — at idle it no-ops when autoplay is off

### Idle timer after walkthrough ends
- After the walkthrough completes, leave the last state visible for 15s
- Reset the timer on any user activity (keyboard, mouse)
- Clear the bubble and selection after the timeout

### Debug logging cleanup
- Currently using `log.info` for all logs because VS Code `LogOutputChannel` debug level filtering doesn't work as expected
- Should be `log.debug` for state transitions, `log.info` for start/stop/navigate
- Investigate VS Code log level configuration
