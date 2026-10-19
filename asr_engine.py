"""Local ASR launcher; model files are downloaded only by the explicit setup script."""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
AUDIO_MIMES = {'.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
               '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.amr': 'audio/amr'}


def ready():
    return (ROOT / '.runtime/asr-env/bin/python').exists() and (ROOT / '.runtime/asr-model/model.bin').exists()


def transcribe(path):
    if not ready():
        raise ValueError('本机语音模型尚未准备，请运行“准备本机语音.py”')
    try:
        result = subprocess.run([str(ROOT / '.runtime/asr-env/bin/python'), str(ROOT / 'asr_worker.py'), str(path)],
            capture_output=True, timeout=900, text=True,
            env=dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false'))
        output = json.loads(result.stdout)
        if result.returncode or output.get('error'):
            raise ValueError(output.get('error') or '本次录音转写未完成，请重试')
        return output
    except subprocess.TimeoutExpired:
        raise ValueError('本机录音转写超时，原文件保留，请拆分为更短录音后重试') from None
    except (OSError, json.JSONDecodeError):
        raise ValueError('本机转写服务未完成，原文件已保留，请重试') from None
