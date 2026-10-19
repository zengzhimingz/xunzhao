"""Persistent local inference; protocol is JSON lines on stdio."""
import json
import os
from pathlib import Path
import sys
import mlx.core as mx
from mlx_lm import generate, load
from mlx_lm.sample_utils import make_sampler

try:
    model, tokenizer = load(str(Path(os.environ['CARE_MODEL_PATH'])))
    print(json.dumps({'ready': True}), flush=True)
except Exception:
    print(json.dumps({'error': '本机模型加载失败，请重新启动。'}), flush=True)
    sys.exit(1)
for line in sys.stdin:
    try:
        request = json.loads(line)
        prompt = tokenizer.apply_chat_template(request['messages'], tokenize=False, add_generation_prompt=True)
        answer = generate(model, tokenizer, prompt=prompt, max_tokens=2600,
                          sampler=make_sampler(temp=0), verbose=False)
        print(json.dumps({'text': answer}, ensure_ascii=False), flush=True)
        mx.clear_cache()
    except Exception:
        print(json.dumps({'error': '本机模型未完成分析，请重试。'}, ensure_ascii=False), flush=True)
