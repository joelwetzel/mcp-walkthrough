import { stripMarkdown } from "./tts";
import type { WalkthroughConfig, WalkthroughStep } from "./types";

export type {
  WalkthroughConfig,
  WalkthroughHighlight,
  WalkthroughStep,
} from "./types";

export type NarrationPhase = "show" | "highlight" | "idle" | "inactive";

export interface WalkthroughState {
  phase: NarrationPhase;
  stepIndex: number;
  totalSteps: number;
  file: string | null;
  selection: { line: number; endLine?: number } | null;
  bubble: { text: string; title: string } | null;
  speak: string | null;
  statusLabel: string | null;
  paused: boolean;
}

export interface WalkthroughStatus {
  active: boolean;
  paused: boolean;
  currentStep: number | null;
  totalSteps: number;
  highlight: { index: number; total: number } | null;
  title: string | null;
}

export type ControlResult = { ok: true } | { ok: false; error: string };

export function isActive(state: WalkthroughState): boolean {
  return state.phase !== "inactive";
}

const NOT_RUNNING: ControlResult = {
  ok: false,
  error: "No walkthrough is running",
};

const CONTROLS_MODIFIER = process.platform === "darwin" ? "Cmd" : "Ctrl";
const CONTROL_SEPARATOR = " &nbsp;&nbsp; **|** &nbsp;&nbsp; ";

function controlsLine(paused: boolean): string {
  const control = (arrow: string, label: string) =>
    `\`${CONTROLS_MODIFIER}+Shift+${arrow}\` **${label}**`;
  const controls = [
    control("→", "Next"),
    control("←", "Prev"),
    control("↑", paused ? "Resume" : "Pause"),
    control("↓", "Stop"),
  ];
  return `\n\n---\n${controls.join(CONTROL_SEPARATOR)}`;
}

export interface WalkthroughCoordinator
  extends AsyncIterable<WalkthroughState> {
  start(steps: WalkthroughStep[]): void;
  next(type: "manual" | "auto"): void;
  prev(type: "manual" | "auto"): void;
  goto(stepIndex: number): ControlResult;
  pause(): ControlResult;
  resume(): ControlResult;
  restart(): void;
  stop(): void;
  status(): WalkthroughStatus;
}

function validateStep(step: WalkthroughStep) {
  const stepEnd = step.endLine ?? step.line;
  for (const hl of step.highlights ?? []) {
    const hlEnd = hl.endLine ?? hl.line;
    if (hl.line < step.line || hlEnd > stepEnd) {
      throw new Error(
        `Highlight ${hl.line}-${hlEnd} is outside step range ${step.line}-${stepEnd}`,
      );
    }
  }
}

export function createWalkthroughCoordinator(
  getConfig: () => WalkthroughConfig,
  log: (msg: string) => void = () => {},
): WalkthroughCoordinator {
  let steps: WalkthroughStep[] = [];
  let stepIndex = -1;
  let phase: NarrationPhase = "inactive";
  let highlightIndex = 0;
  let skipNextAuto = false;
  let paused = false;

  let latest: WalkthroughState | null = null;
  let waiting: ((value: WalkthroughState) => void) | null = null;

  function pushState(state: WalkthroughState) {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(state);
    } else {
      latest = state;
    }
  }

  function read(): Promise<WalkthroughState> {
    if (latest !== null) {
      const v = latest;
      latest = null;
      return Promise.resolve(v);
    }
    return new Promise((resolve) => {
      waiting = resolve;
    });
  }

  function inactiveState(): WalkthroughState {
    return {
      phase: "inactive",
      stepIndex: -1,
      totalSteps: 0,
      file: null,
      selection: null,
      bubble: null,
      speak: null,
      statusLabel: null,
      paused: false,
    };
  }

  function computeState(): WalkthroughState {
    if (phase === "inactive" || stepIndex < 0) return inactiveState();

    const step = steps[stepIndex];
    if (!step) return inactiveState();
    const highlights = step.highlights ?? [];
    const voiceEnabled = getConfig().voiceEnabled && !paused;

    const stepLabel = `Step ${stepIndex + 1}/${steps.length}`;
    const hlCount = step.highlights?.length ?? 0;
    const hlLabel =
      phase === "highlight" && hlCount > 0
        ? ` · Highlight ${highlightIndex + 1}/${hlCount}`
        : "";
    const title = step.title
      ? `${stepLabel}${hlLabel}: ${step.title}`
      : `${stepLabel}${hlLabel}`;
    const statusIcon = paused ? "$(debug-pause) Paused ·" : "$(book)";
    const statusLabel = `${statusIcon} ${stepLabel}${hlLabel}${step.title ? ` · ${step.title}` : ""}`;

    const bubbleBase = buildBubbleText(
      step.explanation,
      highlights,
      phase,
      highlightIndex,
    );

    let selection: { line: number; endLine?: number } | null = null;
    let speak: string | null = null;

    if (phase === "show") {
      selection = { line: step.line, endLine: step.endLine };
      speak = voiceEnabled ? stripMarkdown(step.explanation) : null;
    } else if (phase === "highlight") {
      const hl = highlights[highlightIndex];
      if (hl) {
        selection = { line: hl.line, endLine: hl.endLine };
        speak = voiceEnabled ? stripMarkdown(hl.narration) : null;
      }
    }

    return {
      phase,
      stepIndex,
      totalSteps: steps.length,
      file: step.file,
      selection,
      bubble: { text: bubbleBase + controlsLine(paused), title },
      speak,
      statusLabel,
      paused,
    };
  }

  function buildBubbleText(
    explanation: string,
    highlights: { narration: string }[],
    ph: NarrationPhase,
    hlIdx: number,
  ): string {
    if (ph === "show") return explanation;
    if (ph === "highlight") {
      const parts = [explanation];
      for (let i = 0; i <= hlIdx; i++) {
        const h = highlights[i];
        if (h) parts.push(h.narration);
      }
      return parts
        .map((p, i) => (i === parts.length - 1 ? `**${p}**` : p))
        .join("\n\n");
    }
    if (ph === "idle") {
      const parts = [explanation, ...highlights.map((h) => h.narration)];
      return parts.join("\n\n");
    }
    return "";
  }

  function push() {
    pushState(computeState());
  }

  function start(newSteps: WalkthroughStep[]) {
    for (const step of newSteps) validateStep(step);
    steps = newSteps;
    stepIndex = 0;
    phase = "show";
    highlightIndex = 0;
    skipNextAuto = false;
    paused = false;
    latest = null;
    log(`start: ${newSteps.length} steps`);
    push();
  }

  function numHighlights(): number {
    return steps[stepIndex]?.highlights?.length ?? 0;
  }

  // A manual move cuts off the narration in flight, whose auto-advance must
  // be swallowed. A paused tour has no narration in flight, so it only unpauses.
  function takeManualControl() {
    if (paused) {
      paused = false;
    } else {
      skipNextAuto = true;
    }
  }

  function next(type: "manual" | "auto") {
    if (phase === "inactive") return;

    if (type === "auto") {
      if (paused) return;
      if (skipNextAuto) {
        skipNextAuto = false;
        return;
      }
      if (phase === "idle" && !getConfig().autoplay) return;
    } else {
      takeManualControl();
    }

    if (phase === "show") {
      if (numHighlights() > 0) {
        phase = "highlight";
        highlightIndex = 0;
      } else {
        phase = "idle";
      }
    } else if (phase === "highlight") {
      if (highlightIndex < numHighlights() - 1) {
        highlightIndex++;
      } else {
        phase = "idle";
      }
    } else if (phase === "idle") {
      if (stepIndex < steps.length - 1) {
        stepIndex++;
        phase = "show";
        highlightIndex = 0;
      } else {
        stop();
        return;
      }
    }

    log(`next(${type}): step=${stepIndex} phase=${phase} hl=${highlightIndex}`);
    push();
  }

  function prev(type: "manual" | "auto") {
    if (phase === "inactive") return;
    const wasPaused = paused;
    if (type === "manual") takeManualControl();

    if (phase === "highlight") {
      if (highlightIndex > 0) {
        highlightIndex--;
      } else {
        phase = "show";
      }
    } else {
      // idle or show → jump to previous step's show
      if (stepIndex > 0) {
        stepIndex--;
        phase = "show";
        highlightIndex = 0;
      } else if (!wasPaused) {
        return;
      }
    }

    log(`prev(${type}): step=${stepIndex} phase=${phase} hl=${highlightIndex}`);
    push();
  }

  function goto(index: number): ControlResult {
    if (phase === "inactive") return NOT_RUNNING;
    if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
      return {
        ok: false,
        error: `Step ${index} is out of range; this tour has steps 0-${steps.length - 1}`,
      };
    }
    takeManualControl();
    stepIndex = index;
    phase = "show";
    highlightIndex = 0;
    log(`goto: step=${stepIndex}`);
    push();
    return { ok: true };
  }

  function pause(): ControlResult {
    if (phase === "inactive") return NOT_RUNNING;
    if (paused) return { ok: true };
    paused = true;
    // The cut-off narration's auto-advance is ignored while paused, so a skip
    // left over from a manual move would otherwise eat the first one after resume.
    skipNextAuto = false;
    log(`pause: step=${stepIndex} phase=${phase} hl=${highlightIndex}`);
    push();
    return { ok: true };
  }

  function resume(): ControlResult {
    if (phase === "inactive") return NOT_RUNNING;
    if (!paused) return { ok: true };
    paused = false;
    log(`resume: step=${stepIndex} phase=${phase} hl=${highlightIndex}`);
    push();
    return { ok: true };
  }

  function status(): WalkthroughStatus {
    const step = steps[stepIndex];
    if (phase === "inactive" || !step) {
      return {
        active: false,
        paused: false,
        currentStep: null,
        totalSteps: 0,
        highlight: null,
        title: null,
      };
    }
    const total = numHighlights();
    return {
      active: true,
      paused,
      currentStep: stepIndex,
      totalSteps: steps.length,
      highlight:
        phase === "highlight" && total > 0
          ? { index: highlightIndex, total }
          : null,
      title: step.title ?? null,
    };
  }

  function restart() {
    if (phase === "inactive") return;
    takeManualControl();
    if (numHighlights() > 0) {
      phase = "highlight";
      highlightIndex = 0;
    } else {
      phase = "show";
    }
    log(`restart: step=${stepIndex} phase=${phase}`);
    push();
  }

  function stop() {
    steps = [];
    stepIndex = -1;
    phase = "inactive";
    highlightIndex = 0;
    skipNextAuto = false;
    paused = false;
    push();
  }

  return {
    start,
    next,
    prev,
    goto,
    pause,
    resume,
    restart,
    stop,
    status,
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ value: await read(), done: false }),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
}
