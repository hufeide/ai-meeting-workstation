"""FunASR 实时 ASR 桥（WebSocket 客户端版，对应教程 SDK_tutorial_online 方法）。

架构变化（相对旧版）：
  旧版在本进程内用 funasr.AutoModel 加载 pytorch 模型做推理；
  本版改为连接已部署的 FunASR runtime 服务（C++/ONNX，由 Docker 运行，
  默认 ws://127.0.0.1:10095），把浏览器来的 16k/单声道/s16le PCM 通过 WebSocket
  推流给服务端，再把服务端结果翻译回 Node 侧约定的 JSONL 协议。
  因此 src/server/asr/funasrRealtimeAsr.ts 无需任何改动。

服务端部署见 deploy_funasr_server.sh（封装官方 funasr-runtime-deploy-online-cpu-zh.sh）。

协议（每行一条 JSON，与旧版完全一致）：
  {"type":"ready"}
  {"type":"partial","text":...,"start":ms,"end":ms,"speaker":"speaker_0"}   流式中间结果
  {"type":"final","text":...,"start":ms,"end":ms,"speaker":"speaker_0"}    一段终稿（含标点）
  {"type":"error","message":"..."}
  {"type":"done"}

Node 侧（funasrRealtimeAsr.ts）spawn 本脚本（参数 --asr-home/--device/--speaker 保留以兼容，
模型已改为服务端加载，本地不再需要），把浏览器 PCM 写入 stdin，按行解析 stdout。
"""
import argparse
import asyncio
import json
import os
import ssl as ssl_mod
import sys
import threading
import time

SR = 16000
BYTE_RATE = SR * 2  # s16le：每秒字节数 = 16000 * 2

# 服务端回包的 mode 取值（online / 2pass-online 为流式中间结果，2pass-offline 为离线纠正终稿）
STREAM_MODES = ("online", "2pass-online")


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    # 以下三个参数仅保留以兼容 Node 侧调用，模型已改为服务端加载，本地不再使用。
    p.add_argument("--asr-home", default="")
    p.add_argument("--device", default="cpu")
    p.add_argument("--speaker", action="store_true", help="优先采用服务端回传的 spk_name 作为说话人")
    # 服务端连接参数（教程默认：本机 10095，SSL 关闭用 ws://）。
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=10095)
    p.add_argument("--mode", default="2pass", help="offline / online / 2pass")
    p.add_argument("--ssl", type=int, default=0, help="1 用 wss（需服务端开启 SSL），0 用 ws")
    p.add_argument("--chunk_size", default="5,10,5")
    p.add_argument("--chunk_interval", type=int, default=10)
    p.add_argument("--encoder_chunk_look_back", type=int, default=4)
    p.add_argument("--decoder_chunk_look_back", type=int, default=0)
    p.add_argument("--end_timeout", type=float, default=10.0, help="发完结束标志后等待服务端确认的秒数")
    return p.parse_args()


async def run(args: argparse.Namespace) -> int:
    try:
        import websockets
    except ImportError:
        emit({"type": "error", "message": "缺少 websockets 库，请先 `pip install websockets`。"})
        return 1

    if args.ssl:
        uri = f"wss://{args.host}:{args.port}"
        ssl_ctx = ssl_mod.SSLContext(ssl_mod.PROTOCOL_TLS_CLIENT)
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl_mod.CERT_NONE
    else:
        uri = f"ws://{args.host}:{args.port}"
        ssl_ctx = None

    try:
        ws = await websockets.connect(uri, subprotocols=["binary"], ping_interval=None, ssl=ssl_ctx)
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": f"无法连接 FunASR 服务 {uri}：{exc}"})
        return 1

    # 握手控制消息（与服务端约定的字段，参见官方 funasr_wss_client.py）。
    handshake = {
        "mode": args.mode,
        "chunk_size": [int(x) for x in args.chunk_size.split(",")],
        "chunk_interval": args.chunk_interval,
        "encoder_chunk_look_back": args.encoder_chunk_look_back,
        "decoder_chunk_look_back": args.decoder_chunk_look_back,
        "audio_fs": SR,
        "wav_name": "browser_stream",
        "wav_format": "pcm",
        "is_speaking": True,
        "hotwords": "",
        "itn": True,
    }
    await ws.send(json.dumps(handshake, ensure_ascii=False))
    emit({"type": "ready"})  # Node 侧 waitReady() 据此解除阻塞

    loop = asyncio.get_event_loop()
    t0: "float | None" = None  # 首段音频到达的墙钟时刻，用于生成真实时间戳（避免一次性灌入导致时间错乱）
    last_final_ms = 0.0       # 上一段 final 的结束时刻（墙钟毫秒）
    seg = 0                   # 当前说话段序号：同一句的 partial 与 final 共用，final 覆盖 partial 而不丢失文本
    seg_finalized = False     # 当前段是否已出过 final（出过则下个 partial 开启新段，防止尾随 partial 覆盖已提交终稿）
    seg_text = ""             # 当前段累积文本：本服务 2pass-offline 终稿常退化成碎片，故以 online 增量片段累积出完整句
    speaker_prev = "speaker_0"
    done_emitted = False
    done_evt = asyncio.Event()

    stdin_q: asyncio.Queue = asyncio.Queue()

    def stdin_feeder() -> None:
        # 在独立线程里阻塞读 stdin：本环境下 asyncio 的 loop.add_reader 对管道 fd
        # 会抛 PermissionError(Errno 1) Operation not permitted，改用线程读取更稳妥。
        try:
            while True:
                data = sys.stdin.buffer.read(65536)
                if not data:
                    break
                loop.call_soon_threadsafe(stdin_q.put_nowait, data)
        except Exception:  # noqa: BLE001
            pass
        finally:
            loop.call_soon_threadsafe(stdin_q.put_nowait, b"")  # EOF 哨兵

    stdin_thread = threading.Thread(target=stdin_feeder, daemon=True)
    stdin_thread.start()

    def elapsed_ms() -> float:
        return (time.monotonic() - t0) * 1000.0 if t0 is not None else 0.0

    # 缓冲 stdin 后按固定 200ms 块（CHUNK_MS）发给服务端，与 VAD/ASR 流式 chunk_size 对齐。
    # 浏览器推来的音频包大小不固定（~85ms），若原样转发，流式解码 cache 会错位、
    # 输出退化成“好的好的的是的是的”这类乱码。固定 stride 可避免该问题（对齐官方 2pass 客户端）。
    async def pump_stdin() -> None:
        nonlocal t0
        buf = b""
        chunk_bytes = 200 * SR // 1000 * 2  # 200ms @16k s16le = 6400 字节，与 VAD/ASR 流式 chunk_size 对齐
        while True:
            data = await stdin_q.get()
            if not data:
                # stdin 关闭（Node 侧 session.close() 会 end stdin）：通知服务端本路结束。
                if buf:
                    await ws.send(buf)
                await ws.send(json.dumps({"is_speaking": False, "is_end": True}, ensure_ascii=False))
                try:
                    await asyncio.wait_for(done_evt.wait(), timeout=args.end_timeout)
                except asyncio.TimeoutError:
                    pass
                break
            if t0 is None:
                t0 = time.monotonic()
            buf += data
            while len(buf) >= chunk_bytes:
                await ws.send(buf[:chunk_bytes])
                buf = buf[chunk_bytes:]

    async def recv_loop() -> None:
        nonlocal last_final_ms, speaker_prev, done_emitted, seg, seg_finalized, seg_text
        try:
            async for meg in ws:
                if not isinstance(meg, str):
                    continue
                try:
                    msg = json.loads(meg)
                except Exception:  # noqa: BLE001
                    continue
                text = (msg.get("text") or "")
                mode = msg.get("mode", "")
                is_final = bool(msg.get("is_final", False))
                is_end = bool(msg.get("is_end", False))
                spk = (msg.get("spk_name") or "")

                if args.speaker and spk:
                    speaker = spk
                    speaker_prev = spk
                else:
                    speaker = speaker_prev if (args.speaker and speaker_prev != "speaker_0") else "speaker_0"

                if is_end:
                    if not done_emitted:
                        emit({"type": "done"})
                        done_emitted = True
                    done_evt.set()
                    break
                if msg.get("error"):
                    emit({"type": "error", "message": str(msg.get("error"))})
                    continue
                if is_final and text:
                    # 终稿直接采用服务端 2pass-offline 结果（权威，含标点 + spk_name）。
                    # 本地 pytorch 服务（funasr_asr_server.py）离线终稿由"整段离线解码 + 标点模型"生成，
                    # 质量高于在线流式累积文本，故不再退回无标点的在线累积 seg_text。
                    # 仅在服务端终稿为空（极端退化）时才回退到在线累积文本。
                    final_text = text or seg_text
                    start = round(last_final_ms)
                    end = round(elapsed_ms())
                    emit({"type": "final", "text": final_text, "start": start, "end": end, "speaker": speaker, "seg": seg})
                    last_final_ms = end
                    seg_finalized = True
                    seg_text = ""
                elif text and mode in STREAM_MODES:
                    # 若上一段已出 final，则开启新段，避免尾随 partial 覆盖已提交终稿
                    if seg_finalized:
                        seg += 1
                        seg_finalized = False
                        seg_text = ""
                    # 累积增量片段为完整句；同时兼容"整句增长"型 partial（以更长者覆盖）
                    if seg_text and len(text) > len(seg_text) and text.startswith(seg_text):
                        seg_text = text
                    else:
                        seg_text += text
                    start = round(last_final_ms)
                    end = round(elapsed_ms())
                    emit({"type": "partial", "text": seg_text, "start": start, "end": end, "speaker": speaker, "seg": seg})
        except Exception as exc:  # noqa: BLE001
            if not done_emitted:
                emit({"type": "error", "message": f"FunASR 服务连接异常：{exc}"})
        finally:
            done_evt.set()

    try:
        pump_task = asyncio.create_task(pump_stdin())
        recv_task = asyncio.create_task(recv_loop())
        await recv_task
        await pump_task
    finally:
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
    return 0


def main() -> int:
    args = parse_args()
    if args.asr_home or args.device != "cpu":
        # 仅提示：模型已改为服务端加载，本地 --asr-home/--device 不再使用。
        print("[info] FunASR 已切换到 runtime 服务模式，--asr-home/--device 被忽略（模型由服务端加载）。",
              file=sys.stderr, flush=True)
    try:
        return asyncio.run(run(args))
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": f"FunASR 实时桥启动失败：{exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
