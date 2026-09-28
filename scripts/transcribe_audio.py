#!/usr/bin/env python3
"""Transcribe local audio with a user-provided FunASR environment."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


DEFAULT_ASR_HOME = Path.cwd()

MODEL_DIRS = {
    "asr": "speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "vad": "speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "punc": "punc_ct-transformer_cn-en-common-vocab471067-large",
    "timestamp": "speech_timestamp_prediction-v1-16k-offline",
    "speaker": "speech_campplus_sv_zh-cn_16k-common",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio with local FunASR.")
    parser.add_argument("--input", required=True, help="Path to an audio or video file.")
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for transcript.txt, transcript.json, and transcript.md.",
    )
    parser.add_argument(
        "--asr-home",
        default=str(DEFAULT_ASR_HOME),
        help="Directory containing .venv and .modelscope_cache. Defaults to the current directory.",
    )
    parser.add_argument("--ncpu", type=int, default=4, help="CPU workers for FunASR.")
    parser.add_argument(
        "--device",
        choices=("auto", "cpu", "mps"),
        default="auto",
        help="Inference device. auto uses Apple MPS when available, otherwise CPU.",
    )
    parser.add_argument(
        "--speaker-diarization",
        action="store_true",
        help="Enable local cam++ speaker diarization and speaker labels when the model is available.",
    )
    parser.add_argument(
        "--hotwords",
        default="",
        help="Optional whitespace-separated hotwords to bias recognition.",
    )
    parser.add_argument(
        "--hotword-file",
        default="",
        help="Optional UTF-8 text file containing hotwords, one per line or whitespace-separated.",
    )
    return parser.parse_args()


def require_path(path: Path, label: str) -> None:
    if not path.exists():
        raise SystemExit(f"Missing {label}: {path}")


def resolve_model_path(asr_home: Path, folder: str) -> Path:
    cache_root = asr_home / ".modelscope_cache"
    candidates = [
        cache_root / "models" / "iic" / folder,
        cache_root / "iic" / folder,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def convert_to_wav(source: Path, wav_path: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required but was not found on PATH.")

    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-sample_fmt",
        "s16",
        str(wav_path),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"ffmpeg conversion failed:\n{proc.stderr}")


def resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested

    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(asr_home: Path, ncpu: int, speaker_diarization: bool, device: str):
    model_paths = {key: resolve_model_path(asr_home, folder) for key, folder in MODEL_DIRS.items()}
    required_keys = ["asr", "vad", "punc", "timestamp"]
    if speaker_diarization:
        required_keys.append("speaker")
    for key in required_keys:
        path = model_paths[key]
        require_path(path, f"{key} model")

    os.environ["MODELSCOPE_CACHE"] = str(asr_home / ".modelscope_cache")
    os.environ["HF_HOME"] = str(asr_home / ".hf_cache")

    from funasr import AutoModel

    model_kwargs = {
        "model": str(model_paths["asr"]),
        "vad_model": str(model_paths["vad"]),
        "punc_model": str(model_paths["punc"]),
        "timestamp_model": str(model_paths["timestamp"]),
        "device": device,
        "disable_update": True,
        "ncpu": ncpu,
    }
    if speaker_diarization:
        model_kwargs["spk_model"] = str(model_paths["speaker"])

    return AutoModel(**model_kwargs)


def read_hotwords(hotwords: str, hotword_file: str) -> str:
    parts: list[str] = []
    if hotwords.strip():
        parts.extend(hotwords.split())
    if hotword_file:
        path = Path(hotword_file).expanduser().resolve()
        require_path(path, "hotword file")
        for line in path.read_text(encoding="utf-8").splitlines():
            clean = line.strip()
            if clean and not clean.startswith("#"):
                parts.extend(clean.split())
    return " ".join(dict.fromkeys(parts))


def format_ms(value: object) -> str:
    try:
        total_ms = int(float(value))
    except (TypeError, ValueError):
        return "--:--"
    seconds, ms = divmod(total_ms, 1000)
    minutes, sec = divmod(seconds, 60)
    hours, minute = divmod(minutes, 60)
    if hours:
        return f"{hours:02d}:{minute:02d}:{sec:02d}.{ms:03d}"
    return f"{minute:02d}:{sec:02d}.{ms:03d}"


def normalize_speaker(raw: object) -> str:
    if raw is None or raw == "":
        return "Speaker ?"
    text = str(raw)
    if text.lower().startswith("speaker"):
        return text
    return f"Speaker {text}"


def sentence_segments(result: list[dict]) -> list[dict]:
    segments: list[dict] = []
    for item in result:
        for segment in item.get("sentence_info") or []:
            text = str(segment.get("text", "")).strip()
            if not text:
                continue
            speaker = segment.get("speaker", segment.get("spk", segment.get("speaker_id")))
            segments.append(
                {
                    "start": segment.get("start"),
                    "end": segment.get("end"),
                    "speaker": normalize_speaker(speaker),
                    "text": text,
                }
            )
    return segments


def flatten_text(result: list[dict]) -> str:
    segments = sentence_segments(result)
    if segments:
        lines = []
        for segment in segments:
            start = format_ms(segment.get("start"))
            end = format_ms(segment.get("end"))
            lines.append(f"[{start}-{end}] {segment['speaker']}: {segment['text']}")
        return "\n".join(lines).strip()

    parts: list[str] = []
    for item in result:
        text = str(item.get("text", "")).strip()
        if text:
            parts.append(text)
    return "\n".join(parts).strip()


def write_outputs(
    output_dir: Path,
    source: Path,
    result: list[dict],
    speaker_diarization: bool,
    hotword_text: str,
    device: str,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    text = flatten_text(result)
    segments = sentence_segments(result)
    generated_at = dt.datetime.now().isoformat(timespec="seconds")

    (output_dir / "transcript.txt").write_text(text + "\n", encoding="utf-8")
    if segments:
        (output_dir / "speaker_segments.json").write_text(
            json.dumps(segments, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    (output_dir / "transcript.json").write_text(
        json.dumps(
            {
                "source": str(source),
                "generated_at": generated_at,
                "engine": "local FunASR",
                "device": device,
                "speaker_diarization": speaker_diarization,
                "hotwords": hotword_text.split(),
                "result": result,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (output_dir / "transcript.md").write_text(
        "\n".join(
            [
                "# Transcript",
                "",
                f"- Source: `{source}`",
                f"- Generated at: {generated_at}",
                "- Engine: local FunASR",
                f"- Device: {device}",
                f"- Speaker diarization: {speaker_diarization}",
                "",
                "## Text",
                "",
                text,
                "",
            ]
        ),
        encoding="utf-8",
    )


def main() -> int:
    args = parse_args()
    source = Path(args.input).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    asr_home = Path(args.asr_home).expanduser().resolve()

    require_path(source, "input file")
    require_path(asr_home / ".venv", "ASR virtual environment")
    require_path(asr_home / ".modelscope_cache", "ModelScope cache")

    hotword_text = read_hotwords(args.hotwords, args.hotword_file)
    device = resolve_device(args.device)
    model = load_model(asr_home, args.ncpu, args.speaker_diarization, device)
    with tempfile.TemporaryDirectory(prefix="meeting-notes-asr-") as tmp:
        wav_path = Path(tmp) / "input-16k-mono.wav"
        convert_to_wav(source, wav_path)
        generate_kwargs = {"input": str(wav_path), "batch_size_s": 60}
        if hotword_text:
            generate_kwargs["hotword"] = hotword_text
        result = model.generate(**generate_kwargs)

    write_outputs(output_dir, source, result, args.speaker_diarization, hotword_text, device)
    print(f"Wrote transcript outputs to: {output_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
