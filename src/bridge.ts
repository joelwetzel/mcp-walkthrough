import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAllCodeClis } from "./code-cli.js";
import { allBridgeSockets, socketCandidates } from "./socket.js";
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
let lastSocket: string | null = null;
let rootDirs: string[] = [];

export function resetBridgeState(): void {
  bridgeAvailable = null;
  lastSocket = null;
  rootDirs = [];
}

export function setRoots(dirs: string[]): void {
  rootDirs = dirs;
}

// For testing: pin the window that answered last
export function _setSocketPath(path: string): void {
  lastSocket = path;
}

const NO_SOCKET_ERROR =
  "No walkthrough bridge socket found. Make sure VS Code is open with a workspace.";
const UNREACHABLE_ERROR =
  "Could not reach VS Code. Make sure VS Code is open and reload the window if you just installed mcp-walkthrough.";

// What connecting to a socket file nobody listens on fails with: a regular
// file, a file removed since it was listed, or one a crashed window left behind.
const DEAD_SOCKET_CODES = new Set(["ENOTSOCK", "ENOENT", "ECONNREFUSED"]);

// The files being shown name their window most reliably, so their folders come
// first; the server's own working directory is often not the workspace at all
// (Cursor starts global MCP servers in the home directory).
function findSockets(hintFiles: string[]): {
  searched: string[];
  candidates: string[];
} {
  const hintDirs = hintFiles.map((file) => dirname(file));
  const fallbackDirs: string[] = [];
  const workspace = process.env.WALKTHROUGH_WORKSPACE;
  if (workspace) fallbackDirs.push(workspace);
  fallbackDirs.push(...rootDirs, process.cwd());

  const candidates = [
    ...socketCandidates(hintDirs),
    ...(lastSocket && existsSync(lastSocket) ? [lastSocket] : []),
    ...socketCandidates(fallbackDirs),
  ];
  return {
    searched: [...new Set([...hintDirs, ...fallbackDirs])],
    candidates: [...new Set(candidates)],
  };
}

// Resolves null when nothing listens on the socket, so the next one can be
// tried. Any other failure is returned rather than retried elsewhere, since
// the window may already have acted on the request.
function requestSocket(
  socketPath: string,
  endpoint: string,
  body: string,
): Promise<BridgeResult | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
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
          bridgeAvailable = true;
          lastSocket = socketPath;
          try {
            resolve(JSON.parse(responseData) as BridgeResult);
          } catch {
            resolve({ ok: false, error: "Invalid response from bridge" });
          }
        });
      },
    );

    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code && DEAD_SOCKET_CODES.has(error.code)) {
        resolve(null);
        return;
      }
      resolve({
        ok: false,
        error: UNREACHABLE_ERROR,
        unreachable: [socketPath],
      });
    });

    req.write(body);
    req.end();
  });
}

async function socketRequest(
  endpoint: string,
  data: Record<string, unknown> = {},
  hintFiles: string[] = [],
): Promise<BridgeResult> {
  const { searched, candidates } = findSockets(hintFiles);
  const body = JSON.stringify(data);

  for (const socketPath of candidates) {
    const result = await requestSocket(socketPath, endpoint, body);
    if (result) return result;
  }

  if (candidates.length > 0) {
    return {
      ok: false,
      error: UNREACHABLE_ERROR,
      searched,
      unreachable: candidates,
      hint: "These sockets exist but nothing answers on them, which is what a closed or crashed editor window leaves behind. Reload the editor window to restart the bridge.",
    };
  }

  const otherSockets = allBridgeSockets().length;
  const elsewhere =
    otherSockets > 0
      ? `${otherSockets} other bridge socket(s) exist, but none for these folders. `
      : "";
  return {
    ok: false,
    error: NO_SOCKET_ERROR,
    searched,
    otherSockets,
    hint: `${elsewhere}The bridge listens for the editor window's first workspace folder. Pass absolute file paths inside that folder, or set WALKTHROUGH_WORKSPACE to it in the MCP server's env.`,
  };
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
  return socketRequest("/open", { file, line, endLine, startChar, endChar }, [
    file,
  ]);
}

export async function showHighlight(
  file: string,
  line: number,
  endLine: number | undefined,
  explanation: string,
  title?: string,
): Promise<BridgeResult> {
  return socketRequest(
    "/highlight",
    { file, line, endLine, explanation, title },
    [file],
  );
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
  return socketRequest(
    "/explain",
    {
      file,
      line,
      endLine,
      explanation,
      title,
      startChar,
      endChar,
      highlights,
    },
    [file],
  );
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
  return socketRequest(
    "/walkthrough",
    { steps, autoplay, delayMs },
    steps.map((step) => step.file),
  );
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
