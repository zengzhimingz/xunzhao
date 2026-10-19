#!/bin/zsh
set -e
cd -- "${0:A:h}"

asr_setup_python=''
for candidate in .runtime/llm-env/bin/python python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; assert sys.version_info >= (3,10)' >/dev/null 2>&1; then
    asr_setup_python="$candidate"
    break
  fi
done
if [[ -z "$asr_setup_python" ]]; then
  print -u2 '需要 Python 3.10 或以上。请安装后重试。'
  if [[ -t 0 ]]; then read 'reply?按回车关闭'; fi
  exit 1
fi
asr_status=0
"$asr_setup_python" 准备本机语音.py || asr_status=$?
if [[ -t 0 ]]; then read 'reply?准备结束，按回车关闭'; fi
exit "$asr_status"
