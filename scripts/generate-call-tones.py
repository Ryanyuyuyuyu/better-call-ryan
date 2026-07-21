#!/usr/bin/env python3
"""Generate the original call UI tones used by Better Call Ryan."""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path


SAMPLE_RATE = 44_100
OUTPUT_DIRECTORY = Path(__file__).resolve().parents[1] / "assets" / "sounds"


def envelope(position: float, duration: float, attack: float = 0.018, release: float = 0.07) -> float:
    if position < 0 or position >= duration:
        return 0.0
    attack_level = min(1.0, position / attack) if attack else 1.0
    release_level = min(1.0, (duration - position) / release) if release else 1.0
    return min(attack_level, release_level)


def add_note(
    samples: list[float],
    start: float,
    duration: float,
    frequency: float,
    volume: float,
    *,
    shimmer: float = 0.14,
) -> None:
    first_sample = int(start * SAMPLE_RATE)
    sample_count = int(duration * SAMPLE_RATE)
    for offset in range(sample_count):
        position = offset / SAMPLE_RATE
        index = first_sample + offset
        if index >= len(samples):
            break
        body = math.sin(2 * math.pi * frequency * position)
        harmonic = math.sin(2 * math.pi * frequency * 2.01 * position) * shimmer
        samples[index] += (body + harmonic) * envelope(position, duration) * volume


def add_sweep(
    samples: list[float],
    start: float,
    duration: float,
    start_frequency: float,
    end_frequency: float,
    volume: float,
) -> None:
    first_sample = int(start * SAMPLE_RATE)
    sample_count = int(duration * SAMPLE_RATE)
    phase = 0.0
    for offset in range(sample_count):
        position = offset / SAMPLE_RATE
        progress = position / duration
        frequency = start_frequency + (end_frequency - start_frequency) * progress
        phase += 2 * math.pi * frequency / SAMPLE_RATE
        index = first_sample + offset
        if index >= len(samples):
            break
        samples[index] += math.sin(phase) * envelope(position, duration, 0.012, 0.09) * volume


def write_tone(filename: str, duration: float, composer) -> None:
    samples = [0.0] * int(duration * SAMPLE_RATE)
    composer(samples)
    peak = max(abs(sample) for sample in samples) or 1.0
    scale = min(1.0, 0.78 / peak)
    payload = b"".join(
        struct.pack("<h", int(max(-1.0, min(1.0, sample * scale)) * 32_767))
        for sample in samples
    )
    path = OUTPUT_DIRECTORY / filename
    with wave.open(str(path), "wb") as destination:
        destination.setnchannels(1)
        destination.setsampwidth(2)
        destination.setframerate(SAMPLE_RATE)
        destination.writeframes(payload)


def compose_incoming(samples: list[float]) -> None:
    motif = (
        (0.00, 0.26, 659.25, 0.31),
        (0.29, 0.26, 783.99, 0.29),
        (0.58, 0.48, 987.77, 0.26),
        (1.16, 0.24, 783.99, 0.25),
        (1.43, 0.44, 880.00, 0.27),
    )
    for start, duration, frequency, volume in motif:
        add_note(samples, start, duration, frequency, volume)
        add_note(samples, start, duration, frequency / 2, volume * 0.20, shimmer=0.0)


def compose_connected(samples: list[float]) -> None:
    add_sweep(samples, 0.00, 0.22, 520.0, 690.0, 0.24)
    add_note(samples, 0.12, 0.22, 880.0, 0.17, shimmer=0.09)


def compose_ended(samples: list[float]) -> None:
    add_note(samples, 0.00, 0.18, 622.25, 0.24, shimmer=0.08)
    add_note(samples, 0.24, 0.25, 415.30, 0.27, shimmer=0.06)


def main() -> None:
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    write_tone("incoming-ring.wav", 3.20, compose_incoming)
    write_tone("call-connected.wav", 0.42, compose_connected)
    write_tone("call-ended.wav", 0.58, compose_ended)


if __name__ == "__main__":
    main()
