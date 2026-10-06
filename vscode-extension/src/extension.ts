import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as vscode from "vscode";
import { getConfig, updateConfig } from "./config";
import { getSelection, openFileAtLine } from "./editor";
import { createExplanations } from "./explanations";
import { cleanupTts, speak, stripMarkdown } from "./tts";
import type { WalkthroughStep } from "./walkthrough";
import { createWalkthrough } from "./walkthrough";

const SOCKET_DIR = "/tmp";
const SOCKET_PREFIX = "walkthrough-bridge-";

function socketPathForDir(dir: string): string {
  const normalized = dir.replace(/\/+$/, "");
  const hash = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
  return `${SOCKET_DIR}/${SOCKET_PREFIX}${hash}.sock`;
}

let server: http.Server | undefined;
let socketPath: string | undefined;
let walkthroughInstance: ReturnType<typeof createWalkthrough> | undefined;

const log = vscode.window.createOutputChannel("Walkthrough", { log: true });

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(log);
  const explanations = createExplanations(context);
  const walkthrough = createWalkthrough(context, explanations, getConfig, log);
  walkthroughInstance = walkthrough;

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    vscode.window.showWarningMessage(
      "Walkthrough bridge: no workspace folder open",
    );
    return;
  }

  socketPath = socketPathForDir(workspaceFolder);
  cleanupStaleSocket(socketPath);

  async function handleRequest(
    url: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (url) {
      case "/open":
        await openFileAtLine(
          data.file as string,
          data.line as number,
          data.endLine as number | undefined,
          data.startChar as number | undefined,
          data.endChar as number | undefined,
        );
        return { ok: true };

      case "/explain": {
        await explanations.show(
          data.file as string,
          data.line as number,
          data.endLine as number | undefined,
          data.explanation as string,
          data.title as string | undefined,
          data.startChar as number | undefined,
          data.endChar as number | undefined,
        );
        const highlights = data.highlights as
          | { line: number; endLine?: number; narration: string }[]
          | undefined;
        if (getConfig().voiceEnabled) {
          if (highlights && highlights.length > 0) {
            (async () => {
              for (const hl of highlights) {
                await explanations.highlight(
                  data.file as string,
                  hl.line,
                  hl.endLine,
                );
                await speak(stripMarkdown(hl.narration), getConfig().voice);
              }
            })().catch(() => {});
          } else {
            speak(
              stripMarkdown(data.explanation as string),
              getConfig().voice,
            ).catch(() => {});
          }
        }
        return { ok: true };
      }

      case "/highlight":
        await explanations.highlight(
          data.file as string,
          data.line as number,
          data.endLine as number | undefined,
        );
        return { ok: true };

      case "/clear":
        explanations.clear();
        return { ok: true };

      case "/walkthrough":
        return walkthrough.start(data.steps as WalkthroughStep[]);

      case "/walkthrough/navigate": {
        const action = data.action as string;
        if (action === "next") return walkthrough.next();
        if (action === "prev") return walkthrough.prev();
        if (action === "goto") return walkthrough.goto(data.step);
        if (action === "pause") return walkthrough.pause();
        if (action === "resume") return walkthrough.resume();
        if (action === "stop") {
          walkthrough.stop();
          return { ok: true, stopped: true };
        }
        return { ok: false, error: `Unknown walkthrough action: ${action}` };
      }

      case "/walkthrough/status":
        return walkthrough.status();

      case "/selection":
        return getSelection();

      case "/settings":
        updateConfig(data as Partial<typeof data>);
        return { ok: true, ...getConfig() };

      case "/ping":
        return { ok: true };

      default:
        throw new Error(`Unknown endpoint: ${url}`);
    }
  }

  server = http.createServer(async (req, res) => {
    if (req.method !== "POST" && req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }

    const body = req.method === "POST" ? await readBody(req) : "";
    let data: Record<string, unknown> = {};
    try {
      if (body) data = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    try {
      const result = await handleRequest(req.url || "", data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(socketPath, () => {
    vscode.window.showInformationMessage(
      `Walkthrough bridge listening on ${socketPath}`,
    );
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    vscode.window.showErrorMessage(
      `Walkthrough bridge failed to start: ${err.message}`,
    );
  });

  context.subscriptions.push({
    dispose: () => {
      server?.close();
      if (socketPath && existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
    },
  });
}

export function deactivate() {
  walkthroughInstance?.stop();
  cleanupTts();
  server?.close();
  if (socketPath && existsSync(socketPath)) {
    unlinkSync(socketPath);
  }
}

function cleanupStaleSocket(path: string): void {
  if (!existsSync(path)) return;

  const client = net.createConnection({ path }, () => {
    client.destroy();
  });

  client.on("error", () => {
    try {
      unlinkSync(path);
    } catch {}
  });
}

const MAX_BODY_SIZE = 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(data));
  });
}
