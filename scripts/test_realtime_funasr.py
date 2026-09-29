"""FunASR 实时 ASR 可行性测试（仅用已下载的本地模型，不联网下载新模型）。

架构：流式 fsmn-vad 检测句子边界 -> 对完成的句子跑离线 SeacoParaformer(+标点) 出终稿。
这一步验证：本地模型能否做"句子级实时"转写（延迟=一句话说完才出字）。
真正的"字级流式"需要下载 -online 模型，本脚本不覆盖。

用法：
  python scripts/test_realtime_funasr.py [音频路径] [秒数限制]
"""
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HOME = Path("/home/fei/workspace/ai-meeting-workstation")
MODELS = HOME / ".modelscope_cache"
os.environ["MODELSCOPE_CACHE"] = str(MODELS)
os.environ["HF_HOME"] = str(HOME / ".hf_cache")

DEMO = HOME / "assets/demo/chengyuan-tech-fallback-open-kokoro.wav"
SR = 16000


def load_audio_16k_mono(path: Path) -> np.ndarray:
    """用 ffmpeg 解码为 16k/单声道/float32(-1,1)，避免 torchcodec/soundfile 依赖问题。"""
    cmd = [
        "ffmpeg", "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", str(SR),
        "-loglevel", "error", "-",
    ]
    raw = subprocess.check_output(cmd)
    return np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0


def main() -> int:
    audio_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEMO
    limit_sec = float(sys.argv[2]) if len(sys.argv) > 2 else 25.0

    print(f"[1/3] 解码音频 {audio_path} ...", flush=True)
    speech = load_audio_16k_mono(audio_path)
    limit_samples = int(min(limit_sec, len(speech) / SR) * SR)
    speech = speech[:limit_samples]
    print(f"      时长 {len(speech) / SR:.1f}s @ {SR}Hz", flush=True)

    from funasr import AutoModel

    print("[2/3] 加载模型（vad 流式 + asr 离线+标点）...", flush=True)
    vad = AutoModel(
        model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        disable_update=True,
        device="cuda",
    )
    asr = AutoModel(
        model="iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        vad_model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        punc_model="iic/punc_ct-transformer_cn-en-common-vocab471067-large",
        disable_update=True,
        device="cuda",
    )
    print("      模型就绪", flush=True)

    chunk_ms = 200
    stride = int(chunk_ms * SR / 1000)
    cache: dict = {}
    open_start_ms: float | None = None
    count = 0
    t_start = time.time()

    def run_asr(start_ms: float, end_ms: float) -> None:
        nonlocal count
        s_idx, e_idx = int(start_ms / 1000 * SR), int(end_ms / 1000 * SR)
        seg = speech[s_idx:e_idx]
        if len(seg) < int(0.25 * SR):
            return
        r = asr.generate(input=seg, batch_size_s=60)
        text = (r[0].get("text") or "").strip()
        print(f"  [{count:02d}] {end_ms / 1000:6.1f}s | {text}", flush=True)
        count += 1

    print("[3/3] 模拟实时喂音（200ms/块）...", flush=True)
    for start in range(0, len(speech), stride):
        chunk = speech[start : start + stride]
        is_final = (start + stride) >= len(speech)
        res = vad.generate(
            input=chunk,
            cache=cache,
            is_final=is_final,
            chunk_size=chunk_ms,
            mode="online" if not is_final else "offline",
        )
        segs = (res[0].get("value") or []) if res else []
        # fsmn-vad 流式协议：开始返回 [start,-1]，结束返回 [-1,end]
        for s, e in segs:
            if s != -1 and e == -1:
                open_start_ms = s
            elif s == -1 and e != -1:
                if open_start_ms is not None:
                    run_asr(open_start_ms, e)
                    open_start_ms = None
            elif s != -1 and e != -1:
                run_asr(s, e)
        if is_final and open_start_ms is not None:
            run_asr(open_start_ms, len(speech) / SR * 1000)
            open_start_ms = None

    print(f"\nDONE: 识别 {count} 句，耗时 {time.time()-t_start:.1f}s（音频 {len(speech)/SR:.1f}s）", flush=True)
    if count == 0:
        print("⚠ 未识别出任何句子。请检查音频是否含人声，或 VAD 阈值。", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
