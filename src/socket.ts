import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOCKET_DIR = "/tmp";
const SOCKET_PREFIX = "walkthrough-bridge-";

export function socketPathForDir(dir: string): string {
  const normalized = dir.replace(/\/+$/, "");
  const hash = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
  return join(SOCKET_DIR, `${SOCKET_PREFIX}${hash}.sock`);
}

// Each start directory is walked up to the filesystem root, nearest folder
// first, because the editor listens for its workspace folder, which may be
// any ancestor of the file being shown.
export function socketCandidates(startDirs: string[]): string[] {
  const found: string[] = [];
  for (const start of startDirs) {
    let dir = resolve(start);
    while (true) {
      const socketPath = socketPathForDir(dir);
      if (!found.includes(socketPath) && existsSync(socketPath)) {
        found.push(socketPath);
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return found;
}

// The spec requires file:// URIs, but Cursor sends plain absolute paths.
// Roots that are not local folders, such as remote workspaces, can have no
// bridge socket on this machine, so they are dropped.
export function rootsToDirs(roots: { uri: string }[]): string[] {
  return roots.flatMap((root) => {
    if (isAbsolute(root.uri)) return [root.uri];
    try {
      return [fileURLToPath(root.uri)];
    } catch {
      return [];
    }
  });
}

export function allBridgeSockets(): string[] {
  try {
    return readdirSync(SOCKET_DIR)
      .filter(
        (name) => name.startsWith(SOCKET_PREFIX) && name.endsWith(".sock"),
      )
      .map((name) => join(SOCKET_DIR, name));
  } catch {
    return [];
  }
}
