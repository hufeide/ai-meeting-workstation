#!/bin/zsh
set -u

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

fail() {
  echo ""
  echo "安装未完成：$1"
  echo "修好后重新双击本文件即可继续；已完成的步骤会跳过。"
  [[ -t 0 ]] && { echo "按回车关闭窗口。"; read -r; }
  exit 1
}

echo "AI 会议工作台安装器"
echo "安装位置：$APP_DIR"
echo "不会自动安装 Homebrew，也不会读取或覆盖现有 .env。"
echo ""

INSTALL_MODE="${MEETING_INSTALL_MODE:-}"
if [[ -z "$INSTALL_MODE" ]]; then
  echo "请选择用途："
  echo "  1. 本地转写 + 工作台（约需数 GB 模型下载）"
  echo "  2. 仅云端转写 + 工作台（不用下载本地模型）"
  printf "输入 1 或 2，回车确认 [1]："
  read -r choice
  [[ "${choice:-1}" == "2" ]] && INSTALL_MODE="cloud" || INSTALL_MODE="local"
fi
[[ "$INSTALL_MODE" == "local" || "$INSTALL_MODE" == "cloud" ]] || fail "安装模式只能是 local 或 cloud。"

NODE_BIN="$(command -v node 2>/dev/null || true)"
NPM_BIN="$(command -v npm 2>/dev/null || true)"
[[ -n "$NODE_BIN" && -n "$NPM_BIN" ]] || fail "找不到 Node.js/npm。请从 https://nodejs.org/ 安装 Node.js 22 或更新版本，再重试。"
NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
[[ "$NODE_MAJOR" == <-> && "$NODE_MAJOR" -ge 22 ]] || fail "当前 Node.js 版本过低。请从 https://nodejs.org/ 安装 22 或更新版本。"
echo "✓ Node.js $($NODE_BIN --version)"

if [[ "$INSTALL_MODE" == "local" ]]; then
  if ! command -v ffmpeg >/dev/null 2>&1; then
    BREW_BIN="$(command -v brew 2>/dev/null || true)"
    [[ -n "$BREW_BIN" ]] || fail "找不到 ffmpeg，也未安装 Homebrew。请先按 https://brew.sh/ 安装 Homebrew，再重试；本安装器不会自动安装 Homebrew。"
    echo "本地转写需要 ffmpeg。可通过 Homebrew 安装，这会修改本机全局环境。"
    printf "是否现在执行 brew install ffmpeg？输入 y 才安装 [N]："
    read -r answer
    [[ "$answer" == "y" || "$answer" == "Y" ]] || fail "你未同意安装 ffmpeg。可自行安装后重试，或选择仅云端模式。"
    "$BREW_BIN" install ffmpeg || fail "ffmpeg 安装失败。请检查 Homebrew 网络/权限；也可手动运行 brew doctor 后重试。"
  fi
  echo "✓ ffmpeg 可用"

  PYTHON_BIN=""
  for candidate in python3.13 python3.12 python3.11; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import venv' >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "$candidate")"
      break
    fi
  done
  [[ -n "$PYTHON_BIN" ]] || fail "找不到可用的 Python 3.11–3.13。请从 https://www.python.org/downloads/macos/ 安装 Python 3.13 后重试。"
  echo "✓ Python $($PYTHON_BIN --version)"

  if [[ ! -x .venv/bin/python ]]; then
    [[ ! -e .venv ]] || fail ".venv 已存在但不可用。请先自行备份/处理这个目录，本安装器不会覆盖它。"
    echo "正在创建项目专用 Python 环境…"
    "$PYTHON_BIN" -m venv .venv || fail "创建 Python 虚拟环境失败，请检查磁盘空间和 Python venv 组件。"
  fi
  .venv/bin/python --version >/dev/null 2>&1 || fail ".venv 内的 Python 已失效，请先自行处理该目录后重试。"

  REQUIREMENTS_FILE="requirements.txt"
  PYTHON_MINOR="$($PYTHON_BIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
  if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" && "$PYTHON_MINOR" == "3.13" && "$MACOS_MAJOR" == <-> && "$MACOS_MAJOR" -ge 14 ]]; then
    REQUIREMENTS_FILE="requirements-macos-arm64-py313.lock.txt"
  else
    echo "提示：当前平台使用固定直接依赖版本；完整依赖锁仅在已实测的 macOS arm64 / Python 3.13 上提供。"
  fi
  REQUIREMENTS_HASH="$(shasum -a 256 "$REQUIREMENTS_FILE" | awk '{print $1}')"
  if [[ ! -f .venv/.requirements-sha256 || "$(<.venv/.requirements-sha256)" != "$REQUIREMENTS_HASH" ]] || ! .venv/bin/python -c 'import funasr, modelscope, torch, torchaudio' >/dev/null 2>&1; then
    echo "正在安装 Python 依赖；首次运行可能需要较长时间…"
    .venv/bin/python -m pip install -r "$REQUIREMENTS_FILE" || fail "Python 依赖安装失败。请检查网络、磁盘空间和 Python 版本。"
    .venv/bin/python -m pip check || fail "Python 依赖版本冲突。请保留报错信息，勿继续下载模型。"
    print -r -- "$REQUIREMENTS_HASH" > .venv/.requirements-sha256
  else
    echo "✓ Python 依赖已安装，跳过"
  fi

  echo "正在检查 5 个本地模型；缺少的模型会从 ModelScope 下载…"
  .venv/bin/python scripts/download_funasr_models.py --app-dir "$APP_DIR" || fail "模型下载失败。请检查 ModelScope 网络与磁盘空间，稍后重新运行可续装。"
fi

LOCK_HASH="$(shasum -a 256 package-lock.json | awk '{print $1}')"
if [[ -d node_modules && -f node_modules/.meeting-package-lock-sha256 && "$(<node_modules/.meeting-package-lock-sha256)" == "$LOCK_HASH" ]] && "$NPM_BIN" ls --depth=0 --silent >/dev/null 2>&1; then
  echo "✓ Node 依赖已安装，跳过"
else
  echo "正在安装 Node 依赖…"
  "$NPM_BIN" ci || fail "npm ci 失败。请检查网络、Node.js 版本及 package-lock.json。"
  print -r -- "$LOCK_HASH" > node_modules/.meeting-package-lock-sha256
fi

echo ""
echo "安装完成。双击『启动会议纪要.command』打开工作台。"
if [[ "$INSTALL_MODE" == "local" ]]; then
  echo "在页面选择『本地 FunASR』可不填任何云端 Key 转写录音。"
else
  echo "云端路线请在页面设置中填自己的火山 ASR Key；要用 AI 参谋还需填自己的 DeepSeek Key。"
fi
echo "若 macOS 拦截 .command，请在 Finder 右键选择『打开』。"
[[ -t 0 ]] && { echo "按回车关闭窗口。"; read -r; }
exit 0
