import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAllCodeClis } from "./code-cli.js";
import { discoverSocket } from "./socket.js";
import { logger } from "./utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EXTENSION_ID = "undefined_publisher.walkthrough-bridge";
const VSIX_PATH = join(
  __dirname,
  "../vscode-extension/walkthrough-bridge.vsix",
);

export function ensureExtensionInstalled(): void {
  const clis = resolveAllCodeClis();
  if (clis.length === 0) {
    logger.warn(
      "Could not find VS Code CLI (code, code-insiders, or cursor). Install one or add it to PATH.",
    );
    return;
  }

  if (!existsSync(VSIX_PATH)) {
    logger.error({ path: VSIX_PATH }, "Extension .vsix not found");
    return;
  }

  for (const cli of clis) {
    try {
      const installed = execSync(`"${cli}" --list-extensions`, {
        encoding: "utf-8",
      });
      if (installed.includes(EXTENSION_ID)) {
        logger.info({ cli }, "Walkthrough bridge extension already installed");
        continue;
      }
    } catch {
      logger.warn({ cli }, "Could not check installed extensions");
    }

    try {
      execSync(`"${cli}" --install-extension "${VSIX_PATH}"`, {
        encoding: "utf-8",
      });
      logger.info({ cli }, "Installed walkthrough bridge extension");
    } catch (error) {
      logger.error({ cli, err: error }, "Failed to install extension");
    }
  }
}

type BridgeResult = Record<string, unknown>;

export let bridgeAvailable: boolean | null = null;
let socketPath: string | null = null;

export function resetBridgeState(): void {
  bridgeAvailable = null;
  socketPath = null;
}

// For testing: override socket path discovery
export function _setSocketPath(path: string): void {
  socketPath = path;
}

function resolveSocketPath(): string | null {
  if (!socketPath) {
    socketPath = discoverSocket();
  }
  return socketPath;
}

function socketRequest(
  endpoint: string,
  data: Record<string, unknown> = {},
): Promise<BridgeResult> {
  const resolved = resolveSocketPath();
  if (!resolved) {
    return Promise.resolve({
      ok: false,
      error:
        "No walkthrough bridge socket found. Make sure VS Code is open with a workspace.",
    });
  }

  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const req = http.request(
      {
        socketPath: resolved,
        agent: false,
        path: endpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseData = "";
        res.on("data", (chunk: Buffer) => {
          responseData += chunk.toString();
        });
        res.on("end", () => {
          try {
            bridgeAvailable = true;
            resolve(JSON.parse(responseData) as BridgeResult);
          } catch {
            resolve({ ok: false, error: "Invalid response from bridge" });
          }
        });
      },
    );

    req.on("error", () => {
      resolve({
        ok: false,
        error:
          "Could not reach VS Code. Make sure VS Code is open and reload the window if you just installed mcp-walkthrough.",
      });
    });

    req.write(body);
    req.end();
  });
}

export async function checkBridge(): Promise<boolean> {
  const result = await socketRequest("/ping");
  bridgeAvailable = result.ok === true;
  logger.info({ bridgeAvailable }, "Bridge status");
  return bridgeAvailable;
}

export function isBridgeAvailable(): boolean {
  return bridgeAvailable === true;
}

export async function openFile(
  file: string,
  line: number,
  endLine?: number,
  startChar?: number,
  endChar?: number,
): Promise<BridgeResult> {
  return socketRequest("/open", { file, line, endLine, startChar, endChar });
}

export async function showHighlight(
  file: string,
  line: number,
  endLine: number | undefined,
  explanation: string,
  title?: string,
): Promise<BridgeResult> {
  return socketRequest("/highlight", {
    file,
    line,
    endLine,
    explanation,
    title,
  });
}

export async function showExplanation(
  file: string,
  line: number,
  endLine: number | undefined,
  explanation: string,
  title?: string,
  startChar?: number,
  endChar?: number,
  highlights?: { line: number; endLine?: number; narration: string }[],
): Promise<BridgeResult> {
  return socketRequest("/explain", {
    file,
    line,
    endLine,
    explanation,
    title,
    startChar,
    endChar,
    highlights,
  });
}

export async function clearExplanations(): Promise<BridgeResult> {
  return socketRequest("/clear");
}

export interface WalkthroughHighlight {
  line: number;
  endLine?: number;
  narration: string;
}

export interface WalkthroughStep {
  file: string;
  line: number;
  endLine?: number;
  explanation?: string;
  title?: string;
  highlights?: WalkthroughHighlight[];
}

export async function startWalkthrough(
  steps: WalkthroughStep[],
  autoplay?: boolean,
  delayMs?: number,
): Promise<BridgeResult> {
  return socketRequest("/walkthrough", { steps, autoplay, delayMs });
}

export async function navigateWalkthrough(
  action: string,
  step?: number,
): Promise<BridgeResult> {
  return socketRequest("/walkthrough/navigate", { action, step });
}

export async function getWalkthroughStatus(): Promise<BridgeResult> {
  return socketRequest("/walkthrough/status");
}

export async function getSelection(): Promise<BridgeResult> {
  return socketRequest("/selection");
}
