import { describe, expect, test } from "bun:test";
import {
  createWalkthroughCoordinator,
  type WalkthroughConfig,
  type WalkthroughState,
  type WalkthroughStep,
} from "../vscode-extension/src/walkthrough-coordinator";

function makeConfig(
  overrides: Partial<WalkthroughConfig> = {},
): () => WalkthroughConfig {
  return () => ({
    voice: "en-US-MichelleNeural",
    voiceEnabled: true,
    autoplay: false,
    ...overrides,
  });
}

function makeStep(overrides: Partial<WalkthroughStep> = {}): WalkthroughStep {
  return {
    file: "/test/file.ts",
    line: 1,
    endLine: 100,
    explanation: "Test explanation",
    highlights: [{ line: 5, narration: "Default highlight" }],
    ...overrides,
  };
}

function makeSUT(config = makeConfig()) {
  const sut = createWalkthroughCoordinator(config);
  const iter = sut[Symbol.asyncIterator]();

  async function pull(): Promise<WalkthroughState> {
    const { value } = await iter.next();
    return value;
  }

  return { sut, pull };
}

async function expectNothing(pull: () => Promise<WalkthroughState>) {
  const timeout = new Promise<string>((r) =>
    setTimeout(() => r("timeout"), 50),
  );
  const next = pull().then(() => "state");
  expect(await Promise.race([timeout, next])).toBe("timeout");
}

describe("WalkthroughCoordinator", () => {
  describe("next(auto)", () => {
    test("advances through highlights", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull(); // show

      // Act
      sut.next("auto");

      // Assert
      const state = await pull();
      expect(state.phase).toBe("highlight");
    });

    test("stays at idle when autoplay is off", async () => {
      // Arrange
      const { sut, pull } = makeSUT(makeConfig({ autoplay: false }));
      sut.start([makeStep(), makeStep()]);
      await pull(); // show
      sut.next("auto");
      await pull(); // highlight
      sut.next("auto");
      await pull(); // idle

      // Act
      sut.next("auto");

      // Assert
      await expectNothing(pull);
    });

    test("advances past idle when autoplay is on", async () => {
      // Arrange
      const { sut, pull } = makeSUT(makeConfig({ autoplay: true }));
      sut.start([makeStep(), makeStep()]);
      await pull(); // step 0 show
      sut.next("auto");
      await pull(); // step 0 highlight
      sut.next("auto");
      await pull(); // step 0 idle

      // Act
      sut.next("auto");

      // Assert
      const state = await pull();
      expect(state.stepIndex).toBe(1);
      expect(state.phase).toBe("show");
    });

    test("overwrites stale state after manual prev", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([
        makeStep({
          highlights: [
            { line: 5, narration: "First" },
            { line: 10, narration: "Second" },
          ],
        }),
      ]);
      await pull(); // show
      sut.next("auto"); // pushes highlight 1 into slot
      sut.prev("manual"); // overwrites slot with show

      // Assert
      const state = await pull();
      expect(state.phase).toBe("show");
    });
  });

  describe("next(manual)", () => {
    test("advances past idle regardless of autoplay", async () => {
      // Arrange
      const { sut, pull } = makeSUT(makeConfig({ autoplay: false }));
      sut.start([makeStep(), makeStep()]);
      await pull(); // show
      sut.next("auto");
      await pull(); // highlight
      sut.next("auto");
      await pull(); // idle

      // Act
      sut.next("manual");

      // Assert
      const state = await pull();
      expect(state.stepIndex).toBe(1);
    });

    test("stops at the end", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull(); // show
      sut.next("auto");
      await pull(); // highlight
      sut.next("auto");
      await pull(); // idle

      // Act
      sut.next("manual");

      // Assert
      const state = await pull();
      expect(state.phase).toBe("inactive");
    });
  });

  describe("prev(manual)", () => {
    test("goes back one highlight", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([
        makeStep({
          highlights: [
            { line: 5, narration: "First" },
            { line: 10, narration: "Second" },
          ],
        }),
      ]);
      await pull(); // show
      sut.next("auto");
      await pull(); // highlight 1
      sut.next("auto");
      await pull(); // highlight 2

      // Act
      sut.prev("manual");

      // Assert
      const state = await pull();
      expect(state.phase).toBe("highlight");
      expect(state.speak).toBe("First");
    });

    test("at idle jumps to previous step", async () => {
      // Arrange
      const { sut, pull } = makeSUT(makeConfig({ autoplay: true }));
      sut.start([makeStep(), makeStep()]);
      await pull(); // step 0 show
      sut.next("auto");
      await pull(); // step 0 highlight
      sut.next("auto");
      await pull(); // step 0 idle
      sut.next("auto"); // autoplay → step 1 show
      await pull();
      sut.next("auto");
      await pull(); // step 1 highlight
      sut.next("auto");
      await pull(); // step 1 idle

      // Act
      sut.prev("manual");

      // Assert
      const state = await pull();
      expect(state.stepIndex).toBe(0);
      expect(state.phase).toBe("show");
    });

    test("at show jumps to previous step", async () => {
      // Arrange
      const { sut, pull } = makeSUT(makeConfig({ autoplay: true }));
      sut.start([makeStep(), makeStep()]);
      await pull();
      sut.next("auto");
      await pull();
      sut.next("auto");
      await pull(); // step 0 idle
      sut.next("auto"); // autoplay → step 1 show
      await pull();

      // Act
      sut.prev("manual");

      // Assert
      const state = await pull();
      expect(state.stepIndex).toBe(0);
      expect(state.phase).toBe("show");
    });

    test("no-op at first step first state", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull();

      // Act
      sut.prev("manual");

      // Assert
      await expectNothing(pull);
    });
  });

  describe("restart", () => {
    test("jumps to first highlight of current step", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([
        makeStep({
          highlights: [
            { line: 5, narration: "First" },
            { line: 10, narration: "Second" },
          ],
        }),
      ]);
      await pull(); // show
      sut.next("auto");
      await pull(); // highlight 1
      sut.next("auto");
      await pull(); // highlight 2

      // Act
      sut.restart();

      // Assert
      const state = await pull();
      expect(state.phase).toBe("highlight");
      expect(state.speak).toBe("First");
    });
  });

  describe("stop", () => {
    test("emits inactive", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull();

      // Act
      sut.stop();

      // Assert
      const state = await pull();
      expect(state).toMatchObject({ phase: "inactive", bubble: null });
    });

    test("next after stop is no-op", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull();
      sut.stop();
      await pull(); // inactive

      // Act
      sut.next("auto");

      // Assert
      await expectNothing(pull);
    });
  });

  describe("validation", () => {
    test("throws when highlight is outside step range", () => {
      // Arrange
      const { sut } = makeSUT();

      // Act + Assert
      expect(() =>
        sut.start([
          makeStep({
            line: 10,
            endLine: 20,
            highlights: [{ line: 50, narration: "Outside" }],
          }),
        ]),
      ).toThrow(/outside step range/);
    });
  });

  describe("controls", () => {
    test("every state has controls in bubble", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      const show = await pull();
      sut.next("auto");
      const hl = await pull();

      // Assert
      expect(show.bubble?.text).toContain("**Next**");
      expect(hl.bubble?.text).toContain("**Next**");
    });
  });

  describe("status label", () => {
    test("show phase shows step number only", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep(), makeStep(), makeStep()]);

      // Act
      const state = await pull();

      // Assert
      expect(state.statusLabel).toContain("Step 1/3");
      expect(state.statusLabel).not.toContain("Highlight");
    });

    test("highlight phase shows step and highlight number", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([
        makeStep({
          highlights: [
            { line: 5, narration: "First" },
            { line: 10, narration: "Second" },
            { line: 15, narration: "Third" },
          ],
        }),
      ]);
      await pull(); // show
      sut.next("auto");
      await pull(); // highlight 1
      sut.next("auto");

      // Act
      const state = await pull(); // highlight 2

      // Assert
      expect(state.statusLabel).toContain("Step 1/1");
      expect(state.statusLabel).toContain("Highlight 2/3");
    });

    test("idle phase shows step number only", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull(); // show
      sut.next("auto");
      await pull(); // highlight
      sut.next("auto");

      // Act
      const state = await pull(); // idle

      // Assert
      expect(state.statusLabel).toContain("Step 1/1");
      expect(state.statusLabel).not.toContain("Highlight");
    });

    test("paused tour says so", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep({ title: "Setup" }), makeStep()]);
      await pull(); // show

      // Act
      sut.pause();

      // Assert
      const state = await pull();
      expect(state.statusLabel).toContain("Paused");
      expect(state.statusLabel).toContain("Step 1/2");
      expect(state.statusLabel).toContain("Setup");
    });
  });

  describe("pause", () => {
    test("emits the current position without speech", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull(); // show
      sut.next("auto");
      await pull(); // highlight

      // Act
      const result = sut.pause();

      // Assert
      expect(result).toEqual({ ok: true });
      const state = await pull();
      expect(state).toMatchObject({
        phase: "highlight",
        paused: true,
        speak: null,
      });
    });

    test("ignores auto-advance while paused", async () => {
      // Arrange
      const { sut, pull } = makeSUT(makeConfig({ autoplay: true }));
      sut.start([makeStep(), makeStep()]);
      await pull(); // show
      sut.pause();
      await pull(); // paused

      // Act
      sut.next("auto");

      // Assert
      await expectNothing(pull);
    });

    test("fails when no tour is running", () => {
      // Arrange
      const { sut } = makeSUT();

      // Act
      const result = sut.pause();

      // Assert
      expect(result).toEqual({ ok: false, error: "No walkthrough is running" });
    });
  });

  describe("resume", () => {
    test("replays the current narration", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([
        makeStep({
          highlights: [
            { line: 5, narration: "First" },
            { line: 10, narration: "Second" },
          ],
        }),
      ]);
      await pull(); // show
      sut.next("auto");
      await pull(); // highlight 1
      sut.next("auto");
      await pull(); // highlight 2
      sut.pause();
      await pull(); // paused

      // Act
      const result = sut.resume();

      // Assert
      expect(result).toEqual({ ok: true });
      const state = await pull();
      expect(state).toMatchObject({
        phase: "highlight",
        paused: false,
        speak: "Second",
      });
    });

    test("auto-advances after the replay", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull(); // show
      sut.pause();
      await pull(); // paused
      sut.resume();
      await pull(); // show replay

      // Act
      sut.next("auto");

      // Assert
      const state = await pull();
      expect(state.phase).toBe("highlight");
    });

    test("auto-advances when paused right after a manual step", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull(); // show
      sut.next("manual");
      await pull(); // highlight
      sut.pause();
      await pull(); // paused
      sut.resume();
      await pull(); // highlight replay

      // Act
      sut.next("auto");

      // Assert
      const state = await pull();
      expect(state.phase).toBe("idle");
    });

    test("fails when no tour is running", () => {
      // Arrange
      const { sut } = makeSUT();

      // Act
      const result = sut.resume();

      // Assert
      expect(result).toEqual({ ok: false, error: "No walkthrough is running" });
    });
  });

  describe("next(manual) while paused", () => {
    test("resumes at the next position and keeps auto-advancing", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull(); // show
      sut.pause();
      await pull(); // paused
      sut.next("manual");
      const moved = await pull(); // highlight

      // Act
      sut.next("auto");

      // Assert
      expect(moved).toMatchObject({
        phase: "highlight",
        paused: false,
        speak: "Default highlight",
      });
      const state = await pull();
      expect(state.phase).toBe("idle");
    });
  });

  describe("goto", () => {
    test("jumps to the start of a step", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep(), makeStep(), makeStep()]);
      await pull(); // step 0 show

      // Act
      const result = sut.goto(2);

      // Assert
      expect(result).toEqual({ ok: true });
      const state = await pull();
      expect(state).toMatchObject({ stepIndex: 2, phase: "show" });
    });

    test("swallows the auto-advance of the narration it cut off", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep(), makeStep()]);
      await pull(); // step 0 show
      sut.goto(1);
      await pull(); // step 1 show

      // Act
      sut.next("auto");

      // Assert
      await expectNothing(pull);
    });

    test("resumes a paused tour", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep(), makeStep()]);
      await pull(); // step 0 show
      sut.pause();
      await pull(); // paused

      // Act
      sut.goto(1);

      // Assert
      const state = await pull();
      expect(state).toMatchObject({ stepIndex: 1, paused: false });
      expect(state.speak).not.toBeNull();
    });

    test("rejects a step outside the tour", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep(), makeStep()]);
      await pull();

      // Act
      const result = sut.goto(2);

      // Assert
      expect(result).toEqual({
        ok: false,
        error: "Step 2 is out of range; this tour has steps 0-1",
      });
      await expectNothing(pull);
    });

    test("rejects a step that is not a whole number", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep(), makeStep()]);
      await pull();

      // Act
      const result = sut.goto(0.5);

      // Assert
      expect(result.ok).toBe(false);
    });

    test("fails when no tour is running", () => {
      // Arrange
      const { sut } = makeSUT();

      // Act
      const result = sut.goto(0);

      // Assert
      expect(result).toEqual({ ok: false, error: "No walkthrough is running" });
    });
  });

  describe("status", () => {
    test("reports no tour when inactive", () => {
      // Arrange
      const { sut } = makeSUT();

      // Act
      const status = sut.status();

      // Assert
      expect(status).toEqual({
        active: false,
        paused: false,
        currentStep: null,
        totalSteps: 0,
        highlight: null,
        title: null,
      });
    });

    test("reports the step and highlight mid-tour", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([
        makeStep(),
        makeStep({
          title: "Routing",
          highlights: [
            { line: 5, narration: "First" },
            { line: 10, narration: "Second" },
          ],
        }),
      ]);
      await pull();
      sut.goto(1);
      await pull(); // step 1 show
      sut.next("manual");
      await pull(); // highlight 1
      sut.next("manual");
      await pull(); // highlight 2

      // Act
      const status = sut.status();

      // Assert
      expect(status).toEqual({
        active: true,
        paused: false,
        currentStep: 1,
        totalSteps: 2,
        highlight: { index: 1, total: 2 },
        title: "Routing",
      });
    });

    test("reports a paused tour", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull();
      sut.pause();
      await pull();

      // Act
      const status = sut.status();

      // Assert
      expect(status).toMatchObject({
        active: true,
        paused: true,
        currentStep: 0,
        highlight: null,
      });
    });

    test("start clears a pause", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull();
      sut.pause();
      await pull();

      // Act
      sut.start([makeStep()]);

      // Assert
      const state = await pull();
      expect(state.paused).toBe(false);
      expect(sut.status().paused).toBe(false);
    });

    test("stop clears a pause", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull();
      sut.pause();
      await pull();

      // Act
      sut.stop();

      // Assert
      const state = await pull();
      expect(state.paused).toBe(false);
      expect(sut.status().paused).toBe(false);
    });
  });

  describe("pause control", () => {
    test("offers Pause while playing", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);

      // Act
      const state = await pull();

      // Assert
      expect(state.bubble?.text).toContain("Shift+↑` **Pause**");
      expect(state.bubble?.text).not.toContain("**Resume**");
    });

    test("offers Resume while paused", async () => {
      // Arrange
      const { sut, pull } = makeSUT();
      sut.start([makeStep()]);
      await pull();

      // Act
      sut.pause();

      // Assert
      const state = await pull();
      expect(state.bubble?.text).toContain("Shift+↑` **Resume**");
      expect(state.bubble?.text).not.toContain("**Pause**");
    });
  });
});
