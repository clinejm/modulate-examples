#!/usr/bin/env node
import "dotenv/config";
import { program } from "commander";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, extname, join, dirname } from "path";

const API_URL = "https://modulate-developer-apis.com/api/velma-2-stt-batch";
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

const SUPPORTED_EXTENSIONS = new Set([
  ".aac", ".aiff", ".flac", ".mp3", ".mp4",
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

async function transcribe(
  filePath: string,
  options: {
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
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    fatal(`Error: Unsupported file format "${ext}". Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
  }

  const jsonOutputPath = options.output ?? defaultJsonPath(filePath);

  const fileBuffer = readFileSync(filePath);
  const fileName = basename(filePath);

  const formData = new FormData();
  formData.append("upload_file", new Blob([fileBuffer]), fileName);
  // Only send flags that differ from the API's defaults to avoid sending "undefined"
  if (!options.diarization) formData.append("speaker_diarization", "false");
  if (options.emotion) formData.append("emotion_signal", "true");
  if (options.accent) formData.append("accent_signal", "true");
  if (options.pii) formData.append("pii_phi_tagging", "true");

  console.log(`Transcribing ${fileName}...`);
  const startTime = Date.now();

  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: formData,
  });

  const elapsedMs = Date.now() - startTime;
  const body = await response.json() as TranscriptionResponse | ErrorResponse;

  if (!response.ok) {
    const err = body as ErrorResponse;
    const detail = typeof err.detail === "string"
      ? err.detail
      : JSON.stringify(err.detail, null, 2);
    fatal(`Error ${response.status}: ${detail ?? response.statusText}`);
  }

  const result = body as TranscriptionResponse;

  writeFileSync(jsonOutputPath, JSON.stringify(result, null, 2), "utf-8");

  const txtOutputPath = toTxtPath(jsonOutputPath);
  writeFileSync(txtOutputPath, formatCompactTranscript(result), "utf-8");

  const elapsedSec = (elapsedMs / 1000).toFixed(2);
  const audioDurationSec = (result.duration_ms / 1000).toFixed(1);
  console.log(`Done in ${elapsedSec}s (audio: ${audioDurationSec}s) → ${jsonOutputPath}`);
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
  .argument("<file>", "Audio file to transcribe (AAC, AIFF, FLAC, MP3, MP4, MOV, OGG, Opus, WAV, WebM — max 100MB)")
  .option("--no-diarization", "Disable speaker diarization (default: enabled)")
  .option("--emotion", "Enable emotion detection per utterance (default: disabled)")
  .option("--accent", "Enable accent detection per utterance (default: disabled)")
  .option("--pii", "Enable PII/PHI tagging in transcription text (default: disabled)")
  .option("-o, --output <path>", "Path to save JSON output (default: <input-file>.json)")
  .action(async (file: string, opts: { diarization: boolean; emotion: boolean; accent: boolean; pii: boolean; output?: string }) => {
    await transcribe(file, opts);
  });

program.parse();
