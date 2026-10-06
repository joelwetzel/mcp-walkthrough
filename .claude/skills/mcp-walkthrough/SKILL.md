---
name: mcp-walkthrough
description: "Interactive code walkthrough expert. ALWAYS invoke this skill when the user asks to explain code, understand a system, walk through code, or asks 'how does this work'. Do not explain code as text directly — use this skill first, it loads the walkthrough MCP tools and the multi-step-with-highlights authoring rules that make the teleprompter UX work."
user-invocable: false
---

Load the walkthrough MCP tools before proceeding:

`ToolSearch("select:mcp__walkthrough__walkthrough,mcp__walkthrough__show_code,mcp__walkthrough__settings,mcp__walkthrough__walkthrough_voice_selection,mcp__walkthrough__get_selection")`

The merged `walkthrough` tool handles every code-presentation case: single inline explain (1 step with `explanation`), highlight-only (1 step without `explanation`, same as `show_code`), multi-step tour (N steps), clear bubbles (`action: "clear"`), navigate (`action: "next"|"prev"|"goto"|"stop"|"pause"|"resume"`), status (no args).

## Authoring rules — non-negotiable

**1. Read the target file first.** Never guess line numbers. Use `Read` or `Grep` to confirm the exact lines before writing any step or highlight. Line numbers are 1-based.

**2. Use `highlights[]` for multi-point steps — not long explanations.** Each highlight has its own sub-range and narration. TTS reads each in sequence, selection moves to that sub-range, bubble text builds up like a teleprompter. Stuffing multiple points into one `explanation` kills both the audio flow AND the visual sync.

Pattern:
- `explanation` = short step intro (one or two sentences, sets context, narrated first)
- `highlights[]` = one entry per point, each narrating one thought

In a multi-step tour, every highlight's range must sit inside its step's `line`..`endLine` (a step without `endLine` covers only `line`), or the whole tour is rejected. To narrate lines further away, widen the step or give them their own step.

**3. Write TTS-friendly prose. No numbered lists.** TTS reads `1.` `2.` `3.` as *"one dot… two dot… three dot"* — painful. Use flowing prose. If you must list, use `-` bullets, which read more naturally. Never use numbered lists in narration or explanation.

**4. Markdown rules for explanations and narrations:**
- Real newlines for paragraphs — never literal `\n` strings
- Avoid `##` headers (render too large in the bubble) — use `**bold**` for emphasis instead
- Inline code, code blocks, lists (bullets), and links all work
- Keep paragraphs short — the bubble is narrow

**5. Narration is spoken, not read.** Write for the ear: conversational, complete sentences, avoid parenthetical asides and dense punctuation. What reads fine on screen can sound robotic out loud.

## When to use which shape

| User intent | Tool call |
|---|---|
| "Show me line N of X" / "open X" | `show_code({file, line, endLine})` |
| "What does this function do?" | `walkthrough({steps: [{file, line, endLine, explanation, highlights}]})` — 1 step |
| "Walk me through X" / "how does the system work?" | `walkthrough({steps: [step1, step2, …]})` — multi-step tour |
| "Go back / next / jump to step N" | `walkthrough({action: "prev"|"next"|"goto", step?})` |
| "Clear the bubbles" | `walkthrough({action: "clear"})` |
| "Where are we?" / resume context | `walkthrough()` — empty args |
| User has already selected code | `get_selection()` first, then walkthrough |

## Explaining tests — the canonical pattern

When presenting a test file (any project), default to: one walkthrough **step per behavior group** (nested `describe`), with `highlights[]` entries mapping the individual tests to the specific behavior they verify. Don't dump tests as a flat sequence. If the file isn't already grouped by behavior, propose regrouping into nested `describe` blocks first — then walkthrough.

## Pre-call checklist

- [ ] File exists and I've read the relevant range
- [ ] Line numbers verified against the actual file content
- [ ] Step has a short `explanation` intro, not a wall of text
- [ ] Multi-point steps have `highlights[]` — each one point, with its own `line`/`endLine` and `narration`
- [ ] Every highlight's range sits inside its step's `line`..`endLine`
- [ ] No numbered lists (`1.` `2.`) anywhere in explanation or narration
- [ ] No `##` headers — `**bold**` instead
- [ ] Paragraphs separated by real newlines, not escaped `\n`
