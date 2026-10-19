"""Install a separate ASR runtime and public multilingual model, without customer data."""
from pathlib import Path
import os
import subprocess
import sys

root = Path(__file__).resolve().parent
runtime = root / '.runtime'
python = runtime / 'asr-env/bin/python'
if not python.exists():
    if sys.version_info < (3, 10):
        raise SystemExit('需要Python 3.10以上。可使用本机模型环境中的Python执行本文件。')
    subprocess.run([sys.executable, '-m', 'venv', str(runtime / 'asr-env')], check=True)
check = subprocess.run([str(python), '-c', 'import faster_whisper'], capture_output=True)
if check.returncode:
    subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', 'faster-whisper==1.2.1'], check=True)
if not all((runtime / 'asr-model' / name).exists() for name in ('model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt')):
    print('首次下载约0.5GB公开多语言语音模型，录音不会上传。', flush=True)
    script = "from huggingface_hub import snapshot_download;import sys;snapshot_download('Systran/faster-whisper-small',local_dir=sys.argv[1],allow_patterns=['config.json','model.bin','tokenizer.json','vocabulary.txt','preprocessor_config.json'],max_workers=3)"
    subprocess.run([str(python), '-c', script, str(runtime / 'asr-model')], check=True,
                   env=dict(os.environ, HF_HUB_DISABLE_XET='1'))
print('本机语音转写已准备，之后可离线使用。')
