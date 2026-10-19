"""Offline audio decoding and ASR. Invoked with the isolated ASR Python runtime."""
import json
import os
from pathlib import Path
import sys
import wave

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'


def run(path):
    import av
    import numpy as np
    from faster_whisper import WhisperModel
    chunks, samples = [], 0
    with av.open(str(path)) as container:
        if not container.streams.audio:
            raise ValueError('录音中没有可识别的音轨')
        stream = container.streams.audio[0]
        if stream.duration and stream.time_base and float(stream.duration * stream.time_base) > 1200:
            raise ValueError('本机演示每份录音最多20分钟，请拆分后上传')
        resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
        for frame in container.decode(stream):
            for converted in resampler.resample(frame):
                part = converted.to_ndarray().reshape(-1)
                samples += len(part)
                if samples > 16000 * 1200:
                    raise ValueError('本机演示每份录音最多20分钟，请拆分后上传')
                chunks.append(part)
        for converted in resampler.resample(None):
            chunks.append(converted.to_ndarray().reshape(-1))
    if not chunks:
        raise ValueError('录音为空，请检查文件')
    pcm = np.concatenate(chunks)
    duration = len(pcm) / 16000
    if duration < .5 or float(np.max(np.abs(pcm.astype(np.float32)))) < 20:
        raise ValueError('录音中没有清晰语音，请检查原文件')
    preview = path.with_suffix('.preview.wav')
    with wave.open(str(preview), 'wb') as output:
        output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000)
        output.writeframes(pcm.astype('<i2').tobytes())
    model_dir = Path(__file__).resolve().parent / '.runtime/asr-model'
    if not (model_dir / 'model.bin').exists():
        raise ValueError('本机语音模型未准备，请运行“准备本机语音.py”')
    model = WhisperModel(str(model_dir), device='cpu', compute_type='int8', cpu_threads=4,
                         local_files_only=True, num_workers=1)
    segments, info = model.transcribe(pcm.astype(np.float32) / 32768, language='zh', beam_size=5,
        vad_filter=True, vad_parameters={'min_silence_duration_ms': 400}, temperature=0,
        condition_on_previous_text=False, initial_prompt='以下是普通话客户咨询通话，请用简体中文如实转写。')
    rows = []
    for segment in segments:
        text = segment.text.strip()
        if text and not (segment.no_speech_prob > .8 and segment.avg_logprob < -1):
            rows.append({'text': text, 'start': round(segment.start, 2),
                         'end': round(min(duration, segment.end), 2), 'roleHint': 'unknown',
                         'sourceType': 'audio'})
    if not rows:
        raise ValueError('没有识别到清晰语音，原录音已保留，可更换清晰录音重试')
    return {'lines': rows, 'duration': round(duration, 2), 'language': info.language,
            'engine': 'Faster Whisper small · 本机转写', 'speakerDiarization': False}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('缺少录音文件')
        print(json.dumps(run(Path(sys.argv[1])), ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) else '录音解码或转写未完成，请检查格式和清晰度后重试'}, ensure_ascii=False), flush=True)
        sys.exit(1)
