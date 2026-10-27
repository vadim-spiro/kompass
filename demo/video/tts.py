"""Generates the voiceover clips of the demo video with Qwen3-TTS (local, no network).

Reads demo/video/script.json and writes demo/assets/vo/<id>.wav plus manifest.json. A line is only
generated again when its text, voice or seed changed (or with --force), so the committed clips are
reused and the video renders without the speech model.

Each line is spoken three times (seed, seed + 100, seed + 200). Whisper (asr.mjs) transcribes the
takes; the take that matches the script best is kept, ties going to the length closest to the median
(a take that skipped words or ran on is an outlier). The clip is trimmed and levelled to the same
speech loudness as the others. The manifest keeps Whisper's word timings, so the video can show each
word as it is spoken. Without Whisper the median-length take is kept.

Runtime: qwentts.cpp (Metal) through the `qwentts_cpp` package and the Qwen3-TTS 0.6B CustomVoice GGUF
weights from the Hugging Face cache (Serveurperso/Qwen3-TTS-GGUF). On this Mac they live in the
Claude Maxxing voice env:
    "$HOME/Library/Application Support/claude-maxxing-voice/tts-env/bin/python" -I demo/video/tts.py
Override the weights with QWEN_TTS_TALKER and QWEN_TTS_CODEC.

Usage: tts.py [--force] [ids...]   (ids limit the run to those lines; --force regenerates them)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "script.json"
OUT = HERE.parent / "assets" / "vo"
MANIFEST = OUT / "manifest.json"
TAKES = HERE.parent / "out" / "vo-takes"
TARGET_RMS_DB = -19.0  # speech loudness of every clip (RMS over voiced frames)
PEAK_DB = -1.0


def log(msg: str) -> None:
    print(f"[vo {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def find_weights() -> tuple[Path, Path]:
    talker = os.environ.get("QWEN_TTS_TALKER")
    codec = os.environ.get("QWEN_TTS_CODEC")
    if talker and codec:
        return Path(talker), Path(codec)
    snaps = Path.home() / ".cache/huggingface/hub/models--Serveurperso--Qwen3-TTS-GGUF/snapshots"
    for snap in sorted(snaps.glob("*")) if snaps.exists() else []:
        for quant in ("BF16", "Q8_0", "Q4_K_M"):
            t = snap / f"qwen-talker-0.6b-customvoice-{quant}.gguf"
            c = next((snap / f"qwen-tokenizer-12hz-{q}.gguf" for q in (quant, "Q8_0", "BF16") if (snap / f"qwen-tokenizer-12hz-{q}.gguf").exists()), None)
            if t.exists() and c:
                return t, c
    sys.exit("No Qwen3-TTS CustomVoice weights found. Set QWEN_TTS_TALKER and QWEN_TTS_CODEC.")


def key_of(line: dict, voice: str, talker: Path) -> str:
    raw = json.dumps([line.get("say") or line["text"], line.get("voice") or voice, line.get("seed", 1), talker.name], ensure_ascii=False)
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def frame_rms(x: np.ndarray, sr: int, ms: float = 10.0) -> np.ndarray:
    n = max(1, int(sr * ms / 1000))
    usable = len(x) // n * n
    if usable == 0:
        return np.zeros(1)
    return np.sqrt(np.mean(x[:usable].reshape(-1, n) ** 2, axis=1) + 1e-12)


def trim(x: np.ndarray, sr: int) -> np.ndarray:
    """Cuts leading and trailing silence, keeping 60 ms before the voice and 120 ms after it."""
    r = frame_rms(x, sr)
    on = np.where(20 * np.log10(r) > 20 * np.log10(r.max()) - 38)[0]
    if len(on) == 0:
        return x
    a = max(0, on[0] * sr // 100 - int(0.06 * sr))
    b = min(len(x), (on[-1] + 1) * sr // 100 + int(0.12 * sr))
    y = x[a:b].copy()
    fade = min(len(y) // 4, int(0.008 * sr))
    if fade > 0:
        y[:fade] *= np.linspace(0, 1, fade)
        y[-fade:] *= np.linspace(1, 0, fade)
    return y


def level(x: np.ndarray, sr: int) -> np.ndarray:
    r = frame_rms(x, sr)
    voiced = r[20 * np.log10(r) > 20 * np.log10(r.max()) - 30]
    rms = float(np.sqrt(np.mean(voiced**2))) if len(voiced) else float(np.sqrt(np.mean(x**2)))
    y = x * (10 ** (TARGET_RMS_DB / 20) / max(rms, 1e-6))
    peak = float(np.abs(y).max())
    if peak > 10 ** (PEAK_DB / 20):
        y *= 10 ** (PEAK_DB / 20) / peak
    return y


def write_wav(path: Path, x: np.ndarray, sr: int) -> None:
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def words_of(s: str) -> list[str]:
    """Letter words only: numbers are spelled differently by the script and by Whisper."""
    return [w for w in re.findall(r"[a-z']+", s.lower().replace("’", "'")) if not w.isdigit()]


def match(expected: str, heard: str) -> float:
    """Share of the script's words Whisper heard in order (longest common subsequence)."""
    a, b = words_of(expected), words_of(heard)
    if not a:
        return 1.0
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b):
            cur.append(prev[j] + 1 if x == y or (len(x) > 3 and x[:4] == y[:4]) else max(prev[j + 1], cur[j]))
        prev = cur
    extra = max(0, len(b) - len(a)) * 0.5  # words Whisper heard that the script does not have
    return max(0.0, (prev[-1] - extra) / len(a))


def transcribe(files: list[Path]) -> dict:
    out = TAKES / "asr.json"
    try:
        subprocess.run(["node", str(HERE / "asr.mjs"), str(out), *map(str, files)], check=True, capture_output=True, text=True, timeout=600)
        return json.loads(out.read_text())
    except Exception as e:  # Whisper is optional
        log(f"no word check (Whisper not available: {str(e).splitlines()[0][:120]})")
        return {}


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    script = json.loads(SCRIPT.read_text())
    voice, lang = script["voice"], script.get("lang", "english")
    OUT.mkdir(parents=True, exist_ok=True)
    TAKES.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    talker, codec = find_weights()

    todo = []
    for line in script["lines"]:
        if args and line["id"] not in args:
            continue
        k = key_of(line, voice, talker)
        have = manifest.get(line["id"])
        if not force and have and have.get("key") == k and "words" in have and (OUT / f"{line['id']}.wav").exists():
            continue
        todo.append((line, k))
    ids = {l["id"] for l in script["lines"]}
    for gone in [i for i in manifest if i not in ids]:
        manifest.pop(gone)
        (OUT / f"{gone}.wav").unlink(missing_ok=True)
    if not todo:
        log(f"all {len(script['lines'])} clips are up to date")
        MANIFEST.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")
        return

    t0 = time.time()
    tts = None
    takes: dict[str, list[dict]] = {}
    for line, k in todo:
        say = line.get("say") or line["text"]
        spk = line.get("voice") or voice
        seed = int(line.get("seed", 1))
        takes[line["id"]] = []
        for s in (seed, seed + 100, seed + 200):
            f = TAKES / f"{line['id']}.{k}.{s}.wav"
            if not f.exists():  # takes are deterministic per seed, so a cached one is the same take
                if tts is None:
                    from qwentts_cpp import QwenTTS  # only needed when something must be spoken

                    tts = QwenTTS(talker, codec, log_level="error")
                    log(f"loaded {talker.name}; speaking with '{voice}'")
                audio, sr = tts.synthesize(text=say, lang=lang, speaker=spk, seed=s)
                write_wav(f, level(trim(audio.astype(np.float32), sr), sr), sr)
            with wave.open(str(f)) as w:
                secs = w.getnframes() / w.getframerate()
            takes[line["id"]].append({"seed": s, "file": f, "seconds": secs})
    if tts is not None:
        tts.close()

    heard = transcribe([t["file"] for ts in takes.values() for t in ts])
    for line, k in todo:
        say = line.get("say") or line["text"]
        ts = takes[line["id"]]
        med = sorted(t["seconds"] for t in ts)[1]
        for t in ts:
            h = heard.get(t["file"].name)
            t["match"] = match(say, h["text"]) if h else None
        best = max(ts, key=lambda t: ((t["match"] if t["match"] is not None else 1.0) >= 0.9, t["match"] or 0, -abs(t["seconds"] - med)))
        shutil.copyfile(best["file"], OUT / f"{line['id']}.wav")
        h = heard.get(best["file"].name, {})
        manifest[line["id"]] = {
            "key": k,
            "file": f"{line['id']}.wav",
            "seconds": round(best["seconds"], 3),
            "seed": best["seed"],
            "text": line["text"],
            "heard": h.get("text"),
            "match": None if best["match"] is None else round(best["match"], 2),
            "words": h.get("words", []),
        }
        flag = "" if (best["match"] or 1) >= 0.9 else "  <- check this line"
        log(f"{line['id']}: {best['seconds']:.2f} s, seed {best['seed']}, match {best['match'] if best['match'] is None else round(best['match'], 2)} | takes {', '.join(f'{t['seconds']:.1f}s/{t['match'] if t['match'] is None else round(t['match'], 2)}' for t in ts)}{flag}")
        if h.get("text"):
            log(f"    heard: {h['text']}")
    MANIFEST.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")
    total = sum(v["seconds"] for v in manifest.values())
    log(f"done in {time.time() - t0:.0f} s; voiceover totals {total:.1f} s")


if __name__ == "__main__":
    main()
