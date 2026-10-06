import { describe, expect, test } from "bun:test";
import { WalkthroughDispatcherUseCase } from "../src/use-cases/walkthrough-dispatcher";

function makeSUT() {
  const sut = new WalkthroughDispatcherUseCase();
  return { sut };
}

describe("WalkthroughDispatcherUseCase", () => {
  describe("getStatus — empty args return current walkthrough state", () => {
    test("empty args returns getStatus", () => {
      // Arrange
      const { sut } = makeSUT();
      const input = {};

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({ type: "getStatus" });
    });
  });

  describe("clear — action 'clear' removes all bubbles", () => {
    test("action 'clear' returns clear dispatch", () => {
      // Arrange
      const { sut } = makeSUT();
      const input = { action: "clear" as const };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({ type: "clear" });
    });
  });

  describe("navigate — actions control an active tour", () => {
    test.each([
      "next",
      "prev",
      "stop",
      "pause",
      "resume",
    ] as const)("action '%s' returns navigate dispatch", (action) => {
      // Arrange
      const { sut } = makeSUT();
      const input = { action };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({ type: "navigate", action });
    });

    test("action 'goto' with step returns navigate dispatch with step", () => {
      // Arrange
      const { sut } = makeSUT();
      const input = { action: "goto" as const, step: 2 };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({ type: "navigate", action: "goto", step: 2 });
    });

    test("action 'goto' without step still returns navigate dispatch", () => {
      // Arrange
      const { sut } = makeSUT();
      const input = { action: "goto" as const };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({ type: "navigate", action: "goto" });
    });
  });

  describe("singleExplain — 1 step with explanation shows an inline bubble", () => {
    test("single step with explanation returns singleExplain", () => {
      // Arrange
      const { sut } = makeSUT();
      const step = {
        file: "/test.ts",
        line: 1,
        endLine: 5,
        explanation: "does X",
      };
      const input = { steps: [step] };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({ type: "singleExplain", step });
    });
  });

  describe("highlightOnly — 1 step without explanation just highlights", () => {
    test("single step without explanation returns highlightOnly", () => {
      // Arrange
      const { sut } = makeSUT();
      const input = {
        steps: [{ file: "/test.ts", line: 1, endLine: 5 }],
      };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({
        type: "highlightOnly",
        file: "/test.ts",
        line: 1,
        endLine: 5,
      });
    });

    test("single step without explanation preserves char offsets", () => {
      // Arrange
      const { sut } = makeSUT();
      const input = {
        steps: [
          {
            file: "/test.ts",
            line: 1,
            endLine: 1,
            startChar: 2,
            endChar: 10,
          },
        ],
      };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({
        type: "highlightOnly",
        file: "/test.ts",
        line: 1,
        endLine: 1,
        startChar: 2,
        endChar: 10,
      });
    });
  });

  describe("startWalkthrough — 2+ steps start a narrated tour", () => {
    test("multiple steps returns startWalkthrough", () => {
      // Arrange
      const { sut } = makeSUT();
      const steps = [
        { file: "/a.ts", line: 1, explanation: "step 1" },
        { file: "/b.ts", line: 1, explanation: "step 2" },
      ];
      const input = { steps };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({ type: "startWalkthrough", steps });
    });
  });

  describe("invalid — a tour's highlights must sit inside their step", () => {
    test("highlight outside its step returns invalid naming the step and both ranges", () => {
      // Arrange
      const { sut } = makeSUT();
      const input = {
        steps: [
          { file: "/a.ts", line: 1, explanation: "intro" },
          {
            file: "/b.ts",
            line: 290,
            endLine: 325,
            title: "Commit handler",
            explanation: "x",
            highlights: [
              { line: 300, endLine: 310, narration: "inside" },
              { line: 444, endLine: 455, narration: "outside" },
            ],
          },
        ],
      };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result.type).toBe("invalid");
      if (result.type !== "invalid") return;
      expect(result.error).toContain('Step 2 ("Commit handler")');
      expect(result.error).toContain("444-455");
      expect(result.error).toContain("290-325");
    });

    test("reports every highlight outside its step, not just the first", () => {
      // Arrange
      const { sut } = makeSUT();
      const input = {
        steps: [
          {
            file: "/a.ts",
            line: 10,
            endLine: 20,
            explanation: "x",
            highlights: [{ line: 5, narration: "before" }],
          },
          {
            file: "/b.ts",
            line: 30,
            explanation: "y",
            highlights: [{ line: 30, endLine: 31, narration: "past the end" }],
          },
        ],
      };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result.type).toBe("invalid");
      if (result.type !== "invalid") return;
      expect(result.error).toContain("Step 1");
      expect(result.error).toContain("5-5");
      expect(result.error).toContain("Step 2");
      expect(result.error).toContain("30-31");
      expect(result.error).toContain("30-30");
    });

    test("highlights on the step's first and last lines start the tour", () => {
      // Arrange
      const { sut } = makeSUT();
      const steps = [
        {
          file: "/a.ts",
          line: 10,
          endLine: 20,
          explanation: "x",
          highlights: [
            { line: 10, narration: "first line" },
            { line: 12, endLine: 20, narration: "through the last line" },
          ],
        },
        { file: "/b.ts", line: 1, explanation: "y" },
      ];

      // Act
      const result = sut.execute({ steps });

      // Assert
      expect(result).toEqual({ type: "startWalkthrough", steps });
    });

    test("a single explain keeps highlights outside its range, as before", () => {
      // Arrange
      const { sut } = makeSUT();
      const step = {
        file: "/a.ts",
        line: 10,
        endLine: 20,
        explanation: "x",
        highlights: [{ line: 40, narration: "elsewhere" }],
      };

      // Act
      const result = sut.execute({ steps: [step] });

      // Assert
      expect(result).toEqual({ type: "singleExplain", step });
    });
  });

  describe("precedence — steps beat action, empty arrays fall through", () => {
    test("steps and action both provided: steps wins", () => {
      // Arrange
      const { sut } = makeSUT();
      const step = { file: "/a.ts", line: 1, explanation: "x" };
      const input = { steps: [step], action: "clear" as const };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({ type: "singleExplain", step });
    });

    test("empty steps array falls through to action", () => {
      // Arrange
      const { sut } = makeSUT();
      const input = { steps: [], action: "clear" as const };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({ type: "clear" });
    });

    test("empty steps array with no action falls through to getStatus", () => {
      // Arrange
      const { sut } = makeSUT();
      const input = { steps: [] };

      // Act
      const result = sut.execute(input);

      // Assert
      expect(result).toEqual({ type: "getStatus" });
    });
  });
});
