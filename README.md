[![NPM Version](https://img.shields.io/npm/v/mcp-walkthrough)](https://www.npmjs.com/package/mcp-walkthrough)
[![NPM Downloads](https://img.shields.io/npm/dm/mcp-walkthrough)](https://www.npmjs.com/package/mcp-walkthrough)
[![CI Status](https://github.com/Stefan-Nitu/mcp-walkthrough/actions/workflows/ci.yml/badge.svg)](https://github.com/Stefan-Nitu/mcp-walkthrough/actions/workflows/ci.yml)
[![MIT Licensed](https://img.shields.io/npm/l/mcp-walkthrough)](https://github.com/Stefan-Nitu/mcp-walkthrough/blob/main/LICENSE)

# MCP Walkthrough

An MCP server for interactive code walkthroughs with voice narration. Opens files, highlights code, shows inline explanations with a teleprompter-style bubble, and reads each step aloud using neural text-to-speech.

Works with **any MCP client**: Claude Code, Cursor, VS Code Copilot, Gemini CLI, Codex CLI, Windsurf.

## Install

### All clients at once

```bash
npx add-mcp walkthrough -- npx -y mcp-walkthrough
```

Auto-detects which AI coding tools you have and configures all of them.

### Manual (any client)

Add to your MCP config (`mcpServers` key):

```json
{
  "walkthrough": {
    "command": "npx",
    "args": ["-y", "mcp-walkthrough"]
  }
}
```

| Client | Config file |
|---|---|
| Claude Code | `.mcp.json` (project) or `~/.claude.json` (global) |
| Cursor | `.cursor/mcp.json` |
| VS Code Copilot | `.vscode/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

### Skill (Claude Code)

```bash
npx skills add stefan-nitu/mcp-walkthrough
```

Installs the walkthrough skill so Claude auto-loads the tools when you ask it to explain code.

> **Note:** Requires VS Code, VS Code Insiders, or Cursor. A companion VS Code extension is automatically installed on `npm install`.

## What It Does

Text in a terminal isn't enough when an AI explains a solution. MCP Walkthrough opens files in VS Code, highlights specific lines, shows rich markdown explanations, and narrates each step with a natural-sounding voice.

**Teleprompter pattern:** The explanation bubble builds up as the agent narrates — each highlight's text appends in bold, then unbolds when done. Selection moves through the code in sync with the voice.

## Tools

| Tool | Description |
|---|---|
| **walkthrough** | One tool for all code presentation — 1 step with `explanation` shows an inline bubble; 1 step without `explanation` highlights only; N steps start a narrated tour; `action: "clear"` clears bubbles; `action` in `next`/`prev`/`goto`/`stop`/`pause`/`resume` navigates; empty args returns status |
| **show_code** | Open a file and highlight specific lines — ergonomic shortcut for the no-commentary case |
| **settings** | Global config: voice, bubbles, autoplay, autoplayDelay |
| **walkthrough_voice_selection** | Change narrator voice, audition voices, list available |
| **get_selection** | Read the currently highlighted code in VS Code |

### walkthrough

The single entry point for code presentation — dispatches by arguments.

**Multi-step narrated tour** (N steps):

```json
{
  "steps": [
    {
      "file": "/absolute/path/to/file.ts",
      "line": 33,
      "endLine": 48,
      "title": "Text Preparation",
      "explanation": "Intro context — narrated first, shown in bubble.",
      "highlights": [
        { "line": 35, "endLine": 36, "narration": "First section explained." },
        { "line": 37, "endLine": 40, "narration": "Second section explained." }
      ]
    }
  ]
}
```

**With highlights (teleprompter):**
- Bubble shows `explanation` — TTS narrates it
- Each highlight appends `narration` in **bold** — selection moves to the highlight's lines
- After the last highlight, all text unbolds and navigation controls appear

**Without highlights:** Simple bubble + full narration of the explanation.

**Single-step explain** (1 step with `explanation`): same shape, one entry in `steps`. Renders one bubble, no tour state.

**Highlight only** (1 step without `explanation`): `{ "steps": [{ "file": "…", "line": 10, "endLine": 15 }] }`. Equivalent to `show_code`.

**Navigation:** `{ "action": "next" | "prev" | "goto" | "stop" | "pause" | "resume" }`. For `goto`, pass `step` (0-based index); it jumps to the start of that step. `pause` silences the tour where it is, and `resume` replays the current narration from its start. Next, previous and `goto` also resume a paused tour. Each returns the tour's status, or `{ ok: false, error }` when no tour is running or the step is out of range.

**Clear bubbles:** `{ "action": "clear" }`.

**Status:** call with no arguments — returns `{ ok, active, paused, currentStep, totalSteps, highlight, title }`. `currentStep` is 0-based and `null` when no tour is running; `highlight` is `{ index, total }` (0-based) while a highlight is narrating, otherwise `null`; `title` is the step's title or `null`.

### show_code

Ergonomic single-shot highlight — same as a `walkthrough` with one step that has no `explanation`.

```json
{ "file": "/absolute/path/to/file.ts", "line": 10, "endLine": 15 }
```

### settings

View or update global config. Changes persist across sessions.

```json
{ "voice": true, "autoplay": false, "autoplayDelay": 2000 }
```

- **voice** — Toggle voice narration on/off
- **showBubbles** — Toggle explanation bubbles on/off
- **autoplay** — Auto-advance to next step after narration finishes
- **autoplayDelay** — Extra delay in ms after narration (additive)

### Keyboard Shortcuts

Shown at the bottom of every tour bubble. They work only while a tour is running, so outside a tour `Cmd+Shift+arrow` keeps its usual text-selection behavior. Use `Ctrl` instead of `Cmd` on Windows and Linux.

| Shortcut | Action |
|---|---|
| `Cmd+Shift+→` | Next step |
| `Cmd+Shift+←` | Previous step |
| `Cmd+Shift+↑` | Pause / resume |
| `Cmd+Shift+↓` | Stop walkthrough |

## How It Works

```
AI Agent  →  MCP Server (stdio)  →  Unix socket  →  VS Code Extension  →  Editor API + TTS
```

1. Agent calls walkthrough tools via MCP
2. MCP server sends steps to VS Code extension via workspace-specific Unix socket
3. Extension shows bubbles, moves selection, narrates with TTS (Edge TTS + native fallback)
4. Each VS Code window gets its own socket — multiple windows work independently
5. Focus stays in your terminal — code appears in the editor beside it

TTS runs in the VS Code extension, not the MCP server. Keyboard shortcuts trigger the same narration path as MCP tool calls.

## Development

```bash
bun install
bun test              # 88 tests
bun run build         # Builds MCP server + VS Code extension
bun run typecheck     # Type checking
bun run lint          # Biome linting
```

### Local Testing

**MCP server** (npm global):
```bash
npm run build && npm install -g .
```

**VS Code extension:**
```bash
cd vscode-extension && node esbuild.js
npx @vscode/vsce package --allow-missing-repository -o walkthrough-bridge.vsix
code --install-extension walkthrough-bridge.vsix --force
```
Then restart VS Code (not just reload — extension code is cached).

## License

MIT

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io) — MCP specification
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — SDK used by this server
- [add-mcp](https://github.com/neondatabase/add-mcp) — Install MCP servers across all clients
