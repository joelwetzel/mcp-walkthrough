import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

let currentProcess: ChildProcess | null = null;
let speechGeneration = 0;
let edgeTts: MsEdgeTTS | null = null;
let edgeTtsDir: string | null = null;
let currentVoice: string | null = null;

export function stripMarkdown(text: string): string {
  return text
    .replace(/\\n/g, "\n")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/\n{2,}/g, " ")
    .replace(/\n/g, " ")
    .trim();
}

function runProcess(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    killPlayer();

    try {
      const proc = spawn(cmd, args, { stdio: "ignore" });
      currentProcess = proc;

      proc.on("close", () => {
        if (currentProcess === proc) currentProcess = null;
        resolve();
      });

      proc.on("error", () => {
        if (currentProcess === proc) currentProcess = null;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

async function getEdgeTts(voice: string): Promise<MsEdgeTTS> {
  if (!edgeTts || currentVoice !== voice) {
    edgeTts = new MsEdgeTTS();
    await edgeTts.setMetadata(
      voice,
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
    );
    currentVoice = voice;
    edgeTtsDir = join(tmpdir(), `walkthrough-tts-${process.pid}`);
    mkdirSync(edgeTtsDir, { recursive: true });
  }
  return edgeTts;
}

function getPlayerArgs(filePath: string): [string, string[]] | null {
  if (process.platform === "darwin") return ["afplay", [filePath]];
  if (process.platform === "linux") return ["mpg123", ["-q", filePath]];
  if (process.platform === "win32") {
    const b64 = Buffer.from(
      `Add-Type -AssemblyName presentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([Uri]"${filePath.replace(/"/g, '`"')}"); $p.Play(); Start-Sleep -Seconds 300`,
      "utf16le",
    ).toString("base64");
    return ["powershell", ["-EncodedCommand", b64]];
  }
  return null;
}

async function speakEdgeTts(
  text: string,
  voice: string,
  isCurrent: () => boolean,
): Promise<void> {
  const tts = await getEdgeTts(voice);
  if (!edgeTtsDir) throw new Error("Edge TTS dir not initialized");
  const result = await tts.toFile(edgeTtsDir, text);
  const playerArgs = getPlayerArgs(result.audioFilePath);
  if (playerArgs && isCurrent()) {
    await runProcess(...playerArgs);
  }
  try {
    rmSync(result.audioFilePath, { force: true });
  } catch {}
}

function speakNative(text: string): Promise<void> {
  if (process.platform === "darwin") return runProcess("say", [text]);
  if (process.platform === "linux") return runProcess("espeak", [text]);
  if (process.platform === "win32") {
    const b64 = Buffer.from(
      `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak("${text.replace(/"/g, '`"')}")`,
      "utf16le",
    ).toString("base64");
    return runProcess("powershell", ["-EncodedCommand", b64]);
  }
  return Promise.resolve();
}

export async function speak(text: string, voice: string): Promise<void> {
  // Edge TTS synthesizes before any player exists, so a stop during synthesis
  // has nothing to kill; the generation check keeps that audio from playing.
  const generation = speechGeneration;
  const isCurrent = () => generation === speechGeneration;
  try {
    await speakEdgeTts(text, voice, isCurrent);
  } catch {
    if (isCurrent()) await speakNative(text);
  }
}

function killPlayer(): void {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
  }
}

export function stopSpeaking(): void {
  speechGeneration++;
  killPlayer();
}

export function cleanupTts(): void {
  stopSpeaking();
  if (edgeTtsDir) {
    try {
      rmSync(edgeTtsDir, { recursive: true, force: true });
    } catch {}
  }
}
