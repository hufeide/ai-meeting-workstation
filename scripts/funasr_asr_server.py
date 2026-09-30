"""FunASR 实时 ASR 服务端（无需 Docker，使用本地 pytorch 模型）。

这是「教程 SDK_tutorial_online 方法」在“不能装 Docker / 用本地模型”场景下的等价替代：
对外讲与官方 FunASR runtime（funasr-wss-server-2pass）完全相同的 WebSocket 协议，
因此 scripts/realtime_funasr.py（已改写为 WebSocket 客户端）和 Node 侧都无需改动。

- 加载本地 pytorch 模型（iic/* 系列），模型缓存位于 <asr-home>/.modelscope_cache
- 监听 ws://0.0.0.0:10095
- 收到握手 JSON + 二进制 PCM(s16le,16k) 分片 + 结束消息后，
  回传 {"mode":"2pass-online","text":...} 流式中间结果、
        {"mode":"2pass-offline","text":...,"is_final":true,"spk_name":...} 段终稿、
        {"is_end":true} 结束确认。

启动：
  python3 scripts/funasr_asr_server.py --asr-home /home/fei/workspace/ai-meeting-workstation --speaker
该进程是常驻单例（可被多个会议房间并发连接），请用 nohup/systemd 托管。
"""
import argparse
import asyncio
import contextlib
import io
import json
import logging
import os
import re
import sys
from pathlib import Path

import numpy as np

SR = 16000
CHUNK_MS = 200
WINDOW_BYTES = int(CHUNK_MS * SR / 1000) * 2  # 200ms/窗 = 6400 字节（s16le）
STRIDE = 9600  # 600ms @16k：流式识别窗（chunk_size[1]=10 -> 10*60ms）
MIN_SEG_SAMPLES = int(0.25 * SR)  # 短于 0.25s 的段丢弃

HUB = {
    "vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "asr": "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "punc": "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
    "spk": "iic/speech_campplus_sv_zh-cn_16k-common",
}

SPK_THRESHOLD = 0.35
SPK_MIN_SEC = 1.0
SPK_MAX = 12

FILLERS = ("嗯", "呃", "啊", "呀", "哦", "唉", "没有", "那个", "这个", "就是", "的话")


def clean_stream(text: str) -> str:
    # 关键：必须保留英文单词之间的空格，不能整体去空白（否则 "hello world" -> "helloworld"）。
    # 这里仅把连续空白压缩为单个空格，并去除首尾空白。
    s = " ".join(text.split())
    if not s:
        return ""
    changed = True
    while changed:
        changed = False
        for f in FILLERS:
            if len(s) >= len(f) and s.startswith(f):
                s = s[len(f):].lstrip()
                changed = True
            elif len(s) >= len(f) and s.endswith(f):
                s = s[: len(s) - len(f)].rstrip()
                changed = True
    return s


# CJK 字符范围（含常用汉字与扩展 A）
_CJK = r"[\u3400-\u4dbf\u4e00-\u9fff]"


def fix_spaces(text: str) -> str:
    """标点模型（punc_ct-transformer）会把英文单词周围的空格删掉（如 “我们使用GPT模型”）。
    此函数在 CJK 与 ASCII 字母/数字之间补回空格，并折叠多余空格，满足“英文之间空格不能去”。"""
    if not text:
        return ""
    text = re.sub(rf"({_CJK})([A-Za-z0-9])", r"\1 \2", text)
    text = re.sub(rf"([A-Za-z0-9])({_CJK})", r"\1 \2", text)
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


def merge_text(a: str, b: str) -> str:
    if not a:
        return b
    if not b:
        return a
    maxov = min(len(a), len(b))
    for k in range(maxov, 0, -1):
        if a[-k:] == b[:k]:
            return a + b[k:]
    return a + b


class Session:
    """单个 WebSocket 连接的识别状态机，复用旧 realtime_funasr.py 的推理逻辑。"""

    def __init__(self, models, wav_name: str, speaker_enabled: bool, chunk_size: list | None = None, chunk_interval: int = 10):
        self.vad, self.asr, self.punc, self.spk = models
        self.wav_name = wav_name
        self.speaker_enabled = speaker_enabled and self.spk is not None
        # 流式解码窗：默认 600ms（[5,10,5]）。优先采用客户端握手下发的值，保持与官方 2pass 协议一致。
        self.chunk_size = chunk_size if (isinstance(chunk_size, (list, tuple)) and len(chunk_size) == 3) else [5, 10, 5]
        self.chunk_interval = chunk_interval if (isinstance(chunk_interval, int) and chunk_interval > 0) else 10
        self.spk_centroids: list[np.ndarray] = []
        self.spk_prev = 0
        self.vad_cache: dict = {}
        self.seg_open: bool = False           # 当前是否处于“检测到语音”区间
        self.frames_asr: list[bytes] = []     # 语音激活期间累积的原始 PCM（bytes），供 final 整段离线解码
        self.stream_cache: dict = {}          # 在线流式解码 cache（600ms 窗流式切片用，跨调用保持）
        self.stream_buf = np.zeros(0, dtype=np.float32)
        self.last_partial = ""
        self.partial_accum = ""
        self.out: list[dict] = []

    def cluster_speaker(self, seg: np.ndarray) -> str:
        if not self.speaker_enabled or self.spk is None or seg.size == 0:
            return "speaker_0"
        dur = seg.size / SR
        if dur < SPK_MIN_SEC and self.spk_centroids:
            return f"speaker_{self.spk_prev}"
        try:
            raw = self.spk.generate(input=seg)[0]["spk_embedding"]
            emb = np.asarray(raw.cpu().numpy() if hasattr(raw, "cpu") else raw, dtype="float32").flatten()
        except Exception:
            return f"speaker_{self.spk_prev}" if self.spk_centroids else "speaker_0"
        emb = emb / (np.linalg.norm(emb) + 1e-9)
        if not self.spk_centroids:
            self.spk_centroids.append(emb.copy())
            self.spk_prev = 0
            return "speaker_0"
        sims = np.array([float(np.dot(c, emb)) for c in self.spk_centroids])
        best_i = int(np.argmax(sims))
        if sims[best_i] >= SPK_THRESHOLD and len(self.spk_centroids) <= SPK_MAX:
            self.spk_centroids[best_i] = (self.spk_centroids[best_i] * 0.9 + emb * 0.1)
            self.spk_centroids[best_i] /= np.linalg.norm(self.spk_centroids[best_i]) + 1e-9
            self.spk_prev = best_i
            return f"speaker_{best_i}"
        if len(self.spk_centroids) >= SPK_MAX:
            self.spk_prev = best_i
            return f"speaker_{best_i}"
        self.spk_centroids.append(emb.copy())
        self.spk_prev = len(self.spk_centroids) - 1
        return f"speaker_{self.spk_prev}"

    def stream_decode(self, chunk: np.ndarray, is_final: bool) -> str:
        """对单个 ~600ms 流式窗做增量解码（cache 跨窗保持）。模型返回的是该窗的增量文本，
        由调用方用 merge_text 累积成完整句。这种方式在实测中能产出正确中文（如
        “今天我们用共长远科技…复盘会议对不对…”），比整段离线/is_final 整段解码可靠。"""
        try:
            r = self.asr.generate(
                input=chunk,
                cache=self.stream_cache,
                is_final=is_final,
                chunk_size=self.chunk_size,
                encoder_chunk_look_back=4,
                decoder_chunk_look_back=4,
            )
            return clean_stream(r[0].get("text") or "")
        except Exception:
            return ""

    def emit_final(self) -> None:
        # 终稿音频来自语音激活期间累积的 frames_asr（原始 PCM），不依赖 VAD 的 value 索引切片
        # （流式 VAD 的 value 是窗内相对索引，直接切片会得到极小片段 → 之前“今天。”“嗯。”乱码的根因）。
        seg_bytes = b"".join(self.frames_asr)
        seg = np.frombuffer(seg_bytes, dtype="<i2").astype("float32") / 32768.0 if seg_bytes else np.zeros(0, dtype=np.float32)
        raw_text = ""
        if seg.size >= MIN_SEG_SAMPLES:
            try:
                # 关键修复：整段离线解码（不传 chunk_size，让模型走 offline 路径），
                # 实测产出正确全文（如“今天我们用成远科技…复盘会议…客户回访表…”）。
                # 旧的 batch_size_s=60 / is_final 整段流式两种方式都会把 Seaco 流式模型跑成乱码。
                r = self.asr.generate(input=seg)
                raw_text = clean_stream(r[0].get("text") or "")
            except Exception:
                raw_text = ""
            # 标点模型加标点（四个模型之一），解决“实时没有标点”的问题
            if self.punc is not None and raw_text:
                try:
                    raw_text = self.punc.generate(input=raw_text)[0].get("text") or raw_text
                except Exception:
                    pass
                # 标点模型会删掉英文周围的空格，补回（见 fix_spaces）
                raw_text = fix_spaces(raw_text)
        speaker = self.cluster_speaker(seg) if self.speaker_enabled else "speaker_0"
        self.out.append({
            "mode": "2pass-offline",
            "text": raw_text,
            "is_final": True,
            "wav_name": self.wav_name,
            "spk_name": speaker,
        })
        self.stream_cache = {}
        self.stream_buf = np.zeros(0, dtype=np.float32)
        self.last_partial = ""
        self.partial_accum = ""

    def process(self, window: bytes, is_final: bool) -> list[dict]:
        """处理一个二进制 PCM 分片，返回要回传的消息列表。"""
        self.out = []
        if window:
            chunk = np.frombuffer(window, dtype="<i2").astype("float32") / 32768.0
            # ---- 在线流式 partial：累积到 600ms 窗后做增量解码，用 merge_text 累积成完整句 ----
            self.stream_buf = np.concatenate([self.stream_buf, chunk])
            while self.stream_buf.size >= STRIDE:
                sub = self.stream_buf[:STRIDE]
                self.stream_buf = self.stream_buf[STRIDE:]
                text = self.stream_decode(sub, False)
                if self.seg_open and text:
                    accum = merge_text(self.partial_accum, text)
                    if accum != self.last_partial:
                        self.partial_accum = accum
                        self.last_partial = accum
                        self.out.append({
                            "mode": "2pass-online",
                            "text": accum,
                            "is_final": False,
                            "wav_name": self.wav_name,
                            "spk_name": "speaker_0",
                        })
            # ---- VAD 流式检测句子边界（只用 start/end 布尔，不用其 value 索引切片）----
            try:
                res = self.vad.generate(
                    input=window,
                    cache=self.vad_cache,
                    is_final=is_final,
                    chunk_size=CHUNK_MS,
                    mode="online" if not is_final else "offline",
                )
            except Exception:
                res = None
            segs = (res[0].get("value") or []) if res else []
            seg_started = False
            seg_ended = False
            for s, e in segs:
                if s != -1 and e == -1:
                    self.seg_open = True
                    self.frames_asr = []
                    self.stream_cache = {}
                    self.stream_buf = np.zeros(0, dtype=np.float32)
                    self.last_partial = ""
                    self.partial_accum = ""
                    seg_started = True
                elif s == -1 and e != -1:
                    seg_ended = True
                elif s != -1 and e != -1:
                    self.seg_open = True
                    self.frames_asr = []
                    self.stream_cache = {}
                    self.stream_buf = np.zeros(0, dtype=np.float32)
                    self.last_partial = ""
                    self.partial_accum = ""
                    seg_started = True
                    seg_ended = True
            # 累积语音段原始音频（注意：start/end 同窗时本窗也要计入）
            if self.seg_open:
                self.frames_asr.append(window)
            # 句子结束 → 用整段累积音频做离线解码
            if seg_ended:
                self.emit_final()
                self.seg_open = False
                self.frames_asr = []
        if is_final and self.seg_open:
            self.emit_final()
            self.seg_open = False
            self.frames_asr = []
        return self.out

    def finish(self) -> list[dict]:
        self.out = []
        if self.seg_open:
            self.emit_final()
            self.seg_open = False
            self.frames_asr = []
        self.out.append({"is_end": True, "wav_name": self.wav_name})
        return self.out


def _local_model_dir(cache: Path, model_id: str) -> str | None:
    """把 iic/xxx 映射到 download_funasr_models.py 下载到的本地快照目录（含 config.yaml 即视为就绪）。"""
    name = model_id.split("/", 1)[-1]
    for base in (
        cache / "models" / f"iic--{name}" / "snapshots" / "master",
        cache / "models" / "iic" / name,
        cache / "iic" / name,
    ):
        if (base / "config.yaml").is_file():
            return str(base)
    return None


def load_models(asr_home: str, device: str, speaker: bool):
    from funasr import AutoModel

    cache = Path(asr_home) / ".modelscope_cache"
    os.environ["MODELSCOPE_CACHE"] = str(cache)
    os.environ["HF_HOME"] = str(Path(asr_home) / ".hf_cache")

    def resolve(model_id: str) -> str:
        local = _local_model_dir(cache, model_id)
        if local is not None:
            print(f"[funasr-asr-server] 使用本地缓存模型：{local}", file=sys.stderr, flush=True)
            return local
        print(f"[funasr-asr-server] 本地无缓存，将从 ModelScope 下载：{model_id}", file=sys.stderr, flush=True)
        return model_id

    # 仅当四个模型全部本地就绪时才强制离线，避免无网络时硬失败；
    # 否则允许在线下载（首次部署）。即便在线，MODELSCOPE_CACHE 也会把它们落到同一缓存目录。
    if all(_local_model_dir(cache, mid) for mid in HUB.values()):
        os.environ["MODELSCOPE_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"

    logging.getLogger("funasr").setLevel(logging.WARNING)
    with contextlib.redirect_stdout(io.StringIO()):
        vad = AutoModel(model=resolve(HUB["vad"]), disable_update=True, device=device)
        asr = AutoModel(model=resolve(HUB["asr"]), disable_update=True, device=device)
        punc = AutoModel(model=resolve(HUB["punc"]), disable_update=True, device=device)
        spk = AutoModel(model=resolve(HUB["spk"]), disable_update=True, device=device) if speaker else None
    return (vad, asr, punc, spk)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--asr-home", default=str(Path(__file__).resolve().parent.parent))
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=10095)
    p.add_argument("--device", default="auto")
    p.add_argument("--speaker", action="store_true")
    return p.parse_args()


async def handler(websocket, models, speaker_enabled):
    session = None
    handshake_done = False
    try:
        async for msg in websocket:
            if isinstance(msg, str):
                if not handshake_done:
                    try:
                        hs = json.loads(msg)
                    except Exception:
                        break
                    wav_name = hs.get("wav_name", "stream")
                    session = Session(
                        models,
                        wav_name,
                        speaker_enabled,
                        hs.get("chunk_size"),
                        hs.get("chunk_interval", 10),
                    )
                    handshake_done = True
                    continue
                try:
                    ctrl = json.loads(msg)
                except Exception:
                    continue
                if ctrl.get("is_end") or ctrl.get("is_speaking") is False:
                    if session is not None:
                        for d in session.finish():
                            await websocket.send(json.dumps(d, ensure_ascii=False))
                    break
            else:  # 二进制 PCM 分片
                if session is None:
                    continue
                for d in await asyncio.to_thread(session.process, msg, False):
                    await websocket.send(json.dumps(d, ensure_ascii=False))
    except Exception:
        pass


def main() -> int:
    args = parse_args()
    device = args.device
    if device == "auto":
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"
    print(f"[funasr-asr-server] loading models from {Path(args.asr_home)/'.modelscope_cache'} (device={device}) ...",
          file=sys.stderr, flush=True)
    models = load_models(args.asr_home, device, args.speaker)
    print(f"[funasr-asr-server] models loaded. speaker={'on' if args.speaker else 'off'}. listening ws://{args.host}:{args.port}",
          file=sys.stderr, flush=True)

    async def serve_fn():
        import websockets

        async with websockets.serve(
            lambda ws: handler(ws, models, args.speaker),
            args.host,
            args.port,
            subprotocols=["binary"],
            ping_interval=None,  # 关闭服务端保活 ping，避免实时推流期间偶发的 keepalive ping timeout 断连
        ):
            await asyncio.Future()  # 常驻

    try:
        asyncio.run(serve_fn())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
