#!/bin/zsh
set -u

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
NPM_BIN="$(command -v npm 2>/dev/null || true)"

echo "正在启动 AI 会议工作台..."
echo "工作目录：$APP_DIR"
if [[ -z "$NPM_BIN" || ! -x "$NPM_BIN" ]]; then
  echo "在 PATH 中找不到 npm。请先确认 Node.js / npm 已安装。"
  echo "按回车关闭窗口。"
  read -r
  exit 1
fi
mkdir -p .local-data

check_port() {
  local port="$1"
  local pid
  pid="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    echo ""
    echo "端口 $port 已被占用，当前进程：$pid"
    echo "请先关闭占用该端口的本地服务，再重新双击启动。"
    echo "按回车关闭窗口。"
    read -r
    exit 1
  fi
}

check_port 8787
check_port 5173

if [[ ! -d node_modules ]]; then
  echo "首次启动需要安装本地依赖，正在执行 npm install..."
  "$NPM_BIN" install
  if [[ "$?" != "0" ]]; then
    echo "依赖安装失败，请检查网络或 Node.js 环境。"
    echo "按回车关闭窗口。"
    read -r
    exit 1
  fi
fi

SERVER_LOG="$APP_DIR/.local-data/launcher-server.log"
CLIENT_LOG="$APP_DIR/.local-data/launcher-client.log"

echo "正在启动后端服务..."
"$NPM_BIN" run dev:server >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

echo "正在启动前端面板..."
"$NPM_BIN" run dev:client >"$CLIENT_LOG" 2>&1 &
CLIENT_PID="$!"

cleanup() {
  kill "$SERVER_PID" "$CLIENT_PID" 2>/dev/null || true
}
trap cleanup INT TERM

wait_for_port() {
  local port="$1"
  local label="$2"
  local log_file="$3"
  local i
  for i in {1..40}; do
    if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$label 已启动：http://127.0.0.1:$port"
      return 0
    fi
    sleep 0.5
  done
  echo ""
  echo "$label 启动失败，端口 $port 没有监听。"
  echo "最近日志："
  tail -n 30 "$log_file" 2>/dev/null || true
  echo "按回车关闭窗口。"
  read -r
  cleanup
  exit 1
}

wait_for_port 8787 "后端服务" "$SERVER_LOG"
wait_for_port 5173 "前端面板" "$CLIENT_LOG"

echo "浏览器会自动打开会议纪要面板。"
open "http://127.0.0.1:5173"
echo ""
echo "服务运行中。关闭此窗口或按 Ctrl-C 会停止本地服务。"
echo "日志："
echo "  后端：$SERVER_LOG"
echo "  前端：$CLIENT_LOG"
wait "$SERVER_PID" "$CLIENT_PID"
