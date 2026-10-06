#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  checkBridge,
  clearExplanations,
  ensureExtensionInstalled,
  getSelection,
  getWalkthroughStatus,
  navigateWalkthrough,
  openFile,
  setRoots,
  showExplanation,
  startWalkthrough,
  type WalkthroughStep,
} from "./bridge.js";
import { getConfig, updateConfig } from "./config.js";
import { rootsToDirs } from "./socket.js";
import { cleanupTts, listVoices, speak, stopSpeaking } from "./tts.js";
import { WalkthroughDispatcherUseCase } from "./use-cases/walkthrough-dispatcher.js";
import { flushLogs, logger } from "./utils/logger.js";

const walkthroughDispatcher = new WalkthroughDispatcherUseCase();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
);

const server = new McpServer({
  name: "walkthrough",
  version: packageJson.version,
});

server.registerTool(
  "show_code",
  {
    description:
      "Open a file in VS Code and highlight specific lines without any explanation bubble. Use when the user asks to show, open, jump to, or point at specific code with no commentary needed. Do NOT use when you need to explain what the code does — use the walkthrough tool with a step that includes an `explanation`. Do NOT use for multi-step tours — use walkthrough with multiple steps. Line numbers are 1-based; character offsets are 0-based.",
    inputSchema: {
      file: z
        .string()
        .describe(
          "Absolute path to the file, inside a folder open in the editor",
        ),
      line: z.number().describe("Start line (1-based)"),
      endLine: z.number().optional().describe("End line (1-based)"),
      startChar: z.number().optional().describe("Start character (0-based)"),
      endChar: z.number().optional().describe("End character (0-based)"),
    },
  },
  async (args) => {
    const result = await openFile(
      args.file,
      args.line,
      args.endLine,
      args.startChar,
      args.endChar,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  },
);

const stepSchema = z.object({
  file: z
    .string()
    .describe("Absolute path to the file, inside a folder open in the editor"),
  line: z.number().describe("Start line (1-based)"),
  endLine: z.number().optional().describe("End line (1-based)"),
  startChar: z.number().optional().describe("Start character (0-based)"),
  endChar: z.number().optional().describe("End character (0-based)"),
  explanation: z
    .string()
    .optional()
    .describe(
      "Short intro — 1–2 sentences — narrated first, shown in the bubble. For multi-point steps, keep this brief and put each distinct point in `highlights[]` instead of stuffing them here; the teleprompter UX depends on it. Omit entirely to highlight without a bubble. No numbered lists (TTS reads them as 'one dot'). Real newlines for paragraphs, NOT literal backslash-n. Avoid ## headers — use **bold** instead. Inline code, code blocks, bullet lists, and links work.",
    ),
  title: z.string().optional().describe("Step title"),
  highlights: z
    .array(
      z.object({
        line: z
          .number()
          .describe("Start line (1-based), at or after the step's `line`"),
        endLine: z
          .number()
          .optional()
          .describe(
            "End line (1-based), at or before the step's `endLine` (or its `line` when the step has no `endLine`)",
          ),
        narration: z
          .string()
          .describe(
            "Spoken text for this sub-highlight — one thought, conversational prose. No numbered lists (TTS reads `1.` `2.` as 'one dot… two dot'). Appended to the bubble as a live transcript.",
          ),
      }),
    )
    .optional()
    .describe(
      "The canonical pattern for any step with more than one point. Each entry narrates one thought; selection moves to its sub-range while the bubble text builds up — that is the teleprompter UX. Only omit when the step has a single point with nothing sub-range to emphasize. In a multi-step tour, every highlight's range must fall within its step's `line`..`endLine`, or the tour is rejected; to narrate lines further away, widen the step or give them their own step.",
    ),
});

server.registerTool(
  "walkthrough",
  {
    description:
      "Show, explain, and tour code in VS Code — the one tool for all code presentation with commentary, from single inline explanations to multi-step narrated tours. Use when the user asks to explain code, walk through code, tour a codebase, ask 'how does this work', navigate an active tour, clear bubbles, or check walkthrough state. Do NOT use for jumping to code without commentary — use show_code instead. Dispatches by arguments: one step with `explanation` shows an inline markdown bubble (single-step explain); one step WITHOUT explanation highlights only (same as show_code); multiple steps start a narrated tour; `action: 'clear'` removes all bubbles; `action` in {'next','prev','goto','stop','pause','resume'} navigates an active tour (pass `step` index for goto); no arguments returns current status. **Proper usage for multi-point steps:** keep `explanation` to 1–2 intro sentences and put each point in its own `highlights[]` entry with its own `line` range and `narration` — the teleprompter UX (selection moving with the voice, bubble text building up) depends on this pattern. Cramming multiple points into one long `explanation` breaks both the audio flow and the visual sync. **Never use numbered lists (`1.` `2.`) in explanations or narrations** — TTS reads them as 'one dot… two dot' and it's painful. Markdown: real newlines for paragraphs, NOT literal backslash-n; avoid ## headers — use **bold** instead. Uses global voice/bubble/autoplay settings from the settings tool.",
    inputSchema: {
      steps: z
        .array(stepSchema)
        .optional()
        .describe(
          "Steps to show. One step with explanation = inline explain. One step without explanation = highlight only. Multiple steps = narrated tour. Precedence: when provided with a non-empty array, takes priority over `action`.",
        ),
      action: z
        .enum(["next", "prev", "goto", "stop", "pause", "resume", "clear"])
        .optional()
        .describe(
          "Control an active walkthrough or clear bubbles. 'clear' removes all explanation bubbles; 'goto' requires `step`; others navigate the current tour.",
        ),
      step: z
        .number()
        .optional()
        .describe("Step index (0-based) for action='goto'"),
    },
  },
  async (args) => {
    const dispatch = walkthroughDispatcher.execute(args);

    switch (dispatch.type) {
      case "getStatus": {
        const result = await getWalkthroughStatus();
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "clear": {
        const result = await clearExplanations();
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "navigate": {
        const result = await navigateWalkthrough(
          dispatch.action,
          dispatch.step,
        );
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "highlightOnly": {
        const result = await openFile(
          dispatch.file,
          dispatch.line,
          dispatch.endLine,
          dispatch.startChar,
          dispatch.endChar,
        );
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "singleExplain": {
        const s = dispatch.step;
        const result = await showExplanation(
          s.file,
          s.line,
          s.endLine,
          s.explanation ?? "",
          s.title,
          s.startChar,
          s.endChar,
          s.highlights,
        );
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "startWalkthrough": {
        const result = await startWalkthrough(
          dispatch.steps as WalkthroughStep[],
        );
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "invalid": {
        const result = { ok: false, error: dispatch.error };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    }
  },
);

server.registerTool(
  "settings",
  {
    description:
      "View or update global walkthrough settings — voice narration on/off, explanation bubbles on/off, autoplay on/off, and autoplay delay. Use when the user asks to enable, disable, or configure any of those, mute/unmute narration, toggle bubbles, or check current settings. Do NOT use to change the narration voice name — use walkthrough_voice_selection for that. Call with no arguments to read current settings. Changes persist across sessions.",
    inputSchema: {
      voice: z
        .boolean()
        .optional()
        .describe("Toggle voice narration on/off (true=on, false=off)"),
      showBubbles: z
        .boolean()
        .optional()
        .describe("Toggle explanation bubbles on/off"),
      autoplay: z.boolean().optional().describe("Toggle autoplay on/off"),
      autoplayDelay: z
        .number()
        .optional()
        .describe(
          "Additive delay in ms on top of reading/TTS time (0 = no extra delay)",
        ),
    },
  },
  async (args) => {
    updateConfig({
      voiceEnabled: args.voice,
      showBubbles: args.showBubbles,
      autoplay: args.autoplay,
      autoplayDelay: args.autoplayDelay,
    });

    return {
      content: [
        { type: "text", text: JSON.stringify({ ok: true, ...getConfig() }) },
      ],
    };
  },
);

server.registerTool(
  "walkthrough_voice_selection",
  {
    description:
      "Change the narration voice, preview how it sounds, list available voices, or audition voices back-to-back. Use when the user asks to change the voice, try a different voice, hear voice options, compare voices, or asks 'what voices are available'. Do NOT use to toggle voice on/off — use the settings tool for that. Pass `voice` to switch to a specific voice and hear a sample. Pass `list: true` to list voices without playing audio. Pass `audition: true` to play voices back-to-back for comparison. Filter with `locale` (e.g. 'en-US', 'en', 'de') and `gender`. Voice selection persists across sessions.",
    inputSchema: {
      voice: z
        .string()
        .optional()
        .describe(
          "Voice name to switch to. Examples: 'en-US-GuyNeural', 'en-US-MichelleNeural'",
        ),
      list: z
        .boolean()
        .optional()
        .describe("List available voices without playing them"),
      audition: z
        .boolean()
        .optional()
        .describe("Play voices back-to-back so the user can compare"),
      locale: z
        .string()
        .optional()
        .describe("Filter by locale prefix (e.g. 'en-US', 'en', 'de')"),
      gender: z
        .enum(["Male", "Female"])
        .optional()
        .describe("Filter by gender"),
    },
  },
  async (args, extra) => {
    const voices = await listVoices();
    const locale = args.locale;
    let filtered = locale
      ? voices.filter((v) =>
          v.locale.toLowerCase().startsWith(locale.toLowerCase()),
        )
      : voices;
    if (args.gender) {
      filtered = filtered.filter((v) => v.gender === args.gender);
    }

    if (args.list) {
      return {
        content: [{ type: "text", text: JSON.stringify(filtered) }],
      };
    }

    if (args.audition) {
      const toAudition = args.locale
        ? filtered
        : filtered.filter((v) => v.locale === "en-US");
      const originalVoice = getConfig().voice;
      const played: string[] = [];
      const onAbort = () => stopSpeaking();
      extra.signal?.addEventListener("abort", onAbort);
      for (const v of toAudition) {
        if (extra.signal?.aborted) break;
        if (v.name.includes("Multilingual")) continue;
        updateConfig({ voice: v.name });
        const name = v.name
          .replace(/Neural$/, "")
          .replace(/^[\w]+-[\w]+-/, "")
          .replace(/-/g, " ");
        await speak(
          `I'm ${name}. Here's how I sound narrating a code walkthrough for you.`,
          v.name,
        );
        played.push(v.name);
      }
      extra.signal?.removeEventListener("abort", onAbort);
      updateConfig({ voice: originalVoice });
      stopSpeaking();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              auditioned: played,
              currentVoice: originalVoice,
            }),
          },
        ],
      };
    }

    if (args.voice) {
      updateConfig({ voice: args.voice });
      const name = args.voice.replace(/Neural$/, "").replace(/-/g, " ");
      await speak(
        `Hi, I'm ${name}. This is how I sound when narrating a code walkthrough.`,
        args.voice,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              voice: args.voice,
              persisted: true,
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ currentVoice: getConfig().voice }),
        },
      ],
    };
  },
);

server.registerTool(
  "get_selection",
  {
    description:
      "Get the code the user has selected or highlighted in VS Code — returns file path, line range, and selected text. Use when the user refers to 'this code', 'what I've selected', 'the highlighted block', or before calling walkthrough/show_code when the user has already selected the code they want to discuss. Returns an empty selection object when nothing is highlighted.",
  },
  async () => {
    const result = await getSelection();
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  },
);

async function refreshRoots(): Promise<void> {
  if (!server.server.getClientCapabilities()?.roots) {
    logger.info("MCP client does not offer roots");
    return;
  }
  try {
    const { roots } = await server.server.listRoots();
    const dirs = rootsToDirs(roots);
    setRoots(dirs);
    logger.info({ roots: dirs }, "MCP client roots");
  } catch (error) {
    logger.warn({ err: error }, "Could not list MCP client roots");
  }
}

async function main() {
  ensureExtensionInstalled();

  await checkBridge();

  const transport = new StdioServerTransport();

  let cleanupStarted = false;

  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;

    stopSpeaking();
    cleanupTts();
    logger.info("Shutting down...");
    flushLogs();

    const timeoutId = setTimeout(() => {
      logger.error("Cleanup timeout - forcing exit after 5 seconds");
      flushLogs();
      process.exit(1);
    }, 5000);

    try {
      await server.close();
      clearTimeout(timeoutId);
      logger.info("Cleanup completed");
      process.exit(0);
    } catch (error) {
      clearTimeout(timeoutId);
      logger.error({ err: error }, "Error during cleanup");
      flushLogs();
      process.exit(1);
    }
  };

  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  server.server.oninitialized = () => {
    refreshRoots();
  };
  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    refreshRoots,
  );

  await server.connect(transport);

  process.stdin.once("end", cleanup);
  process.stdin.once("close", cleanup);

  logger.info("mcp-walkthrough server started");
}

main().catch((error) => {
  logger.error({ err: error }, "Fatal error");
  flushLogs();
  process.exit(1);
});
