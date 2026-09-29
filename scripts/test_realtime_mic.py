#!/usr/bin/env python3
"""用录音装置（麦克风）直接测试本地 FunASR 实时转写，绕过浏览器/WebSocket。

把麦克风采集到的 16k 单声道 s16le PCM 实时喂给 realtime_funasr.py 桥，
打印返回的转写，用于确认「模型 + 录音设备」这一环是否正常。

用法：
  # 用默认录音设备（PulseAudio）测试，说话即可看到转写，Ctrl-C 停止
  python scripts/test_realtime_mic.py --asr-home /home/fei/workspace/ai-meeting-workstation

  # 指定后端 / 设备（Linux 也可选 alsa；macOS 用 avfoundation）
  python scripts/test_realtime_mic.py --asr-home ... --backend alsa --mic default
  python scripts/test_realtime_mic.py --asr-home ... --backend avfoundation --mic ":0"

  # 不依赖麦克风，先用演示音频验证模型+桥（冒烟测试）
  python scripts/test_realtime_mic.py --asr-home ... --file assets/demo/chengyuan-tech-fallback-open-kokoro.wav

  # 只录 N 秒
  python scripts/test_realtime_mic.py --asr-home ... --seconds 20
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BRIDGE = SCRIPT_DIR / "realtime_funasr.py"


def find_ffmpeg() -> str:
    if subprocess.run(["ffmpeg", "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return "ffmpeg"
    raise SystemExit("未找到 ffmpeg，请先安装 ffmpeg（用于采集/解码音频）。")


def capture_command(ffmpeg: str, backend: str, mic: str, file: str | None, seconds: int) -> list[str]:
    if file:
        src = ["-i", file]
    elif backend == "pulse":
        src = ["-f", "pulse", "-i", mic]
    elif backend == "alsa":
        src = ["-f", "alsa", "-i", mic]
    elif backend == "avfoundation":
        src = ["-f", "avfoundation", "-i", mic]
    else:
        raise SystemExit(f"未知后端：{backend}")
    base = [ffmpeg, "-y", *src, "-f", "s16le", "-ac", "1", "-ar", "16000", "-loglevel", "error", "-"]
    if seconds and not file:
        base = [ffmpeg, "-y", "-t", str(seconds), *src, "-f", "s16le", "-ac", "1", "-ar", "16000", "-loglevel", "error", "-"]
    return base


def main() -> int:
    parser = argparse.ArgumentParser(description="用录音装置测试本地 FunASR 实时转写。")
    parser.add_argument("--asr-home", required=True, help="含 .modelscope_cache 的目录")
    parser.add_argument("--device", default="auto", help="cuda / cpu / auto（auto 会自动选 cuda）")
    parser.add_argument("--backend", default="pulse", choices=["pulse", "alsa", "avfoundation"])
    parser.add_argument("--mic", default="default", help="录音设备名或索引")
    parser.add_argument("--file", default="", help="改用音频文件代替麦克风（冒烟测试）")
    parser.add_argument("--seconds", type=int, default=0, help="录制秒数，0=按 Ctrl-C 停止")
    args = parser.parse_args()

    ffmpeg = find_ffmpeg()

    bridge = subprocess.Popen(
        [sys.executable, str(BRIDGE), "--asr-home", args.asr_home, "--device", args.device],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    cmd = capture_command(ffmpeg, args.backend, args.mic, args.file or None, args.seconds)
    recorder = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    stop = threading.Event()

    def pump() -> None:
        try:
            while not stop.is_set():
                chunk = recorder.stdout.read(3200)  # 约 100ms @16k*2
                if not chunk:
                    break
                if bridge.poll() is not None:
                    break
                bridge.stdin.write(chunk)
                bridge.stdin.flush()
        except (BrokenPipeError, ValueError):
            pass
        finally:
            try:
                bridge.stdin.close()
            except Exception:
                pass

    pump_thread = threading.Thread(target=pump, daemon=True)
    pump_thread.start()

    source_label = args.file or f"{args.backend}:{args.mic}"
    print(f"[test_realtime_mic] 来源={source_label} 设备={args.device}；说话即可看到转写，Ctrl-C 停止。", flush=True)
    try:
        for raw in bridge.stdout:
            line = raw.decode("utf8", "replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            mtype = msg.get("type")
            if mtype == "ready":
                print("[bridge] 模型已就绪，开始聆听…", flush=True)
            elif mtype == "final":
                print(f"[转录] {msg['text']}  (speaker={msg.get('speaker')}, {msg.get('start')}-{msg.get('end')}ms)", flush=True)
            elif mtype == "error":
                print(f"[bridge error] {msg['message']}", flush=True)
                break
            elif mtype == "done":
                print("[bridge] 结束。", flush=True)
                break
    except KeyboardInterrupt:
        print("\n[test_realtime_mic] 停止。", flush=True)
    finally:
        stop.set()
        recorder.terminate()
        bridge.terminate()
        pump_thread.join(timeout=2)

    if bridge.poll() is None:
        bridge.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
