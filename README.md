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

Supported audio formats: AAC, AIFF, FLAC, MP3, MP4, MOV, OGG, Opus, WAV, WebM (max 100MB).
