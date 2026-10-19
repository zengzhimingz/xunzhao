#!/bin/zsh
set -e
cd -- "${0:A:h}"

fail() {
  print -u2 -- "$1"
  if [[ -t 0 ]]; then
    read 'reply?按回车关闭'
  fi
  exit 1
}

[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail '本机模型版需要 Apple 芯片（M 系列）Mac。'
/usr/bin/xcrun --find swiftc >/dev/null 2>&1 || fail '需要 Apple 命令行工具。请先在终端运行 xcode-select --install，完成后重新启动。'

product_python=''
for candidate in .runtime/llm-env/bin/python python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys, platform; assert sys.version_info >= (3,10) and platform.machine() == "arm64"' >/dev/null 2>&1; then
    product_python="$(command -v "$candidate")"
    break
  fi
done
[[ -n "$product_python" ]] || fail '需要原生 Apple 芯片版本的 Python 3.10 或以上。请从 python.org 安装后重新启动。'

print '正在检查本机运行环境；首次准备会联网下载依赖和约 2.6GB 模型，客户资料不会上传。'
"$product_python" 首次准备.py || fail '语言模型准备失败，请检查网络后重试。'
"$product_python" 准备本机语音.py || fail '语音模型准备失败，请检查网络后重试。'
"$product_python" 启动.py || fail '启动没有完成，请检查上方提示。'
