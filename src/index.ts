#!/usr/bin/env node
import "dotenv/config";
import { execFileSync } from "child_process";
import { program } from "commander";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, extname, join, dirname } from "path";

const API_URLS = {
  default: "https://modulate-developer-apis.com/api/velma-2-stt-batch",
  vfast: "https://modulate-developer-apis.com/api/velma-2-stt-batch-english-vfast",
} as const;

type ModelKey = keyof typeof API_URLS;

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

const SUPPORTED_EXTENSIONS = new Set([
  ".aac", ".aiff", ".flac", ".m4a", ".mp3", ".mp4",
  ".mov", ".ogg", ".opus", ".wav", ".webm",
]);

interface Utterance {
  utterance_uuid: string;
  text: string;
  start_ms: number;
  duration_ms: number;
  speaker: number;
  language: string;
  emotion: string | null;
  accent: string | null;
}

interface TranscriptionResponse {
  text: string;
  duration_ms: number;
  utterances: Utterance[];
}

interface ErrorResponse {
  detail: string | unknown[];
}

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

function defaultJsonPath(filePath: string): string {
  const dir = dirname(filePath);
  const name = basename(filePath, extname(filePath));
  return join(dir, `${name}.json`);
}

/** Formats the default API accepts (per OpenAPI spec). M4A is not in this list. */
const DEFAULT_API_EXTENSIONS = new Set([
  ".aac", ".aiff", ".flac", ".mp3", ".mp4",
  ".mov", ".ogg", ".opus", ".wav", ".webm",
]);

/**
 * Returns path to an Opus file. If input is not .opus, converts via ffmpeg
 * (mono downmix, 64kbps) and saves alongside the original. Reuses existing .opus if present.
 */
function ensureOpusFile(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".opus") return filePath;

  const dir = dirname(filePath);
  const name = basename(filePath, ext);
  const opusPath = join(dir, `${name}.opus`);

  if (existsSync(opusPath)) {
    console.log(`Using existing ${basename(opusPath)}`);
    return opusPath;
  }

  console.log(`Converting to Opus (mono, 64kbps)...`);
  try {
    execFileSync("ffmpeg", [
      "-i", filePath,
      "-ac", "1",       // mono (downmix L+R, not drop)
      "-c:a", "libopus",
      "-b:a", "64k",
      opusPath,
    ], { stdio: "inherit" });
    console.log(`Done. Saved as ${basename(opusPath)}`);
  } catch {
    fatal("Error: ffmpeg conversion failed. Is ffmpeg installed? Run: ffmpeg -encoders | grep opus");
  }
  return opusPath;
}

function toTxtPath(jsonPath: string): string {
  return jsonPath.replace(/\.json$/i, ".txt");
}

function dominantLanguage(utterances: Utterance[]): string {
  const counts: Record<string, number> = {};
  for (const u of utterances) {
    const lang = u.language ?? "unknown";
    counts[lang] = (counts[lang] ?? 0) + 1;
  }
  let max = 0;
  let dominant = "en";
  for (const [lang, count] of Object.entries(counts)) {
    if (count > max) {
      max = count;
      dominant = lang;
    }
  }
  return dominant;
}

function formatCompactTranscript(result: TranscriptionResponse): string {
  const durationSec = (result.duration_ms / 1000).toFixed(1);
  const speakers = [...new Set(result.utterances.map((u) => u.speaker))].sort((a, b) => a - b);
  const dominantLang = dominantLanguage(result.utterances);

  const lines: string[] = [
    `duration: ${durationSec}s`,
    `speakers: ${speakers.length}`,
    "",
    ...result.utterances.map((u) => {
      const startSec = (u.start_ms / 1000).toFixed(1);
      const endSec = ((u.start_ms + u.duration_ms) / 1000).toFixed(1);
      const speakerLabel = `S${u.speaker}`;
      const langTag = u.language && u.language !== dominantLang ? ` [${u.language}]` : "";
      return `[${startSec} - ${endSec}] ${speakerLabel}${langTag}: ${u.text}`;
    }),
  ];

  return lines.join("\n");
}

function jsonToTxt(jsonPath: string, outputPath?: string): void {
  if (!existsSync(jsonPath)) fatal(`Error: File not found: ${jsonPath}`);

  const result = JSON.parse(readFileSync(jsonPath, "utf-8")) as TranscriptionResponse;
  if (!result.utterances || !Array.isArray(result.utterances)) {
    fatal("Error: Invalid transcription JSON (missing utterances array).");
  }

  const txtPath = outputPath ?? toTxtPath(jsonPath);
  writeFileSync(txtPath, formatCompactTranscript(result), "utf-8");

  const audioDurationSec = (result.duration_ms / 1000).toFixed(1);
  console.log(`Done (audio: ${audioDurationSec}s) → ${txtPath}`);
}

interface VfastResponse {
  text: string;
  duration_ms: number;
}

async function transcribe(
  filePath: string,
  options: {
    model: ModelKey;
    convert: boolean;
    diarization: boolean;
    emotion: boolean;
    accent: boolean;
    pii: boolean;
    output?: string;
  }
): Promise<void> {
  const apiKey = process.env.MODULATE_API_KEY;
  if (!apiKey) fatal("Error: MODULATE_API_KEY environment variable is not set.");

  if (!existsSync(filePath)) fatal(`Error: File not found: ${filePath}`);

  const stat = statSync(filePath);
  if (stat.size === 0) fatal("Error: File is empty.");
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    fatal(`Error: File exceeds maximum size of 100MB (${(stat.size / 1024 / 1024).toFixed(1)}MB).`);
  }

  const ext = extname(filePath).toLowerCase();
  const isVfast = options.model === "vfast";

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    fatal(`Error: Unsupported file format "${ext}". Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
  }

  let uploadPath: string;
  if (options.convert) {
    uploadPath = ensureOpusFile(filePath);
  } else {
    if (isVfast && ext !== ".opus") {
      fatal("Error: With --no-convert, vfast model requires a .opus file.");
    }
    if (!isVfast && !DEFAULT_API_EXTENSIONS.has(ext)) {
      fatal(`Error: With --no-convert, file must be in API format. Supported: ${[...DEFAULT_API_EXTENSIONS].join(", ")}`);
    }
    uploadPath = filePath;
  }
  const jsonOutputPath = options.output ?? defaultJsonPath(filePath);

  const fileBuffer = readFileSync(uploadPath);
  const fileName = basename(uploadPath);

  const formData = new FormData();
  formData.append("upload_file", new Blob([fileBuffer]), fileName);

  if (!isVfast) {
    // Only send flags that differ from the API's defaults to avoid sending "undefined"
    if (!options.diarization) formData.append("speaker_diarization", "false");
    if (options.emotion) formData.append("emotion_signal", "true");
    if (options.accent) formData.append("accent_signal", "true");
    if (options.pii) formData.append("pii_phi_tagging", "true");
  }

  const apiUrl = API_URLS[options.model];
  console.log(`Uploading ${fileName} (model: ${options.model})...`);
  const startTime = Date.now();

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: formData,
  });

  const elapsedMs = Date.now() - startTime;
  const body = await response.json() as TranscriptionResponse | VfastResponse | ErrorResponse;

  if (!response.ok) {
    const err = body as ErrorResponse;
    const detail = typeof err.detail === "string"
      ? err.detail
      : JSON.stringify(err.detail, null, 2);
    fatal(`Error ${response.status}: ${detail ?? response.statusText}`);
  }

  let result: TranscriptionResponse;
  if (isVfast) {
    const vfast = body as VfastResponse;
    // Normalize vfast response to TranscriptionResponse for consistent JSON/txt output
    result = {
      text: vfast.text,
      duration_ms: vfast.duration_ms,
      utterances: [{
        utterance_uuid: "",
        text: vfast.text,
        start_ms: 0,
        duration_ms: vfast.duration_ms,
        speaker: 1,
        language: "en",
        emotion: null,
        accent: null,
      }],
    };
  } else {
    result = body as TranscriptionResponse;
  }

  writeFileSync(jsonOutputPath, JSON.stringify(result, null, 2), "utf-8");

  const txtOutputPath = toTxtPath(jsonOutputPath);
  writeFileSync(txtOutputPath, formatCompactTranscript(result), "utf-8");

  const elapsedSec = (elapsedMs / 1000).toFixed(2);
  const audioDurationSec = (result.duration_ms / 1000).toFixed(1);
  console.log(`Transcription complete in ${elapsedSec}s (audio: ${audioDurationSec}s) → ${jsonOutputPath}`);
  console.log(`  → ${txtOutputPath}`);
}

program
  .name("transcribe")
  .description("Transcribe audio using the Modulate Velma-2 STT API, or convert JSON to compact txt")
  .version("1.0.0");

const jsonToTxtCmd = program
  .command("json-to-txt")
  .description("Convert a transcription JSON file to compact .txt format (no API call)")
  .argument("<json-file>", "Transcription JSON file (from a previous transcribe run)")
  .option("-o, --output <path>", "Path to save .txt output (default: <json-file>.txt)");

jsonToTxtCmd.action((jsonFile: string, opts: { output?: string }) => {
  jsonToTxt(jsonFile, opts.output);
});

program
  .argument("<file>", "Audio file to transcribe (AAC, AIFF, FLAC, M4A, MP3, MP4, MOV, OGG, Opus, WAV, WebM — max 100MB)")
  .option("-m, --model <name>", "Model to use: default (multilingual) or vfast (English-only)", "default")
  .option("--no-convert", "Skip conversion to Opus; use file as-is (must be in API-accepted format)")
  .option("--no-diarization", "Disable speaker diarization (default: enabled)")
  .option("--emotion", "Enable emotion detection per utterance (default: disabled)")
  .option("--accent", "Enable accent detection per utterance (default: disabled)")
  .option("--pii", "Enable PII/PHI tagging in transcription text (default: disabled)")
  .option("-o, --output <path>", "Path to save JSON output (default: <input-file>.json)")
  .action(async (file: string, opts: { model: string; convert: boolean; diarization: boolean; emotion: boolean; accent: boolean; pii: boolean; output?: string }) => {
    const model = opts.model === "vfast" ? "vfast" : "default";
    if (opts.model !== "default" && opts.model !== "vfast") {
      fatal(`Error: Invalid model "${opts.model}". Use "default" or "vfast".`);
    }
    await transcribe(file, { ...opts, model });
  });

program.parse();
