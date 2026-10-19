"""Prepare an isolated MLX environment and public model weights; no customer data is used."""
import os
from pathlib import Path
import platform
import subprocess
import sys

root=Path(__file__).resolve().parent
if platform.machine()!='arm64' or sys.version_info<(3,10):
    raise SystemExit('此本机模型版需要Apple芯片Mac及Python 3.10以上。')
env=root/'.runtime/llm-env'
python=env/'bin/python'
if not python.exists():
    subprocess.run([sys.executable,'-m','venv',str(env)],check=True)
check=subprocess.run([str(python),'-c','import mlx_lm'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if check.returncode:
    print('正在安装本机运行环境……',flush=True)
    subprocess.run([str(python),'-m','pip','install','--disable-pip-version-check','mlx-lm==0.32.2'],check=True)
model=root/'.runtime/model'
if not all((model/name).exists() for name in ('model.safetensors', 'config.json', 'tokenizer.json')):
    print('首次使用下载约2.1GB公开模型文件。客户资料不会上传；下载完成后可离线整理。',flush=True)
    code="from huggingface_hub import snapshot_download; import sys; snapshot_download('mlx-community/Qwen3-4B-Instruct-2507-4bit', local_dir=sys.argv[1], allow_patterns=['*.json','*.safetensors','*.jinja','*.txt','*.md'], max_workers=4)"
    subprocess.run([str(python),'-c',code,str(model)],check=True,env=dict(os.environ,HF_HUB_DISABLE_XET='1'))
print('本机模型已准备。',flush=True)
