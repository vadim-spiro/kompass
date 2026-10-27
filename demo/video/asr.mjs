// Transcribes voiceover takes with Whisper (base.en, word timestamps), locally through transformers.js.
// tts.py calls it to check each take against the script and to time on-screen words to the voice:
//   node asr.mjs <out.json> <take.wav>...
// Writes { "<file name>": { text, words: [{ w, t, end }] } }.
// It uses the transformers.js install and the cached model of the Claude Maxxing app; point
// TRANSFORMERS_JS and WHISPER_CACHE elsewhere if they live somewhere else. Without them tts.py
// still works, it just cannot check the words.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";

const LIB = process.env.TRANSFORMERS_JS ?? `${homedir()}/Documents/github/Claude-Maxxing/node_modules/@huggingface/transformers/dist/transformers.node.mjs`;
const CACHE = process.env.WHISPER_CACHE ?? `${homedir()}/Library/Caches/claude-maxxing/r4b/hf-cache/`;
const MODEL = "onnx-community/whisper-base.en_timestamped";

const [out, ...files] = process.argv.slice(2);
const { pipeline, env } = await import(LIB);
env.allowRemoteModels = false;
env.localModelPath = CACHE;
const asr = await pipeline("automatic-speech-recognition", MODEL, { dtype: { encoder_model: "fp32", decoder_model_merged: "q4" }, device: "cpu" });

const result = {};
for (const f of files) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", f, "-ar", "16000", "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const r = await asr(audio, { return_timestamps: "word" });
  result[basename(f)] = {
    text: r.text.trim(),
    words: (r.chunks ?? []).map((c) => ({ w: c.text.trim(), t: Math.round(c.timestamp[0] * 1000) / 1000, end: Math.round((c.timestamp[1] ?? c.timestamp[0]) * 1000) / 1000 })),
  };
}
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(`[asr] ${files.length} take(s) transcribed`);
