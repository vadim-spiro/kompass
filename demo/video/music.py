#!/usr/bin/env python3
"""music.py - synthesize an original, uplifting 120 BPM electronic backing track.

Everything is generated from scratch with numpy / scipy (no samples, nothing downloaded).

Usage
-----
    python -I music.py <arrangement.json> <out.wav> [--report]

arrangement.json::

    {"bpm": 120, "total_seconds": 148.0,
     "sections": [{"start": 0.0, "kind": "tension"}, {"start": 14.0, "kind": "build"}, ...],
     "hits": [34.0, 84.0, 133.0]}

* Section starts are snapped to the nearest beat.  A section lasts until the next one starts
  (the last one until ``total_seconds``).  Patterns restart on the first beat of every section,
  so a change always lands on a downbeat.  A first section that starts after 0 s is extended
  back to 0 s.
* ``hits`` are big impacts (deep boom + sub drop + crash).  A hit within 0.35 s of a section
  start is snapped to that start; the first downbeat of a ``drop`` is a release (everything
  ducks for a moment, then the pads bloom back).
* Output: 44.1 kHz, 16-bit, stereo WAV, exactly ``total_seconds`` long, ending in a clean fade.
  One summary line is printed (duration, peak, approximate integrated loudness).
  ``--report`` also prints the RMS level of every section.

Section kinds (C major, one chord per bar; vi-IV-I-V = Am F C G, drops use C G Am F;
a section that leads into a drop ends on G so the drop lands as a V -> I release):

    tension  warm pad low-passed at ~800 Hz, clock-like tick on 8ths, soft sub pulse; no
             kick or snare.  Quiet (about -24 dBFS RMS).
    build    kick enters (four on the floor), 16th hats fade in, pad and bass filters open.
             The last 2 bars add a band-pass noise riser and a snare roll (8ths -> 16ths ->
             32nds); the last beat is a pre-drop gap holding only a short filtered swell.
    drop     full energy: kick, claps on 2 and 4, 16th hats plus open off-beat hats, off-beat
             bass on the chord roots, wide supersaw pads, 16th pluck arpeggio with a
             ping-pong delay, everything sidechain-ducked by the kick.
    groove   the drop's beat without the arp, softer; mids are kept light for a voice-over.
    soft     half energy: warm pads, light kick on beats 1 and 3, soft hats, bass on roots.
    stop     near silence: the previous chord does a short tape stop, then the next section
             punches back in.
    outro    the last chord (Cadd9) rings out in reverb, the beat stops, fade to silence at
             ``total_seconds``.

Signal flow: every section is rendered into scratch layers (drums / bass / pad / arp), the
kick-driven sidechain is applied per layer, the result is summed into one dry bus plus a
reverb send; the Freeverb-style reverb, the stop / pre-drop gating, the un-gated effects
(impacts, risers) and a master chain (high-pass, glue compressor, look-ahead limiter, soft
clipper, true-peak trim, fades) follow.
"""

import json
import math
import sys
import time
from functools import lru_cache

import numpy as np
from scipy import signal
from scipy.io import wavfile
from scipy.ndimage import minimum_filter1d, uniform_filter1d

SR = 44100
KINDS = ("tension", "build", "drop", "groove", "soft", "stop", "outro")
PAD_RMS = 0.25  # RMS of every raw pad stack (the mix table below sets the real levels)

# ------------------------------------------------------------------------------------------
# Musical material
# ------------------------------------------------------------------------------------------
PROG_MINOR_FIRST = ("Am", "F", "C", "G")  # vi - IV - I - V
PROG_MAJOR_FIRST = ("C", "G", "Am", "F")  # I - V - vi - IV (drops)
ROOT_MIDI = {"Am": 33, "F": 29, "C": 36, "G": 31}  # bass roots: A1 F1 C2 G1

# MIDI notes: triads plus octaves, voice-led (top notes move E4-F4-E4-D4 across Am F C G).
VOICINGS = {
    "super": {
        "Am": (45, 57, 60, 64, 69, 72, 76),
        "F": (41, 57, 60, 65, 69, 72, 77),
        "C": (48, 55, 60, 64, 67, 72, 76),
        "G": (43, 55, 59, 62, 67, 71, 74),
    },
    "warm": {
        "Am": (45, 52, 57, 60, 64),
        "F": (41, 53, 57, 60, 65),
        "C": (48, 55, 60, 64, 67),
        "G": (43, 50, 55, 59, 62),
    },
}
OUTRO_CHORD = (48, 55, 60, 64, 67, 72, 74, 76)  # Cadd9
ARP_TONES = {  # chord tones one to two octaves above the pads
    "Am": (69, 72, 76, 81, 84, 88),
    "F": (65, 69, 72, 77, 81, 84),
    "C": (67, 72, 76, 79, 84, 88),
    "G": (67, 71, 74, 79, 83, 86),
}
ARP_ORDER = (0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 4, 3)  # 16 steps per bar


# ------------------------------------------------------------------------------------------
# Small utilities
# ------------------------------------------------------------------------------------------
def db(x):
    """dB -> linear gain."""
    return 10.0 ** (x / 20.0)


def to_db(x):
    """Linear amplitude -> dB."""
    return 20.0 * math.log10(max(float(x), 1e-12))


def midi_hz(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def pan_gains(p):
    """Equal-power pan, p in [-1, 1]."""
    a = (p + 1.0) * math.pi / 4.0
    return math.cos(a), math.sin(a)


def stereo(x, pan=0.0):
    gl, gr = pan_gains(pan)
    return np.stack([x * gl, x * gr])


def lock(a):
    """Make a cached array read-only so callers cannot corrupt it."""
    a.flags.writeable = False
    return a


def ramp(n):
    """Raised-cosine ramp 0 -> 1 over n samples."""
    return 0.5 - 0.5 * np.cos(np.pi * np.arange(max(n, 0)) / max(n, 1))


def gate_env(n, attack_s, release_s):
    """Flat envelope with raised-cosine attack and release."""
    env = np.ones(n)
    a, r = min(n, int(attack_s * SR)), min(n, int(release_s * SR))
    if a > 0:
        env[:a] = ramp(a)
    if r > 0:
        env[n - r:] *= ramp(r)[::-1]
    return env


def fade_tail(x, seconds):
    """Fade the end of x (last axis) to exactly zero, in place."""
    k = min(x.shape[-1], int(seconds * SR))
    if k > 0:
        x[..., -k:] *= ramp(k)[::-1]
    return x


def normalize(x, peak=1.0):
    return x * (peak / max(float(np.max(np.abs(x))), 1e-12))


def add_at(bus, x, i, gain=1.0):
    """Add x (n,) or (2, n) into bus (2, N) at sample index i, clipped to the bus."""
    n = x.shape[-1]
    if i >= bus.shape[1] or i + n <= 0:
        return
    s, e = max(0, -i), min(n, bus.shape[1] - i)
    bus[:, i + s:i + e] += x[..., s:e] * gain


# ------------------------------------------------------------------------------------------
# Filters
# ------------------------------------------------------------------------------------------
def biquad_coefs(kind, f0, q=0.7071, gain_db=0.0):
    """RBJ biquad coefficients for an array of centre/cutoff frequencies -> (b, a), shape (m, 3)."""
    f0 = np.clip(np.atleast_1d(np.asarray(f0, dtype=np.float64)), 10.0, 0.45 * SR)
    w0 = 2.0 * np.pi * f0 / SR
    cw, sw = np.cos(w0), np.sin(w0)
    al = sw / (2.0 * q)
    if kind == "lp":
        b0, b1, b2 = (1 - cw) / 2, 1 - cw, (1 - cw) / 2
        a0, a1, a2 = 1 + al, -2 * cw, 1 - al
    elif kind == "hp":
        b0, b1, b2 = (1 + cw) / 2, -(1 + cw), (1 + cw) / 2
        a0, a1, a2 = 1 + al, -2 * cw, 1 - al
    elif kind == "bp":  # constant 0 dB peak gain
        b0, b1, b2 = al, 0 * cw, -al
        a0, a1, a2 = 1 + al, -2 * cw, 1 - al
    elif kind == "peak":
        big_a = 10.0 ** (gain_db / 40.0)
        b0, b1, b2 = 1 + al * big_a, -2 * cw, 1 - al * big_a
        a0, a1, a2 = 1 + al / big_a, -2 * cw, 1 - al / big_a
    else:
        raise ValueError(kind)
    b = np.stack([b0, b1, b2], axis=-1) / a0[:, None]
    a = np.stack([np.ones_like(a0), a1 / a0, a2 / a0], axis=-1)
    return b, a


def biquad(x, kind, f0, q=0.7071, gain_db=0.0):
    """Static biquad along the last axis."""
    b, a = biquad_coefs(kind, float(f0), q, gain_db)
    return signal.lfilter(b[0], a[0], x, axis=-1)


def sweep_filter(x, kind, fc, q=0.7071, block=256):
    """Time-varying resonant biquad (automation).  fc: scalar or per-sample array in Hz.

    Coefficients are updated every `block` samples; the filter state is carried across blocks.
    """
    x = np.asarray(x, dtype=np.float64)
    n = x.shape[-1]
    fc = np.broadcast_to(np.asarray(fc, dtype=np.float64), (n,))
    if float(np.ptp(fc)) < 1e-9:
        b, a = biquad_coefs(kind, fc[0], q)
        return signal.lfilter(b[0], a[0], x, axis=-1)
    starts = np.arange(0, n, block)
    b, a = biquad_coefs(kind, fc[np.minimum(starts + block // 2, n - 1)], q)
    y = np.empty_like(x)
    zi = np.zeros(x.shape[:-1] + (2,))
    for k, s in enumerate(starts):
        e = min(s + block, n)
        y[..., s:e], zi = signal.lfilter(b[k], a[k], x[..., s:e], axis=-1, zi=zi)
    return y


def butter_filter(x, kind, f, order=4):
    sos = signal.butter(order, f, btype=kind, fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=-1)


# ------------------------------------------------------------------------------------------
# Oscillator
# ------------------------------------------------------------------------------------------
def _blep_saw(dt, n, phase0):
    """PolyBLEP sawtooth for a phase increment dt (cycles/sample): scalar or an (n,) array."""
    if np.ndim(dt) == 0:
        ph = (phase0 + np.arange(n) * dt) % 1.0
    else:
        ph = (phase0 + np.cumsum(dt) - dt) % 1.0
    y = 2.0 * ph - 1.0
    lo = ph < dt
    if lo.any():
        u = ph[lo] / (dt if np.ndim(dt) == 0 else dt[lo])
        y[lo] -= 2.0 * u - u * u - 1.0
    hi = ph > 1.0 - dt
    if hi.any():
        u = (ph[hi] - 1.0) / (dt if np.ndim(dt) == 0 else dt[hi])
        y[hi] -= u * u + 2.0 * u + 1.0
    return y


def saw_blep(freq, n, phase0=0.0, os=1):
    """Band-limited sawtooth in [-1, 1]: PolyBLEP, optionally rendered at `os` x the sample rate
    and decimated (os=2 pushes the remaining alias products about 20 dB further down).

    freq is a scalar or an (n,) array in Hz.
    """
    f = np.asarray(freq, dtype=np.float64)
    dt = float(f) / (SR * os) if f.ndim == 0 else np.repeat(f / (SR * os), os)
    y = _blep_saw(dt, n * os, phase0)
    return y if os == 1 else signal.resample_poly(y, 1, os)


# ------------------------------------------------------------------------------------------
# Drums (rendered once, cached)
# ------------------------------------------------------------------------------------------
KICK_STYLES = {
    # f0: start pitch (Hz), ptau: pitch-envelope time constant, decay: time to -30 dB, click, drive
    "full": dict(f0=150.0, ptau=0.034, decay=0.30, click=0.34, drive=1.7),
    "soft": dict(f0=118.0, ptau=0.040, decay=0.26, click=0.10, drive=1.0),
}


@lru_cache(maxsize=None)
def kick_sample(style="full"):
    """Sine kick: pitch falls 150 -> 45 Hz, exponential decay (~0.3 s), short click on top."""
    p = KICK_STYLES[style]
    n = int(0.55 * SR)
    t = np.arange(n) / SR
    freq = 45.0 + (p["f0"] - 45.0) * np.exp(-t / p["ptau"])
    body = np.sin(2.0 * np.pi * np.cumsum(freq) / SR) * np.exp(-3.45 * t / p["decay"])
    body = np.tanh(p["drive"] * body) / np.tanh(p["drive"])
    nc = int(0.007 * SR)
    noise = np.random.default_rng(1).standard_normal(nc)
    click = butter_filter(noise, "highpass", 1800.0, 2) * np.exp(-np.arange(nc) / (0.0012 * SR))
    body[:nc] += p["click"] * click / max(np.abs(click).max(), 1e-9)
    return lock(fade_tail(normalize(body), 0.03))


def room_ir(length_s, tau, seed):
    """Decaying-noise room impulse response (used for the short clap / snare reverb)."""
    n = int(length_s * SR)
    ir = np.random.default_rng(seed).standard_normal(n) * np.exp(-np.arange(n) / (tau * SR))
    ir = butter_filter(ir, "highpass", 350.0, 1)
    return np.concatenate([np.zeros(int(0.003 * SR)), ir])


def add_room(dry, mix, tau, length_s=0.45, seeds=(21, 22)):
    """Dry mono -> stereo with a short decorrelated reverb tail."""
    n = len(dry)
    wet = np.stack([signal.fftconvolve(dry, room_ir(length_s, tau, s))[:n] for s in seeds])
    wet *= np.std(dry) / (np.std(wet) + 1e-12)
    return dry[None, :] + mix * wet


@lru_cache(maxsize=None)
def clap_sample():
    """Four staggered band-passed (about 1-2.6 kHz) noise bursts plus a short room reverb."""
    rng = np.random.default_rng(11)
    n = int(0.6 * SR)
    dry = np.zeros(n)
    for t0, tau, amp in ((0.0, 0.005, 0.8), (0.011, 0.005, 0.9), (0.022, 0.006, 1.0), (0.034, 0.045, 1.0)):
        i0 = int(t0 * SR)
        dry[i0:] += amp * rng.standard_normal(n - i0) * np.exp(-np.arange(n - i0) / (tau * SR))
    dry = butter_filter(dry, "bandpass", (950.0, 2600.0), 2)
    return lock(fade_tail(normalize(add_room(dry, 0.75, 0.09)), 0.04))


@lru_cache(maxsize=None)
def hat_sample(open_=False, variant=0):
    """High-passed noise plus a few inharmonic partials, very short envelope (closed) or ~0.2 s (open)."""
    rng = np.random.default_rng(100 + variant + (50 if open_ else 0))
    n = int((0.34 if open_ else 0.09) * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    for f in (6230.0, 7410.0, 8950.0, 10520.0, 12040.0):
        x += 0.3 * np.sin(2.0 * np.pi * f * rng.uniform(0.96, 1.04) * t + rng.uniform(0.0, 6.28))
    x = butter_filter(x, "highpass", 6800.0, 4)
    x *= np.exp(-t / (0.075 if open_ else 0.013))
    na = int(0.0008 * SR)
    x[:na] *= ramp(na)
    return lock(fade_tail(normalize(x), 0.01))


@lru_cache(maxsize=None)
def snare_sample(pitch=1.0):
    """Noise + tuned body snare with a short room tail; `pitch` raises the body (used by the roll)."""
    rng = np.random.default_rng(31)
    n = int(0.34 * SR)
    t = np.arange(n) / SR
    noise = butter_filter(rng.standard_normal(n), "bandpass", (1500.0, 9000.0), 2) * np.exp(-t / 0.06)
    freq = 175.0 * pitch + 70.0 * np.exp(-t / 0.018)
    tone = np.sin(2.0 * np.pi * np.cumsum(freq) / SR) * np.exp(-t / 0.05)
    dry = 0.85 * normalize(noise) + 0.6 * tone
    return lock(fade_tail(normalize(add_room(dry, 0.5, 0.08, 0.4, (31, 32))), 0.04))


@lru_cache(maxsize=None)
def tick_sample(accent=True):
    """Clock-like tick: a tiny woodblock ping plus a band-passed noise click."""
    rng = np.random.default_rng(41)
    n = int(0.07 * SR)
    t = np.arange(n) / SR
    ping = np.sin(2.0 * np.pi * (2300.0 if accent else 1650.0) * t) * np.exp(-t / 0.0045)
    burst = butter_filter(rng.standard_normal(n), "bandpass", (2800.0, 7000.0), 2) * np.exp(-t / 0.0012)
    x = ping + 0.9 * normalize(burst)
    return lock(fade_tail(normalize(x), 0.012))


@lru_cache(maxsize=None)
def crash_sample():
    """Stereo noise crash: high-passed, darkening over time, ~3 s of tail."""
    rng = np.random.default_rng(51)
    n = int(5.0 * SR)
    t = np.arange(n) / SR
    x = butter_filter(rng.standard_normal((2, n)), "highpass", 3200.0, 4)
    x = sweep_filter(x, "lp", 5500.0 + 9500.0 * np.exp(-t / 0.9), 0.8)
    env = 0.8 * np.exp(-t / 0.55) + 0.2 * np.exp(-t / 1.5)
    na = int(0.002 * SR)
    env[:na] *= ramp(na)
    return lock(fade_tail(normalize(x * env), 0.4))


@lru_cache(maxsize=None)
def boom_sample():
    """Deep impact: pitched sine thump (85 -> 33 Hz) with a low-passed noise thud and rumble."""
    rng = np.random.default_rng(61)
    n = int(3.2 * SR)
    t = np.arange(n) / SR
    freq = 33.0 + 52.0 * np.exp(-t / 0.30)
    sine = np.sin(2.0 * np.pi * np.cumsum(freq) / SR) * (1 - np.exp(-t / 0.003)) * np.exp(-t / 0.75)
    thud = normalize(butter_filter(rng.standard_normal(n), "lowpass", 200.0, 2)) * np.exp(-t / 0.20)
    rumble = normalize(butter_filter(rng.standard_normal(n), "lowpass", 90.0, 2)) * np.exp(-t / 1.0)
    x = np.tanh(1.5 * (sine + 0.45 * thud + 0.25 * rumble))
    return lock(fade_tail(normalize(x), 0.5))


@lru_cache(maxsize=None)
def sub_drop_sample():
    """Sub drop: a sine gliding 90 -> 26 Hz with a long decay."""
    n = int(2.2 * SR)
    t = np.arange(n) / SR
    freq = 26.0 + 64.0 * np.exp(-t / 0.34)
    x = np.sin(2.0 * np.pi * np.cumsum(freq) / SR) * (1 - np.exp(-t / 0.012)) * np.exp(-t / 0.85)
    return lock(fade_tail(normalize(x), 0.4))


@lru_cache(maxsize=None)
def noise_riser(n, f0, f1, curve, seed, tone):
    """Stereo band-pass noise whose centre sweeps f0 -> f1 (log), amplitude rising as p**curve."""
    rng = np.random.default_rng(seed)
    p = np.arange(n) / n
    x = sweep_filter(rng.standard_normal((2, n)), "bp", f0 * (f1 / f0) ** p, 1.4)
    out = x / np.sqrt(np.mean(x ** 2)) * p ** curve
    if tone:  # faint rising whistle underneath, slightly detuned per side
        sweep = 280.0 * (3000.0 / 280.0) ** p
        for det, pan in ((0.997, -0.5), (1.003, 0.5)):
            whistle = np.sin(2.0 * np.pi * np.cumsum(sweep * det) / SR) * p ** (curve + 0.8)
            out += 0.35 * whistle * np.array(pan_gains(pan))[:, None]
    return lock(fade_tail(out, 0.008))


# ------------------------------------------------------------------------------------------
# Tonal voices (cached per pitch / chord)
# ------------------------------------------------------------------------------------------
# (detune in cents, gain, pan)
SUPER_VOICES = ((-24, 0.55, -0.95), (-15, 0.75, -0.65), (-7, 0.9, -0.3), (0, 1.0, 0.0),
                (7, 0.9, 0.3), (15, 0.75, 0.65), (24, 0.55, 0.95))
WARM_VOICES = ((-9, 0.8, -0.55), (0, 1.0, 0.0), (9, 0.8, 0.55))


@lru_cache(maxsize=None)
def pad_stack(notes, kind, length_s):
    """Raw (unfiltered) chord: every note is a stack of detuned PolyBLEP saws spread across the stereo field."""
    voices = SUPER_VOICES if kind == "super" else WARM_VOICES
    n = int(length_s * SR)
    rng = np.random.default_rng(1000 + sum(notes))
    out = np.zeros((2, n))
    for m in notes:
        f0 = midi_hz(m)
        for cents, gain, pan in voices:
            s = saw_blep(f0 * 2.0 ** (cents / 1200.0), n, rng.random(), os=2)
            gl, gr = pan_gains(pan)
            out[0] += s * (gain * gl)
            out[1] += s * (gain * gr)
    out *= PAD_RMS / np.sqrt(np.mean(out ** 2))
    return lock(out)


@lru_cache(maxsize=None)
def bass_note(midi, length):
    """Off-beat bass: saw + sub sine through a resonant low-pass with a plucky cutoff envelope."""
    n = int((length + 0.02) * SR)
    t = np.arange(n) / SR
    f = midi_hz(midi)
    x = 0.50 * saw_blep(f, n, 0.0) + 0.30 * saw_blep(f * 2.0 ** (7 / 1200.0), n, 0.37)
    x += 0.90 * np.sin(2.0 * np.pi * f * t)
    x = np.tanh(1.4 * sweep_filter(x, "lp", 260.0 + 1700.0 * np.exp(-t / 0.06), 1.8, block=128))
    x *= gate_env(n, 0.004, 0.018) * (0.65 + 0.35 * np.exp(-t / 0.12))
    return lock(normalize(x))


@lru_cache(maxsize=None)
def pluck_note(midi, length=0.34):
    """Arp pluck: two detuned saws + sine through a resonant low-pass with a fast-decaying cutoff."""
    n = int(length * SR)
    t = np.arange(n) / SR
    f = midi_hz(midi)
    x = saw_blep(f * 2.0 ** (-6 / 1200.0), n, 0.13, os=2) + saw_blep(f * 2.0 ** (6 / 1200.0), n, 0.61, os=2)
    x += 0.5 * np.sin(2.0 * np.pi * f * t)
    x = sweep_filter(x, "lp", 1500.0 + 6500.0 * np.exp(-t / 0.055), 2.2, block=128)
    x *= np.exp(-t / 0.11) * (1 - np.exp(-t / 0.0012))
    return lock(fade_tail(normalize(x), 0.025))


@lru_cache(maxsize=None)
def sub_pulse(midi):
    """Soft sine thump on the root (with a little 2nd harmonic so small speakers hear it)."""
    n = int(0.55 * SR)
    t = np.arange(n) / SR
    f = midi_hz(midi)
    x = (np.sin(2.0 * np.pi * f * t) + 0.3 * np.sin(4.0 * np.pi * f * t))
    x *= (1 - np.exp(-t / 0.008)) * np.exp(-t / 0.17)
    return lock(fade_tail(normalize(x), 0.05))


# ------------------------------------------------------------------------------------------
# Effects
# ------------------------------------------------------------------------------------------
COMB_DELAYS = (1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617)  # Freeverb tunings (44.1 kHz)
ALLPASS_DELAYS = (556, 441, 341, 225)


def _comb(x, delay, fb, damp):
    """Freeverb damped feedback comb, run block-wise (block = delay) so it stays vectorized."""
    n = len(x)
    y = np.empty(n)
    prev = np.zeros(delay)
    zi = np.zeros(1)
    b, a = [1.0 - damp], [1.0, -damp]
    for s in range(0, n, delay):
        e = min(s + delay, n)
        yk = prev[:e - s]
        y[s:e] = yk
        store, zi = signal.lfilter(b, a, yk, zi=zi)  # one-pole damping in the loop
        prev = x[s:e] + fb * store
    return y


def _allpass(x, delay, g=0.5):
    """Freeverb allpass, block-wise."""
    n = len(x)
    y = np.empty(n)
    buf = np.zeros(delay)
    for s in range(0, n, delay):
        e = min(s + delay, n)
        xs = x[s:e]
        y[s:e] = buf[:e - s] - xs
        buf = xs + g * buf[:e - s]
    return y


def freeverb(x, fb=0.91, damp=0.30, predelay=0.020, out_gain=0.085):
    """Stereo Freeverb-style reverb (8 damped combs + 4 allpasses per side, right side detuned).

    x: (2, N) send bus -> (2, N) wet signal.
    """
    mono = 0.5 * (x[0].astype(np.float64) + x[1].astype(np.float64))
    pre = int(predelay * SR)
    mono = np.concatenate([np.zeros(pre), mono])[:len(mono)]
    mono = butter_filter(butter_filter(mono, "highpass", 220.0, 1), "lowpass", 8500.0, 1)
    wet = np.empty((2, len(mono)))
    for ch, spread in enumerate((0, 23)):
        acc = np.zeros(len(mono))
        for d in COMB_DELAYS:
            acc += _comb(mono, d + spread, fb, damp)
        for d in ALLPASS_DELAYS:
            acc = _allpass(acc, d + spread)
        wet[ch] = acc * out_gain
    return wet


def pingpong(x, delay_s, feedback, mix):
    """Ping-pong delay on a stereo array (repeats alternate sides); block-wise feedback loop."""
    d = int(round(delay_s * SR))
    n = x.shape[1]
    wet = np.zeros_like(x)
    for s in range(d, n, d):
        e = min(s + d, n)
        src = x[:, s - d:e - d] + feedback * wet[:, s - d:e - d]
        wet[:, s:e] = src[::-1]
    return x + mix * wet


def duck_curve(n, events, pre_s=0.003):
    """Sidechain amount D(t) in [0, 1] (1 = fully ducked) from kick events (index, strength, release_s).

    Each kick snaps the level down within 3 ms and it recovers along a convex curve over
    `release_s`, which gives the classic pump.
    """
    amount = np.zeros(n)
    npre = int(pre_s * SR)
    for i, strength, release in events:
        m = int(release * SR)
        shape = np.concatenate([np.arange(npre) / npre, (1.0 - np.arange(m) / m) ** 2.2]) * strength
        a = i - npre
        k0, k1 = max(0, -a), min(len(shape), n - a)
        if k1 > k0:
            seg = amount[a + k0:a + k1]
            np.maximum(seg, shape[k0:k1], out=seg)
    return amount


def mute_curve(n, mutes, fade_out_s=0.006, fade_in_s=0.003):
    """Gain curve (1 = open) with a dip to `floor` for every (start_s, end_s, floor) in mutes.

    The gate closes quickly after `start` and has fully reopened exactly at `end`, so the
    first sample of the next section is never touched.
    """
    gain = np.ones(n)
    for a, b, floor in mutes:
        ia, ib = max(0, int(round(a * SR))), min(n, int(round(b * SR)))
        if ib <= ia:
            continue
        seg = np.full(ib - ia, float(floor))
        fo, fi = min(int(fade_out_s * SR), len(seg) // 2), min(int(fade_in_s * SR), len(seg) // 2)
        if fo:
            seg[:fo] = floor + (1.0 - floor) * (1.0 - ramp(fo))
        if fi:
            seg[-fi:] = floor + (1.0 - floor) * ramp(fi)
        gain[ia:ib] = np.minimum(gain[ia:ib], seg)
    return gain


def tape_stop(notes, dur_s):
    """A chord slowing down to a halt (pitch and brightness fall, level fades): the 'record stop'."""
    n = int(dur_s * SR)
    t = np.arange(n) / SR
    rate = np.maximum((1.0 - t / dur_s) ** 2.0, 0.015)
    rng = np.random.default_rng(5)
    out = np.zeros((2, n))
    for m in notes:
        for cents, pan in ((-8, -0.6), (0, 0.0), (8, 0.6)):
            s = saw_blep(midi_hz(m) * 2.0 ** (cents / 1200.0) * rate, n, rng.random())
            gl, gr = pan_gains(pan)
            out[0] += s * gl
            out[1] += s * gr
    out = sweep_filter(out, "lp", 300.0 + 6000.0 * rate ** 1.5, 1.3)
    out *= PAD_RMS / np.sqrt(np.mean(out ** 2))
    return out * (1.0 - t / dur_s) ** 1.6


# ------------------------------------------------------------------------------------------
# Master bus
# ------------------------------------------------------------------------------------------
def glue_compress(x, thresh_db=-13.0, ratio=2.0, attack=0.020, release=0.16, knee_db=8.0, ctrl=32):
    """Gentle bus compressor: power detector, soft knee, attack/release smoothing at control rate."""
    n = x.shape[1]
    power = uniform_filter1d(0.5 * (x[0] ** 2 + x[1] ** 2), size=int(0.01 * SR), mode="nearest")
    level = 10.0 * np.log10(power[ctrl // 2::ctrl] + 1e-12)
    over = level - thresh_db
    reduction = np.where(over <= -knee_db / 2, 0.0,
                         np.where(over >= knee_db / 2, over, (over + knee_db / 2) ** 2 / (2 * knee_db)))
    reduction *= 1.0 - 1.0 / ratio
    ca, cr = math.exp(-ctrl / (attack * SR)), math.exp(-ctrl / (release * SR))
    smooth = np.empty_like(reduction)
    y = 0.0
    for i, g in enumerate(reduction.tolist()):
        c = ca if g > y else cr
        y = c * y + (1.0 - c) * g
        smooth[i] = y
    pos = np.arange(len(smooth)) * ctrl + ctrl // 2
    gain = db(-np.interp(np.arange(n), pos, smooth))
    return x * gain


def limit(x, ceiling=0.80, look_s=0.004, release_s=0.09, ctrl=16):
    """Look-ahead peak limiter (gain computed at control rate, interpolated to audio rate)."""
    n = x.shape[1]
    nb = -(-n // ctrl)
    peak = np.zeros(nb * ctrl)
    peak[:n] = np.max(np.abs(x), axis=0)
    need = np.minimum(1.0, ceiling / np.maximum(peak.reshape(nb, ctrl).max(axis=1), 1e-9))
    w = 2 * max(1, int(look_s * SR / ctrl)) + 1
    target = uniform_filter1d(minimum_filter1d(need, w, mode="nearest"), w, mode="nearest")
    rel = 1.0 - math.exp(-ctrl / (release_s * SR))
    gain = np.empty(nb)
    g = 1.0
    for i, tg in enumerate(target.tolist()):
        g = min(tg, g + (1.0 - g) * rel)
        gain[i] = g
    pos = np.arange(nb) * ctrl + ctrl // 2
    return x * np.interp(np.arange(n), pos, gain)


def soft_clip(x, ceiling):
    """Smooth saturation: linear for small signals, saturating at +/-ceiling."""
    u = x / ceiling
    return ceiling * u / (1.0 + np.abs(u) ** 4) ** 0.25


def true_peak_db(x):
    """True peak (4x oversampled) in dBFS, computed in chunks to bound memory."""
    peak, chunk, pad = 0.0, 1 << 20, 64
    for s in range(0, x.shape[1], chunk):
        seg = x[:, max(0, s - pad):min(x.shape[1], s + chunk + pad)]
        up = signal.resample_poly(seg, 4, 1, axis=1)
        lo = 4 * (s - max(0, s - pad))
        peak = max(peak, float(np.max(np.abs(up[:, lo:lo + 4 * chunk]))))
    return to_db(peak)


def _k_weight(x):
    """ITU-R BS.1770 K-weighting (high shelf + high-pass), designed for the current sample rate."""
    f0, gain, q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    k = math.tan(math.pi * f0 / SR)
    vh = 10.0 ** (gain / 20.0)
    vb = vh ** 0.4996667741545416
    a0 = 1.0 + k / q + k * k
    b = [(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0]
    a = [1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0]
    y = signal.lfilter(b, a, x, axis=-1)
    f0, q = 38.13547087602444, 0.5003270373238773
    k = math.tan(math.pi * f0 / SR)
    a0 = 1.0 + k / q + k * k
    return signal.lfilter([1 / a0, -2 / a0, 1 / a0], [1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0], y, axis=-1)


def lufs(x):
    """Integrated loudness (BS.1770 K-weighting, 400 ms blocks, absolute and relative gates)."""
    y = _k_weight(x.astype(np.float64))
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    if y.shape[1] < blk:
        y = np.pad(y, ((0, 0), (0, blk - y.shape[1])))
    cs = np.concatenate([np.zeros((2, 1)), np.cumsum(y ** 2, axis=1)], axis=1)
    starts = np.arange(0, y.shape[1] - blk + 1, hop)
    z = ((cs[:, starts + blk] - cs[:, starts]) / blk).sum(axis=0)
    loud = -0.691 + 10.0 * np.log10(z + 1e-12)
    keep = loud > -70.0
    if not keep.any():
        return -70.0
    rel = -0.691 + 10.0 * np.log10(z[keep].mean()) - 10.0
    keep &= loud > rel
    return -0.691 + 10.0 * np.log10(z[keep].mean())


# ------------------------------------------------------------------------------------------
# Arrangement planning
# ------------------------------------------------------------------------------------------
class Sec:
    """One beat-snapped section of the arrangement."""

    def __init__(self, kind, t0, t1, idx):
        self.kind, self.t0, self.t1, self.idx = kind, t0, t1, idx
        self.dur = t1 - t0
        self.i0, self.i1 = int(round(t0 * SR)), int(round(t1 * SR))
        self.chords = []
        self.prev = self.next = None


class Ctx:
    """Global render state: grid timing, output buses and event lists."""

    def __init__(self, bpm, total):
        self.beat = 60.0 / bpm
        self.bar = 4.0 * self.beat
        self.sixt = self.beat / 4.0
        self.total = total
        self.n = int(round(total * SR))
        size = self.n + int(6 * SR)  # room for reverb / delay tails past the end (trimmed later)
        self.dry = np.zeros((2, size), np.float32)   # drums + sidechained layers (gated by stop / gaps)
        self.send = np.zeros((2, size), np.float32)  # reverb send
        self.free = np.zeros((2, size), np.float32)  # never gated: impacts, risers, tape stop
        self.mutes = []                              # (start_s, end_s, floor)
        self.hits = []                               # impact times (s)

    def hits_in(self, sec):
        return [h for h in self.hits if sec.t0 - 1e-9 <= h < sec.t1 - 1e-9]


def assign_chords(secs, bar):
    """One chord per bar.  Builds (and anything leading into a drop) end on G so the drop is a V -> I release."""
    for s in secs:
        nbars = max(1, math.ceil(s.dur / bar - 1e-9))
        if s.kind == "drop":
            s.chords = [PROG_MAJOR_FIRST[b % 4] for b in range(nbars)]
        elif s.kind == "outro":
            s.chords = ["C"]
        elif s.kind == "stop":
            s.chords = [s.prev.chords[-1] if s.prev else "C"]
        elif s.kind == "build" or (s.next is not None and s.next.kind == "drop"):
            s.chords = [PROG_MINOR_FIRST[(3 - (nbars - 1 - b)) % 4] for b in range(nbars)]
        else:
            s.chords = [PROG_MINOR_FIRST[b % 4] for b in range(nbars)]


def plan_sections(raw, ctx):
    items = []
    for s in sorted(raw, key=lambda s: float(s["start"])):
        kind = str(s["kind"]).lower()
        if kind not in KINDS:
            raise SystemExit("unknown section kind %r (expected one of: %s)" % (kind, ", ".join(KINDS)))
        t = round(float(s["start"]) / ctx.beat) * ctx.beat  # snap to the beat grid
        if t < ctx.total - 1e-9:
            items.append([max(t, 0.0), kind])
    if not items:
        raise SystemExit("the arrangement has no usable sections")
    items[0][0] = 0.0
    merged = []
    for t, kind in items:  # two starts snapped to the same beat: the later one wins
        if merged and abs(merged[-1][0] - t) < 1e-9:
            merged[-1] = [t, kind]
        else:
            merged.append([t, kind])
    secs = [Sec(kind, t, merged[k + 1][0] if k + 1 < len(merged) else ctx.total, k)
            for k, (t, kind) in enumerate(merged)]
    secs[-1].i1 = ctx.n
    for k, s in enumerate(secs):
        s.prev = secs[k - 1] if k else None
        s.next = secs[k + 1] if k + 1 < len(secs) else None
    assign_chords(secs, ctx.bar)
    return secs


def snap_hits(hits, secs, total):
    """A hit close to a section start lands exactly on it (so a drop's boom is on its downbeat)."""
    out = []
    for h in hits:
        h = float(h)
        near = min(secs, key=lambda s: abs(s.t0 - h))
        h = near.t0 if abs(near.t0 - h) <= 0.35 else h
        if 0.0 <= h < total:
            out.append(h)
    return sorted(set(out))


# ------------------------------------------------------------------------------------------
# Section layers
# ------------------------------------------------------------------------------------------
class Layers:
    """Scratch layers of one section (section length + tail).

    `commit` applies the kick-driven sidechain to the tonal layers and sums everything into
    the global dry bus and reverb send.
    """

    def __init__(self, ctx, sec, tail_s):
        self.ctx, self.sec = ctx, sec
        self.n = (sec.i1 - sec.i0) + int(tail_s * SR)
        self.drums, self.dsend, self.bass, self.pad, self.arp = (np.zeros((2, self.n)) for _ in range(5))
        self.kicks = []  # (sample, strength, release_s) -> sidechain events

    def time_axis(self):
        return np.arange(self.n) / SR

    def kick(self, t, style, gain, strength, release=0.40):
        i = int(round(t * SR))
        add_at(self.drums, kick_sample(style), i, gain)
        self.kicks.append((i, strength, release))

    def drum(self, x, t, gain=1.0, pan=0.0, send=0.0):
        if x.ndim == 1 and pan != 0.0:
            x = stereo(x, pan)
        i = int(round(t * SR))
        add_at(self.drums, x, i, gain)
        if send > 0.0:
            add_at(self.dsend, x, i, gain * send)

    def commit(self, duck=None, send=None):
        duck, send = duck or {}, send or {}
        amount = duck_curve(self.n, self.kicks) if self.kicks else None

        def ducked(layer, name):
            depth = duck.get(name, 0.0)
            return layer * (1.0 - depth * amount) if amount is not None and depth > 0.0 else layer

        pad, bass, arp = ducked(self.pad, "pad"), ducked(self.bass, "bass"), ducked(self.arp, "arp")
        add_at(self.ctx.dry, self.drums + pad + bass + arp, self.sec.i0)
        add_at(self.ctx.send, self.dsend + send.get("pad", 0.0) * pad + send.get("arp", 0.0) * arp, self.sec.i0)


def grid(ctx, sec, step_s):
    """Section-relative times of a grid with the given step (patterns restart at every section)."""
    return [(k, k * step_s) for k in range(int(math.ceil(sec.dur / step_s - 1e-9)))]


def layer_pad(L, kind, level_db, attack, release, cutoff, q=0.9, passes=1, gain_curve=None, pocket_db=0.0):
    """One sustained chord per bar (detuned saw stacks) through a resonant low-pass with automation."""
    ctx, sec = L.ctx, L.sec
    stack_len = round(ctx.bar + 1.6, 1)
    pad = np.zeros((2, L.n))
    for b, chord in enumerate(sec.chords):
        t0 = b * ctx.bar
        if t0 >= sec.dur - 1e-6:
            break
        stack = pad_stack(VOICINGS[kind][chord], kind, stack_len)
        m = min(int((min(ctx.bar, sec.dur - t0) + release) * SR), stack.shape[1])
        add_at(pad, stack[:, :m] * gate_env(m, attack, release), int(round(t0 * SR)))
    if gain_curve is not None:
        pad *= gain_curve
    for _ in range(passes):
        pad = sweep_filter(pad, "lp", cutoff, q)
    if pocket_db:  # carve a wide dip through 1-4 kHz to leave room for a voice-over
        pad = biquad(pad, "peak", 2400.0, 0.7, pocket_db)
    L.pad += pad * db(level_db)


def layer_bass(L, mode, level_db, cutoff=None, gain_curve=None):
    """'offbeat': 8th notes between the kicks; 'roots': long root notes on beats 1 and 3."""
    ctx, sec = L.ctx, L.sec
    bass = np.zeros((2, L.n))
    for b, chord in enumerate(sec.chords):
        t0, root = b * ctx.bar, ROOT_MIDI[chord]
        if mode == "offbeat":
            events = [(t0 + (k + 0.5) * ctx.beat, 0.21) for k in range(4)]
        else:
            events = [(t0, 1.8 * ctx.beat), (t0 + 2.0 * ctx.beat, 1.8 * ctx.beat)]
        for t, length in events:
            if t < sec.dur - 1e-6:
                add_at(bass, bass_note(root, round(length, 3)), int(round(t * SR)))
    if gain_curve is not None:
        bass *= gain_curve
    if cutoff is not None:
        bass = sweep_filter(bass, "lp", cutoff, 1.2)
    L.bass += bass * db(level_db)


def layer_hats(L, style, level_db, fade=None):
    """16th hats.  'drop': open hat on the off-beat 8ths; 'build': closed only; 'soft': sparse 8ths.

    fade: optional function t_rel -> 0..1 (hats fading in during a build).
    """
    ctx, sec = L.ctx, L.sec
    for k, t in grid(ctx, sec, ctx.sixt):
        step = k % 4
        jitter = 1.0 + 0.06 * math.sin(k * 12.9898)  # tiny deterministic velocity variation
        gain = db(level_db) * jitter * (fade(t) if fade else 1.0)
        if gain <= 1e-4:
            continue
        if style == "soft":
            if step in (0, 2):
                L.drum(hat_sample(False, k % 3), t, gain * (0.7 if step == 0 else 0.5), pan=0.15)
        elif style == "drop" and step == 2:
            L.drum(hat_sample(True, k % 2), t, gain * 0.95, pan=0.25)
        else:
            L.drum(hat_sample(False, k % 3), t, gain * (0.75, 0.42, 0.62, 0.55)[step], pan=-0.15 if step % 2 else 0.1)


def layer_claps(L, level_db, send=0.3):
    for k, t in grid(L.ctx, L.sec, L.ctx.beat):
        if k % 4 in (1, 3):
            L.drum(clap_sample(), t, db(level_db), send=send)


def layer_arp(L, level_db, delay_mix=0.45):
    """16th-note pluck arpeggio of chord tones one to two octaves up, with a dotted-8th ping-pong delay."""
    ctx, sec = L.ctx, L.sec
    arp = np.zeros((2, L.n))
    for b, chord in enumerate(sec.chords):
        for s, idx in enumerate(ARP_ORDER):
            t = b * ctx.bar + s * ctx.sixt
            if t >= sec.dur - 1e-6:
                break
            vel = (1.0, 0.55, 0.75, 0.55)[s % 4]
            pan = (-0.3, 0.2, 0.3, -0.2)[s % 4]
            add_at(arp, stereo(pluck_note(ARP_TONES[chord][idx]), pan), int(round(t * SR)), vel)
    L.arp += pingpong(arp, 0.75 * ctx.beat, 0.38, delay_mix) * db(level_db)


# ------------------------------------------------------------------------------------------
# Sections
# ------------------------------------------------------------------------------------------
MIX = {  # gains in dB, tuned with --report so each kind lands on its target level
    "tension": dict(pad=-14.4, tick=-26.9, sub=-18.9),
    "build": dict(kick=-8.7, hat=-12.0, pad=-7.0, bass=-12.0, snare=-8.0, riser=-14.0, swell=-16.0),
    "drop": dict(kick=-8.7, bass=-11.1, pad=-5.8, arp=-4.2, clap=-6.0, hat=-9.5, crash=-17.0),
    "groove": dict(kick=-10.5, bass=-13.0, pad=-8.0, clap=-9.0, hat=-14.5),
    "soft": dict(kick=-11.5, bass=-17.5, pad=-12.5, hat=-19.5),
    "stop": dict(tape=-11.0),
    "outro": dict(pad=-3.5, sub=-12.0, crash=-9.0),
    "hit": dict(boom=-8.0, sub=-11.0, crash=-9.0),
}


def render_tension(ctx, sec):
    m = MIX["tension"]
    L = Layers(ctx, sec, tail_s=3.0)
    cutoff = 800.0 * (1.0 + 0.12 * np.sin(2.0 * np.pi * L.time_axis() / 7.0))  # warm pad, drifting cutoff
    layer_pad(L, "warm", m["pad"], attack=0.7, release=0.9, cutoff=cutoff, passes=2)
    for k, t in grid(ctx, sec, ctx.beat / 2):  # clock-like tick on 8ths
        accent = k % 2 == 0
        L.drum(tick_sample(accent), t, db(m["tick"]) * (1.0 if accent else 0.6),
               pan=-0.3 if accent else 0.3, send=0.25)
    for b, chord in enumerate(sec.chords):  # gentle sub pulse on the beat
        for k in range(4):
            t = b * ctx.bar + k * ctx.beat
            if t < sec.dur - 1e-6:
                add_at(L.bass, sub_pulse(ROOT_MIDI[chord]), int(round(t * SR)), db(m["sub"]) * (1.0 if k == 0 else 0.7))
    L.commit(send={"pad": 0.45})


def render_build(ctx, sec):
    m = MIX["build"]
    L = Layers(ctx, sec, tail_s=3.0)
    dur, beat = sec.dur, ctx.beat
    p = np.clip(L.time_axis() / dur, 0.0, 1.0)  # progress through the build
    gap = dur - beat if dur >= 2 * beat else dur  # start of the pre-drop gap (last beat)
    for k, t in grid(ctx, sec, beat):  # kick enters, four on the floor, growing
        if t < gap - 1e-6:
            L.kick(t, "full", db(m["kick"]) * (0.45 + 0.55 * t / dur), strength=0.35 + 0.55 * t / dur)
    layer_hats(L, "build", m["hat"], fade=lambda t: min(1.0, max(0.0, (t / dur - 0.08) / 0.5)))
    layer_pad(L, "super", m["pad"], attack=0.05, release=0.15, q=1.4,  # filters open over the section
              cutoff=350.0 * (9000.0 / 350.0) ** (p ** 1.4), gain_curve=0.30 + 0.70 * p)
    layer_bass(L, "offbeat", m["bass"], cutoff=120.0 * (3200.0 / 120.0) ** (p ** 1.2), gain_curve=0.35 + 0.65 * p)

    roll_len = min(2 * ctx.bar, dur)  # last 2 bars: snare roll 8ths -> 16ths -> 32nds, plus the riser
    roll0 = dur - roll_len
    beats = int(round(roll_len / beat)) - (1 if gap < dur else 0)
    roll = []
    for j in range(beats):
        frac = j / max(beats, 1)
        per = 2 if frac < 0.25 else (4 if frac < 0.65 else 8)
        roll += [roll0 + j * beat + s * beat / per for s in range(per)]
    for q, t in enumerate(roll):
        x = q / max(len(roll) - 1, 1)
        L.drum(snare_sample(round(1.0 + 0.45 * x, 1)), t, db(m["snare"]) * (0.30 + 0.70 * x), send=0.3)
    if gap - roll0 > 0.1:
        riser = noise_riser(int((gap - roll0) * SR), 350.0, 11000.0, 2.2, 71, True)
        add_at(ctx.free, riser, sec.i0 + int(roll0 * SR), db(m["riser"]))
    if gap < dur:  # pre-drop gap: everything else is gated, only a short filtered swell remains
        ctx.mutes.append((sec.t0 + gap, sec.t1, 0.0))
        swell = noise_riser(int((dur - gap - 0.012) * SR), 700.0, 9000.0, 1.8, 72, False)
        add_at(ctx.free, swell, sec.i0 + int(gap * SR), db(m["swell"]))
    L.commit(duck={"pad": 0.8, "bass": 0.9}, send={"pad": 0.30})


def render_drop(ctx, sec):
    m = MIX["drop"]
    L = Layers(ctx, sec, tail_s=3.5)
    for k, t in grid(ctx, sec, ctx.beat):
        L.kick(t, "full", db(m["kick"]), strength=1.0)
    for h in ctx.hits_in(sec):  # the impact ducks everything: the pads then bloom back (release)
        L.kicks.append((int(round((h - sec.t0) * SR)), 1.0, 0.7))
    for b in range(4, len(sec.chords), 4):  # phrase marker: soft crash every 4 bars
        L.drum(crash_sample(), b * ctx.bar, db(m["crash"]), send=0.15)
    layer_claps(L, m["clap"])
    layer_hats(L, "drop", m["hat"])
    layer_bass(L, "offbeat", m["bass"])
    cutoff = 6000.0 * 2.0 ** (0.8 * (1.0 - np.cos(2.0 * np.pi * L.time_axis() / (4.0 * ctx.bar))) / 2.0)
    layer_pad(L, "super", m["pad"], attack=0.012, release=0.10, cutoff=cutoff)
    layer_arp(L, m["arp"])
    L.commit(duck={"pad": 0.72, "bass": 0.85, "arp": 0.5}, send={"pad": 0.30, "arp": 0.45})


def render_groove(ctx, sec):
    m = MIX["groove"]
    L = Layers(ctx, sec, tail_s=3.0)
    for k, t in grid(ctx, sec, ctx.beat):
        L.kick(t, "full", db(m["kick"]), strength=0.9)
    for h in ctx.hits_in(sec):
        L.kicks.append((int(round((h - sec.t0) * SR)), 1.0, 0.7))
    layer_claps(L, m["clap"])
    layer_hats(L, "drop", m["hat"])
    layer_bass(L, "offbeat", m["bass"])
    layer_pad(L, "super", m["pad"], attack=0.015, release=0.12, cutoff=4200.0, pocket_db=-6.0)
    L.commit(duck={"pad": 0.65, "bass": 0.8}, send={"pad": 0.25})


def render_soft(ctx, sec):
    m = MIX["soft"]
    L = Layers(ctx, sec, tail_s=3.0)
    for k, t in grid(ctx, sec, ctx.beat):
        if k % 4 in (0, 2):  # light kick on beats 1 and 3
            L.kick(t, "soft", db(m["kick"]), strength=0.5, release=0.35)
    layer_hats(L, "soft", m["hat"])
    layer_bass(L, "roots", m["bass"])
    cutoff = 1900.0 * (1.0 + 0.10 * np.sin(2.0 * np.pi * L.time_axis() / 8.0))
    layer_pad(L, "warm", m["pad"], attack=0.35, release=0.6, cutoff=cutoff, passes=2, pocket_db=-4.0)
    L.commit(duck={"pad": 0.30, "bass": 0.45}, send={"pad": 0.40})


def render_stop(ctx, sec):
    """Near silence: the previous chord tape-stops, everything else (and every tail) is gated."""
    tape = tape_stop(VOICINGS["super"][sec.chords[0]], min(sec.dur, 1.2))
    add_at(ctx.free, tape, sec.i0, db(MIX["stop"]["tape"]))
    ctx.mutes.append((sec.t0 + 0.03, sec.t1, 0.0))


def render_outro(ctx, sec):
    """The last chord (Cadd9) rings out in reverb; the beat stops; the master fade finishes it."""
    m = MIX["outro"]
    L = Layers(ctx, sec, tail_s=6.0)
    t = L.time_axis()
    stack = pad_stack(OUTRO_CHORD, "super", round(sec.dur + 1.0, 1))
    k = min(L.n, stack.shape[1])
    ring = stack[:, :k] * (np.exp(-t[:k] / 2.4) * gate_env(k, 0.02, 0.0))
    ring = sweep_filter(ring, "lp", 2500.0 + 3500.0 * np.exp(-t[:k] / 1.5), 0.9)
    L.pad[:, :k] += ring * db(m["pad"])
    add_at(L.bass, sub_pulse(ROOT_MIDI["C"]), 0, db(m["sub"]))
    add_at(ctx.free, crash_sample(), sec.i0, db(m["crash"]))
    L.commit(send={"pad": 0.55})


RENDERERS = {"tension": render_tension, "build": render_build, "drop": render_drop,
             "groove": render_groove, "soft": render_soft, "stop": render_stop, "outro": render_outro}


def add_hit(ctx, t, scale=1.0):
    """Big impact: deep boom + sub drop + crash, with a tiny breath of near-silence just before it."""
    m, i = MIX["hit"], int(round(t * SR))
    add_at(ctx.free, boom_sample(), i, db(m["boom"]) * scale)
    add_at(ctx.free, sub_drop_sample(), i, db(m["sub"]) * scale)
    add_at(ctx.free, crash_sample(), i, db(m["crash"]) * scale)
    ctx.mutes.append((t - 0.06, t, 0.1))


# ------------------------------------------------------------------------------------------
# Render + master
# ------------------------------------------------------------------------------------------
REVERB_RETURN = 1.0
MASTER_GAIN_DB = 0.0
TRUE_PEAK_CEILING_DB = -1.05


def master(mix, last):
    """High-pass, glue compressor, look-ahead limiter, soft clipper, fades, true-peak trim."""
    x = glue_compress(biquad(mix, "hp", 28.0)) * db(MASTER_GAIN_DB)
    x = soft_clip(limit(x, 1.0), 1.0)
    fi = int(0.004 * SR)
    x[:, :fi] *= ramp(fi)
    fade_tail(x, min(3.0, 0.6 * last.dur) if last.kind == "outro" else 0.25)  # ends exactly at zero
    tp = true_peak_db(x)
    if tp > TRUE_PEAK_CEILING_DB:
        x *= db(TRUE_PEAK_CEILING_DB - tp)
        tp = TRUE_PEAK_CEILING_DB
    return x, tp


def render(arr):
    ctx = Ctx(float(arr.get("bpm", 120.0)), float(arr["total_seconds"]))
    secs = plan_sections(arr.get("sections", []), ctx)
    ctx.hits = snap_hits(arr.get("hits", []), secs, ctx.total)
    for s in secs:
        RENDERERS[s.kind](ctx, s)
        if s.prev is not None and s.prev.kind == "stop" and s.t0 not in ctx.hits:  # punch back in after a stop
            add_hit(ctx, s.t0, 0.5)
    for h in ctx.hits:
        add_hit(ctx, h)
    bus = ctx.dry + freeverb(ctx.send) * REVERB_RETURN
    bus *= mute_curve(bus.shape[1], ctx.mutes)  # stop / pre-drop gaps also cut the reverb tails
    bus += ctx.free
    out, tp = master(bus[:, :ctx.n].astype(np.float64), secs[-1])
    return out, tp, secs


def main(argv):
    flags = [a for a in argv if a.startswith("--")]
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 2:
        sys.stderr.write("usage: python -I music.py <arrangement.json> <out.wav> [--report]\n")
        return 2
    with open(args[0]) as f:
        arr = json.load(f)
    t_start = time.time()
    out, tp, secs = render(arr)
    pcm = np.round(np.clip(out, -1.0, 1.0) * 32767.0).astype(np.int16).T
    wavfile.write(args[1], SR, np.ascontiguousarray(pcm))
    print("%.2f s | peak %.2f dBFS (true peak %.2f dBTP) | integrated ~%.1f LUFS (BS.1770 estimate) | rendered in %.1f s -> %s"
          % (out.shape[1] / SR, to_db(np.abs(out).max()), tp, lufs(out), time.time() - t_start, args[1]))
    if "--report" in flags:
        for s in secs:
            seg = out[:, s.i0:s.i1]
            print("  %-8s %7.2f - %7.2f s   rms %6.1f dBFS   peak %6.1f dBFS"
                  % (s.kind, s.t0, s.t1, to_db(np.sqrt(np.mean(seg ** 2))), to_db(np.abs(seg).max())))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
