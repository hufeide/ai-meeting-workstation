#!/usr/bin/env python3
"""Download the five public FunASR models into this app's private cache."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from modelscope import snapshot_download


MODELS = (
    ("语音识别 Paraformer", "speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch", "model.pt"),
    ("语音检测 FSMN-VAD", "speech_fsmn_vad_zh-cn-16k-common-pytorch", "model.pt"),
    ("标点恢复 CT-Punc", "punc_ct-transformer_cn-en-common-vocab471067-large", "model.pt"),
    ("时间戳预测", "speech_timestamp_prediction-v1-16k-offline", "model.pt"),
    ("说话人识别 Cam++", "speech_campplus_sv_zh-cn_16k-common", "campplus_cn_common.bin"),
)


def installed(cache: Path, name: str, weight: str) -> bool:
    candidates = (
        cache / "models" / ("iic--" + name),
        cache / "models" / "iic" / name,
        cache / "iic" / name,
    )
    return any(
        (base / "config.yaml").is_file() and (base / weight).is_file()
        for base in candidates
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-dir", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    cache = args.app_dir.resolve() / ".modelscope_cache"
    cache.mkdir(parents=True, exist_ok=True)
    os.environ["MODELSCOPE_CACHE"] = str(cache)

    for index, (label, name, weight) in enumerate(MODELS, start=1):
        if installed(cache, name, weight):
            print(f"[{index}/5] {label} 已存在，跳过", flush=True)
            continue
        print(f"[{index}/5] 正在下载 {label}：iic/{name}", flush=True)
        local_dir = snapshot_download(f"iic/{name}", revision="master", cache_dir=str(cache))
        if not ((Path(local_dir) / "config.yaml").is_file() and (Path(local_dir) / weight).is_file()):
            raise RuntimeError(f"{label} 下载返回成功，但缺少 config.yaml 或 {weight}；请重新运行安装器。")

    print("5 个本地转写模型已就绪。", flush=True)


if __name__ == "__main__":
    main()
