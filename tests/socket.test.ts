import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { socketCandidates, socketPathForDir } from "../src/socket";

describe("socketPathForDir", () => {
  test("returns /tmp path with hash suffix", () => {
    // Arrange
    const dir = "/Users/stefan/Projects/ultidev";

    // Act
    const result = socketPathForDir(dir);

    // Assert
    expect(result).toMatch(/^\/tmp\/walkthrough-bridge-[a-f0-9]+\.sock$/);
  });

  test("returns same path for same directory", () => {
    // Arrange
    const dir = "/Users/stefan/Projects/ultidev";

    // Act & Assert
    expect(socketPathForDir(dir)).toBe(socketPathForDir(dir));
  });

  test("returns different paths for different directories", () => {
    // Arrange
    const dir1 = "/Users/stefan/Projects/ultidev";
    const dir2 = "/Users/stefan/Projects/other";

    // Act & Assert
    expect(socketPathForDir(dir1)).not.toBe(socketPathForDir(dir2));
  });

  test("normalizes trailing slashes", () => {
    // Arrange & Act & Assert
    expect(socketPathForDir("/foo/bar/")).toBe(socketPathForDir("/foo/bar"));
  });
});

describe("socketCandidates", () => {
  const created: string[] = [];

  function fakeSocketFor(dir: string): string {
    const socketPath = socketPathForDir(dir);
    writeFileSync(socketPath, "");
    created.push(socketPath);
    return socketPath;
  }

  function cleanup() {
    for (const path of created.splice(0)) rmSync(path, { force: true });
  }

  test("returns nothing when no socket exists", () => {
    // Arrange
    const dirs = ["/nonexistent/path/that/does/not/exist"];

    // Act
    const result = socketCandidates(dirs);

    // Assert
    expect(result).toEqual([]);
  });

  test("returns the socket for the exact directory", () => {
    // Arrange
    const dir = `/tmp/walkthrough-test-${Date.now()}`;
    mkdirSync(dir, { recursive: true });
    const socketPath = fakeSocketFor(dir);

    try {
      // Act
      const result = socketCandidates([dir]);

      // Assert
      expect(result).toEqual([socketPath]);
    } finally {
      cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("walks up to find the socket of a parent directory", () => {
    // Arrange
    const parentDir = `/tmp/walkthrough-test-${Date.now()}`;
    const childDir = `${parentDir}/src/components`;
    mkdirSync(childDir, { recursive: true });
    const socketPath = fakeSocketFor(parentDir);

    try {
      // Act
      const result = socketCandidates([childDir]);

      // Assert
      expect(result).toEqual([socketPath]);
    } finally {
      cleanup();
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  test("finds sockets for directories that are not on disk", () => {
    // Arrange
    const workspace = `/tmp/walkthrough-test-absent-${Date.now()}`;
    const socketPath = fakeSocketFor(workspace);

    try {
      // Act
      const result = socketCandidates([`${workspace}/src/deep`]);

      // Assert
      expect(result).toEqual([socketPath]);
    } finally {
      cleanup();
    }
  });

  test("checks every start directory, keeping their order", () => {
    // Arrange
    const first = `/tmp/walkthrough-test-first-${Date.now()}`;
    const second = `/tmp/walkthrough-test-second-${Date.now()}`;
    const firstSocket = fakeSocketFor(first);
    const secondSocket = fakeSocketFor(second);

    try {
      // Act
      const result = socketCandidates([`${second}/lib`, `${first}/src`]);

      // Assert
      expect(result).toEqual([secondSocket, firstSocket]);
    } finally {
      cleanup();
    }
  });

  test("lists the nearest socket first when nested folders both have one", () => {
    // Arrange
    const outer = `/tmp/walkthrough-test-outer-${Date.now()}`;
    const inner = `${outer}/packages/app`;
    const outerSocket = fakeSocketFor(outer);
    const innerSocket = fakeSocketFor(inner);

    try {
      // Act
      const result = socketCandidates([`${inner}/src`]);

      // Assert
      expect(result).toEqual([innerSocket, outerSocket]);
    } finally {
      cleanup();
    }
  });

  test("lists a socket once when several start directories share it", () => {
    // Arrange
    const workspace = `/tmp/walkthrough-test-shared-${Date.now()}`;
    const socketPath = fakeSocketFor(workspace);

    try {
      // Act
      const result = socketCandidates([
        `${workspace}/src/a`,
        `${workspace}/src/b`,
        workspace,
      ]);

      // Assert
      expect(result).toEqual([socketPath]);
    } finally {
      cleanup();
    }
  });
});
