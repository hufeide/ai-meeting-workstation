"""FunASR 实时（句级）ASR 桥：从 stdin 读 16k/单声道/s16le PCM，
用 fsmn-vad 流式分段 + SeacoParaformer 离线识别 + 标点，把结果以 JSONL 写到 stdout。

协议（每行一条 JSON）：
  {"type":"ready"}                                  启动完成，可接收音频
  {"type":"final","text":...,"start":ms,"end":ms,"speaker":"speaker_0"}   一句终稿
  {"type":"error","message":"..."}                失败
  {"type":"done"}                                  流结束、已 flush

Node 侧（funasrRealtimeAsr.ts）spawn 本脚本，把浏览器 PCM 写入 stdin，按行解析 stdout。
"""
import argparse
import contextlib
import io
import json
import logging
import os
import sys
from pathlib import Path

import numpy as np

SR = 16000
CHUNK_MS = 200
STRIDE = int(CHUNK_MS * SR / 1000)          # 采样数/窗
WINDOW_BYTES = STRIDE * 2                     # s16le 字节数/窗
MIN_SEG_SAMPLES = int(0.25 * SR)             # 短于 0.25s 的段丢弃

HUB = {
    "vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "asr": "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "punc": "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
    "spk": "iic/speech_campplus_sv_zh-cn_16k-common",
}


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asr-home", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--speaker", action="store_true", help="启用 cam++ 说话人聚类")
    args = parser.parse_args()

    cache = Path(args.asr_home) / ".modelscope_cache"
    os.environ["MODELSCOPE_CACHE"] = str(cache)
    os.environ["HF_HOME"] = str(Path(args.asr_home) / ".hf_cache")

    # FunASR 导入时会向 stdout 打印版本横幅/进度，捕获以免污染 JSONL 流。
    logging.getLogger("funasr").setLevel(logging.WARNING)
    with contextlib.redirect_stdout(io.StringIO()):
        from funasr import AutoModel

    device = args.device
    if device == "auto":
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"
    vad = AutoModel(model=HUB["vad"], disable_update=True, device=device)
    asr = AutoModel(
        model=HUB["asr"],
        vad_model=HUB["vad"],
        punc_model=HUB["punc"],
        disable_update=True,
        device=device,
    )
    spk_model = AutoModel(model=HUB["spk"], disable_update=True, device=device) if args.speaker else None

    emit({"type": "ready"})

    speech_all = []          # 累积 float32 片段，用于按 ms 切片
    total_samples = 0
    vad_cache: dict = {}
    open_start_ms: float | None = None
    profiles: list[np.ndarray] = []

    def cluster_speaker(seg: np.ndarray) -> str:
        if spk_model is None or seg.size == 0:
            return "speaker_0"
        raw = spk_model.generate(input=seg)[0]["spk_embedding"]
        emb = np.asarray(raw.cpu().numpy() if hasattr(raw, "cpu") else raw, dtype="float32").flatten()
        best_i, best_sim = -1, -1.0
        for i, p in enumerate(profiles):
            sim = float(np.dot(emb, p) / (np.linalg.norm(emb) * np.linalg.norm(p) + 1e-9))
            if sim > best_sim:
                best_sim, best_i = sim, i
        if best_i >= 0 and best_sim >= 0.7:
            return f"speaker_{best_i}"
        profiles.append(emb)
        return f"speaker_{len(profiles) - 1}"

    def emit_segment(start_ms: float, end_ms: float) -> None:
        s_idx, e_idx = int(start_ms / 1000 * SR), int(end_ms / 1000 * SR)
        seg = np.concatenate(speech_all)[s_idx:e_idx] if speech_all else np.zeros(0)
        if seg.size < MIN_SEG_SAMPLES:
            return
        r = asr.generate(input=seg, batch_size_s=60)
        text = (r[0].get("text") or "").strip()
        speaker = cluster_speaker(seg) if args.speaker else "speaker_0"
        emit({"type": "final", "text": text, "start": round(start_ms), "end": round(end_ms), "speaker": speaker})

    def feed(window: bytes, is_final: bool) -> None:
        nonlocal open_start_ms, total_samples
        if window:
            chunk = np.frombuffer(window, dtype="<i2").astype("float32") / 32768.0
            speech_all.append(chunk)
            total_samples += chunk.size
            res = vad.generate(
                input=chunk,
                cache=vad_cache,
                is_final=is_final,
                chunk_size=CHUNK_MS,
                mode="online" if not is_final else "offline",
            )
            segs = (res[0].get("value") or []) if res else []
            # fsmn-vad 流式协议：开始返回 [start,-1]，结束返回 [-1,end]
            for s, e in segs:
                if s != -1 and e == -1:
                    open_start_ms = s
                elif s == -1 and e != -1:
                    if open_start_ms is not None:
                        emit_segment(open_start_ms, e)
                        open_start_ms = None
                elif s != -1 and e != -1:
                    emit_segment(s, e)
        if is_final and open_start_ms is not None:
            emit_segment(open_start_ms, total_samples / SR * 1000)
            open_start_ms = None

    try:
        buf = b""
        while True:
            data = sys.stdin.buffer.read(4096)
            if not data:
                break
            buf += data
            while len(buf) >= WINDOW_BYTES:
                feed(buf[:WINDOW_BYTES], False)
                buf = buf[WINDOW_BYTES:]
        if buf:
            feed(buf, True)
        else:
            feed(b"", True)
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": f"FunASR 实时桥异常：{exc}"})
        return 1

    emit({"type": "done"})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": f"FunASR 实时桥启动失败：{exc}"})
        raise SystemExit(1)
