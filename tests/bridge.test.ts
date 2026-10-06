import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setSocketPath,
  checkBridge,
  clearExplanations,
  getSelection,
  getWalkthroughStatus,
  isBridgeAvailable,
  navigateWalkthrough,
  openFile,
  resetBridgeState,
  showExplanation,
  startWalkthrough,
} from "../src/bridge";
import { socketPathForDir } from "../src/socket";

const TEST_DIR = `/tmp/walkthrough-bridge-test-${process.pid}`;
const SOCKET_PATH = socketPathForDir(TEST_DIR);

let testServer: http.Server;
let lastRequest: { url: string; body: Record<string, unknown> } | null = null;
let serverResponse: Record<string, unknown> = { ok: true };

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    testServer = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      lastRequest = {
        url: req.url || "",
        body: body ? JSON.parse(body) : {},
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(serverResponse));
    });
    testServer.listen(SOCKET_PATH, resolve);
  });
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve) => {
    testServer?.close(() => {
      rmSync(SOCKET_PATH, { force: true });
      resolve();
    });
  });
}

// Discovery also walks up from the working directory and reads
// WALKTHROUGH_WORKSPACE, so each test runs from an empty directory with the
// variable unset, where no real editor window can answer.
const originalCwd = process.cwd();
const originalWorkspace = process.env.WALKTHROUGH_WORKSPACE;
let scratchDir: string;

beforeEach(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "walkthrough-cwd-"));
  process.chdir(scratchDir);
  delete process.env.WALKTHROUGH_WORKSPACE;
  resetBridgeState();
  lastRequest = null;
  serverResponse = { ok: true };
  await startTestServer();
  _setSocketPath(SOCKET_PATH);
});

afterEach(async () => {
  await stopTestServer();
  process.chdir(originalCwd);
  rmSync(scratchDir, { recursive: true, force: true });
  if (originalWorkspace === undefined) {
    delete process.env.WALKTHROUGH_WORKSPACE;
  } else {
    process.env.WALKTHROUGH_WORKSPACE = originalWorkspace;
  }
});

describe("checkBridge", () => {
  test("returns true when bridge responds ok", async () => {
    // Arrange
    serverResponse = { ok: true };

    // Act
    const result = await checkBridge();

    // Assert
    expect(result).toBe(true);
    expect(isBridgeAvailable()).toBe(true);
  });

  test("returns false when bridge is unreachable", async () => {
    // Arrange
    await stopTestServer();
    _setSocketPath("/tmp/nonexistent-socket.sock");

    // Act
    const result = await checkBridge();

    // Assert
    expect(result).toBe(false);
    expect(isBridgeAvailable()).toBe(false);

    // Restart for afterEach cleanup
    await startTestServer();
    _setSocketPath(SOCKET_PATH);
  });

  test("returns false when bridge responds without ok", async () => {
    // Arrange
    serverResponse = { error: "something" };

    // Act
    const result = await checkBridge();

    // Assert
    expect(result).toBe(false);
  });
});

describe("bridge unavailable", () => {
  test("all tools return error when bridge is down", async () => {
    // Arrange
    await stopTestServer();
    _setSocketPath("/tmp/nonexistent-socket.sock");

    // Act
    const results = await Promise.all([
      openFile("/test.ts", 1),
      showExplanation("/test.ts", 1, 5, "explanation"),
      clearExplanations(),
      startWalkthrough([{ file: "/test.ts", line: 1, explanation: "test" }]),
      navigateWalkthrough("next"),
      getWalkthroughStatus(),
      getSelection(),
    ]);

    // Assert
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe("string");
    }

    // Restart for afterEach cleanup
    await startTestServer();
    _setSocketPath(SOCKET_PATH);
  });

  test("retries on each call instead of caching failure", async () => {
    // Arrange - bridge down
    await stopTestServer();
    _setSocketPath("/tmp/nonexistent-socket.sock");
    await openFile("/test.ts", 1);

    // Act - bridge comes back
    await startTestServer();
    _setSocketPath(SOCKET_PATH);
    serverResponse = { ok: true };
    const result = await openFile("/test.ts", 1);

    // Assert
    expect(result.ok).toBe(true);
  });
});

describe("bridge available", () => {
  test("openFile sends correct request", async () => {
    // Arrange
    serverResponse = { ok: true };

    // Act
    const result = await openFile("/src/index.ts", 10, 20);

    // Assert
    expect(result).toEqual({ ok: true });
    expect(lastRequest?.url).toBe("/open");
    expect(lastRequest?.body).toEqual({
      file: "/src/index.ts",
      line: 10,
      endLine: 20,
    });
  });

  test("showExplanation sends correct request", async () => {
    // Arrange
    serverResponse = { ok: true };

    // Act
    const result = await showExplanation(
      "/src/index.ts",
      5,
      10,
      "## Explanation",
      "Step 1",
    );

    // Assert
    expect(result).toEqual({ ok: true });
    expect(lastRequest?.url).toBe("/explain");
    expect(lastRequest?.body.explanation).toBe("## Explanation");
    expect(lastRequest?.body.title).toBe("Step 1");
  });

  test("startWalkthrough sends steps with autoplay config", async () => {
    // Arrange
    serverResponse = { active: true, currentStep: 0, totalSteps: 2 };
    const steps = [
      { file: "/a.ts", line: 1, explanation: "First" },
      {
        file: "/b.ts",
        line: 5,
        endLine: 10,
        explanation: "Second",
        title: "Step 2",
      },
    ];

    // Act
    const result = await startWalkthrough(steps, true, 3000);

    // Assert
    expect(result.active).toBe(true);
    expect(result.totalSteps).toBe(2);
    expect(lastRequest?.url).toBe("/walkthrough");
    expect(lastRequest?.body.steps).toHaveLength(2);
    expect(lastRequest?.body.autoplay).toBe(true);
    expect(lastRequest?.body.delayMs).toBe(3000);
  });

  test("navigateWalkthrough sends action", async () => {
    // Arrange
    serverResponse = { active: true, currentStep: 1, totalSteps: 3 };

    // Act
    const result = await navigateWalkthrough("next");

    // Assert
    expect(result.currentStep).toBe(1);
    expect(lastRequest?.url).toBe("/walkthrough/navigate");
    expect(lastRequest?.body.action).toBe("next");
  });

  test("navigateWalkthrough goto sends step index", async () => {
    // Arrange
    serverResponse = { active: true, currentStep: 5, totalSteps: 10 };

    // Act
    const result = await navigateWalkthrough("goto", 5);

    // Assert
    expect(result.currentStep).toBe(5);
    expect(lastRequest?.url).toBe("/walkthrough/navigate");
    expect(lastRequest?.body.action).toBe("goto");
    expect(lastRequest?.body.step).toBe(5);
  });

  test("getSelection returns selection data", async () => {
    // Arrange
    serverResponse = {
      ok: true,
      file: "/src/index.ts",
      line: 5,
      endLine: 8,
      text: "const x = 1;",
    };

    // Act
    const result = await getSelection();

    // Assert
    expect(result.ok).toBe(true);
    expect(result.file).toBe("/src/index.ts");
    expect(result.text).toBe("const x = 1;");
  });
});

describe("bridge connection loss and recovery", () => {
  test("returns error on failure but recovers when bridge comes back", async () => {
    // Arrange
    serverResponse = { ok: true };
    await checkBridge();
    expect(isBridgeAvailable()).toBe(true);

    // Act - bridge goes down
    await stopTestServer();
    _setSocketPath("/tmp/nonexistent-socket.sock");
    const failResult = await openFile("/test.ts", 1);

    // Assert - fails
    expect(failResult.ok).toBe(false);

    // Act - bridge comes back
    await startTestServer();
    _setSocketPath(SOCKET_PATH);
    serverResponse = { ok: true };
    const successResult = await openFile("/test.ts", 1);

    // Assert - recovers
    expect(successResult.ok).toBe(true);
  });
});

describe("finding the editor window", () => {
  interface FakeWindow {
    requests: string[];
    close(): Promise<void>;
  }

  const windows: FakeWindow[] = [];
  const plantedFiles: string[] = [];

  // A window's bridge listens on the socket for its workspace folder and names
  // that folder in every reply, so a test can tell which window answered.
  function openWindow(workspace: string): Promise<FakeWindow> {
    const socketPath = socketPathForDir(workspace);
    const requests: string[] = [];
    const server = http.createServer(async (req, res) => {
      await new Promise((drained) => req.resume().on("end", drained));
      requests.push(req.url || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, window: workspace }));
    });
    return new Promise((resolve) => {
      server.listen(socketPath, () => {
        const window: FakeWindow = {
          requests,
          close: () =>
            new Promise((done) => {
              server.close(() => {
                rmSync(socketPath, { force: true });
                done();
              });
            }),
        };
        windows.push(window);
        resolve(window);
      });
    });
  }

  // A socket file with nothing listening, as a crashed window leaves behind.
  function plantStaleSocket(workspace: string): string {
    const socketPath = socketPathForDir(workspace);
    writeFileSync(socketPath, "");
    plantedFiles.push(socketPath);
    return socketPath;
  }

  beforeEach(() => {
    resetBridgeState();
  });

  afterEach(async () => {
    for (const window of windows.splice(0)) await window.close();
    for (const path of plantedFiles.splice(0)) rmSync(path, { force: true });
  });

  test("finds the window from the file being shown when the server runs elsewhere", async () => {
    // Arrange
    const workspace = `${TEST_DIR}-ws-a`;
    const window = await openWindow(workspace);

    // Act
    const result = await openFile(`${workspace}/src/index.ts`, 3);

    // Assert
    expect(result).toEqual({ ok: true, window: workspace });
    expect(window.requests).toEqual(["/open"]);
  });

  test("sends each request to the window whose folder holds the file", async () => {
    // Arrange
    const workspaceA = `${TEST_DIR}-ws-a`;
    const workspaceB = `${TEST_DIR}-ws-b`;
    await openWindow(workspaceA);
    await openWindow(workspaceB);

    // Act
    const inB = await showExplanation(`${workspaceB}/lib/b.ts`, 1, 2, "B");
    const inA = await openFile(`${workspaceA}/src/a.ts`, 1);

    // Assert
    expect(inB.window).toBe(workspaceB);
    expect(inA.window).toBe(workspaceA);
  });

  test("starts a tour in the window that holds its files", async () => {
    // Arrange
    const workspaceA = `${TEST_DIR}-ws-a`;
    const workspaceB = `${TEST_DIR}-ws-b`;
    await openWindow(workspaceA);
    const windowB = await openWindow(workspaceB);

    // Act
    const result = await startWalkthrough([
      { file: `${workspaceB}/one.ts`, line: 1, explanation: "one" },
      { file: `${workspaceB}/two.ts`, line: 1, explanation: "two" },
    ]);

    // Assert
    expect(result.window).toBe(workspaceB);
    expect(windowB.requests).toEqual(["/walkthrough"]);
  });

  test("sends requests without a file to the window that answered last", async () => {
    // Arrange
    const workspace = `${TEST_DIR}-ws-b`;
    const window = await openWindow(workspace);
    await startWalkthrough([
      { file: `${workspace}/one.ts`, line: 1, explanation: "one" },
      { file: `${workspace}/two.ts`, line: 1, explanation: "two" },
    ]);

    // Act
    const navigated = await navigateWalkthrough("next");
    const status = await getWalkthroughStatus();

    // Assert
    expect(navigated.window).toBe(workspace);
    expect(status.window).toBe(workspace);
    expect(window.requests).toEqual([
      "/walkthrough",
      "/walkthrough/navigate",
      "/walkthrough/status",
    ]);
  });

  test("skips a stale socket and tries the next window", async () => {
    // Arrange
    const workspace = `${TEST_DIR}-ws-a`;
    await openWindow(workspace);
    plantStaleSocket(`${workspace}/packages/app`);

    // Act
    const result = await openFile(`${workspace}/packages/app/src/x.ts`, 1);

    // Assert
    expect(result).toEqual({ ok: true, window: workspace });
  });

  test("uses WALKTHROUGH_WORKSPACE when the request names no file", async () => {
    // Arrange
    const workspace = `${TEST_DIR}-ws-a`;
    await openWindow(workspace);
    process.env.WALKTHROUGH_WORKSPACE = workspace;

    // Act
    const result = await navigateWalkthrough("next");

    // Assert
    expect(result.window).toBe(workspace);
  });

  test("says where it looked when no window matches", async () => {
    // Arrange
    const file = "/nowhere/project/src/x.ts";

    // Act
    const result = await openFile(file, 1);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No walkthrough bridge socket found/);
    expect(result.searched).toContain("/nowhere/project/src");
    expect(result.searched).toContain(process.cwd());
    expect(typeof result.otherSockets).toBe("number");
    expect(result.hint).toMatch(/WALKTHROUGH_WORKSPACE/);
  });

  test("names the sockets it found but could not reach", async () => {
    // Arrange
    const workspace = `${TEST_DIR}-ws-stale`;
    const stale = plantStaleSocket(workspace);

    // Act
    const result = await openFile(`${workspace}/x.ts`, 1);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not reach VS Code/);
    expect(result.unreachable).toEqual([stale]);
  });
});
