# modulate-examples

Simple CLI demo for transcribing audio with the [Modulate Velma-2 STT API](https://www.modulate-developer-apis.com/web/docs.html).

## Setup

```bash
pnpm install
cp .env.example .env   # add your MODULATE_API_KEY
```

## Usage

Transcribe an audio file (writes `.json` and `.txt` alongside it):

```bash
pnpm transcribe sample.mp3
```

**Transcribe options:**
- `-m, --model <name>` — Model: `default` (multilingual) or `vfast` (English-only). Default: `default`
- `--no-convert` — Skip conversion to Opus; use file as-is (must be in API-accepted format)
- `-o, --output <path>` — Where to save JSON (default: `<input>.json`)
- `--no-diarization` — Turn off speaker diarization (default: on)
- `--emotion` — Enable emotion detection per utterance
- `--accent` — Enable accent detection per utterance
- `--pii` — Enable PII/PHI tagging in the transcript

Convert existing JSON to the compact text format without re-processing:

```bash
pnpm transcribe json-to-txt sample.json
```

**json-to-txt options:**
- `-o, --output <path>` — Where to save .txt (default: `<json-file>.txt`)

Supported audio formats: AAC, AIFF, FLAC, M4A, MP3, MP4, MOV, OGG, Opus, WAV, WebM (max 100MB).

## Conversion to Opus

By default, the CLI converts all input to [Opus](https://opus-codec.org/) (mono, 64 kbps) before uploading, which reduces file size and speeds up uploads. Conversion uses FFmpeg and reuses an existing `.opus` file if present alongside the input.

```bash
# Pass any format; converts to Opus on first run, reuses sample.opus on subsequent runs
pnpm transcribe sample.m4a
pnpm transcribe sample.m4a -m vfast
```

Use `--no-convert` to skip conversion and upload the file as-is (must be in API-accepted format; vfast requires `.opus`).

**Requirement:** FFmpeg must be installed with Opus support. Check: `ffmpeg -encoders | grep opus`
