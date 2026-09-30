#!/usr/bin/env bash
# FunASR 实时 ASR 服务端部署脚本（纯 Python，加载本地 pytorch 四模型，无需 Docker）。
#
# 四模型（均在 <项目根>/.modelscope_cache 下）：
#   VAD   : iic/speech_fsmn_vad_zh-cn-16k-common-pytorch
#   ASR   : iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch
#   PUNC  : iic/punc_ct-transformer_cn-en-common-vocab471067-large
#   SPK   : iic/speech_campplus_sv_zh-cn_16k-common
#
# 对外提供与官方 FunASR runtime 完全相同的 WebSocket 2pass 协议（ws://0.0.0.0:10095），
# 因此 scripts/realtime_funasr.py 与 Node 侧 funasrRealtimeAsr.ts 无需改动。
#
# 用法：
#   ./deploy_funasr_server.sh start   [--speaker] [--device cuda] [--port 10095]
#   ./deploy_funasr_server.sh stop
#   ./deploy_funasr_server.sh restart [--speaker] [--device cuda]
#   ./deploy_funasr_server.sh status
#   ./deploy_funasr_server.sh logs
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PY="$ROOT_DIR/scripts/funasr_asr_server.py"
PID_FILE="$ROOT_DIR/.funasr_asr_server.pid"
LOG_FILE="$ROOT_DIR/.funasr_asr_server.log"

# Python 解释器：优先用项目内 FUNASR_PYTHON_PATH / .venv，因为系统 python3 可能装了损坏的 funasr。
PYTHON_BIN="${FUNASR_PYTHON_PATH:-}"
if [ -z "$PYTHON_BIN" ] && [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
fi
if [ -z "$PYTHON_BIN" ]; then
  PYTHON_BIN="python3"
fi

# 默认开启说话人分离（与 Node 侧 speakerDiarization=true 对应）。
SPEAKER_FLAG="--speaker"
DEVICE="auto"
PORT=10095

# 解析额外参数
EXTRA=()
for arg in "$@"; do
  case "$arg" in
    --speaker) SPEAKER_FLAG="--speaker" ;;
    --no-speaker) SPEAKER_FLAG="" ;;
    --device) : ;;  # 占位，值在下一个参数
    --port) : ;;
    *)
      # 捕获 --device xxx / --port xxx 的配对值
      if [ "${PREV:-}" = "device" ]; then DEVICE="$arg"; PREV="";
      elif [ "${PREV:-}" = "port" ]; then PORT="$arg"; PREV="";
      else EXTRA+=("$arg"); fi
      ;;
  esac
  if [ "$arg" = "--device" ]; then PREV="device"; fi
  if [ "$arg" = "--port" ]; then PREV="port"; fi
done

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start() {
  if is_running; then
    echo "FunASR 服务已在运行（PID=$(cat "$PID_FILE")）。"
    return 0
  fi
  echo "启动 FunASR 服务（python=$PYTHON_BIN, device=$DEVICE, speaker=${SPEAKER_FLAG:-off}, port=$PORT）..."
  nohup "$PYTHON_BIN" "$SERVER_PY" \
    --asr-home "$ROOT_DIR" \
    --host 0.0.0.0 \
    --port "$PORT" \
    --device "$DEVICE" \
    $SPEAKER_FLAG \
    >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 2
  if is_running; then
    echo "已启动，PID=$(cat "$PID_FILE")。日志：tail -f $LOG_FILE"
  else
    echo "启动失败，请查看日志：$LOG_FILE" >&2
    return 1
  fi
}

stop() {
  if is_running; then
    echo "停止 FunASR 服务（PID=$(cat "$PID_FILE")）..."
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  else
    echo "FunASR 服务未运行。"
  fi
}

case "${1:-start}" in
  start) shift; start "$@" ;;
  stop) stop ;;
  restart) stop; sleep 1; start "$@" ;;
  status)
    if is_running; then echo "运行中（PID=$(cat "$PID_FILE")）"; else echo "未运行"; fi ;;
  logs) tail -f "$LOG_FILE" ;;
  *) echo "用法：$0 {start|stop|restart|status|logs} [--speaker] [--device cuda] [--port 10095]"; exit 1 ;;
esac
