"""On-device OCR, grounded extraction, and a real local customer-record database."""
import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import queue
import re
import secrets
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit, parse_qs

import store
import handoff
import asr_engine
from record_engine import MODEL, MODEL_NAME, RecordError, make_record, runtime_path

ROOT = Path(__file__).resolve().parent
TOKEN = secrets.token_urlsafe(32)
JOBS = queue.Queue()
PENDING = set()
JOB_LOCK = threading.Lock()
OCR_BINARY = None
MIMES = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
         '.heic': 'image/heic', '.heif': 'image/heif', '.txt': 'text/plain', '.md': 'text/plain', **asr_engine.AUDIO_MIMES}


def file_path(file):
    path = Path(file['path'])
    return path if path.is_absolute() else store.DATA / path


def build_ocr():
    binary = ROOT / '.runtime/ocr'
    binary.parent.mkdir(exist_ok=True)
    if not binary.exists() or binary.stat().st_mtime < (ROOT / 'ocr.swift').stat().st_mtime:
        subprocess.run(['/usr/bin/swiftc', str(ROOT / 'ocr.swift'), '-o', str(binary)], check=True)
    return binary


def add_file(identifier, name, body):
    name = Path(name.replace('\\', '/')).name[:180]
    extension = Path(name).suffix.lower()
    if extension not in MIMES:
        raise ValueError('支持图片、TXT以及WAV、MP3、M4A等通话录音')
    limit = 64 if extension in asr_engine.AUDIO_MIMES else 16
    if not body or len(body) > limit*1024*1024:
        raise ValueError(f'该份资料需小于{limit}MB且不能为空')
    if extension in ('.txt', '.md'):
        try:
            text = body.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise ValueError('文字记录请使用UTF-8编码') from None
        if len(text) > 18000:
            raise ValueError('文字资料过长，请拆分本次咨询')
    digest = hashlib.sha256(body).hexdigest()
    file_id = uuid.uuid4().hex
    directory = store.DATA / 'uploads' / identifier
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (file_id + extension)
    def apply(record):
        if record['status'] in ('processing', 'queued'):
            raise ValueError('正在整理本次资料，请完成后追加')
        if len(record['files']) >= 8:
            raise ValueError('每次咨询最多8份资料')
        if any(file['sha256'] == digest for file in record['files']):
            raise ValueError('这份资料已经在本次记录中，已跳过重复上传')
        if record['mode'] == 'manual':
            record['mode'] = 'ai'
        path.write_bytes(body)
        record['files'].append({'id': file_id, 'name': name, 'path': str(path.relative_to(store.DATA)), 'mime': MIMES[extension],
                                'sha256': digest, 'status': 'uploaded', 'lines': [], 'error': ''})
        if extension in asr_engine.AUDIO_MIMES:
            prior = record.get('channel', 'unspecified')
            record['channel'] = 'phone' if prior in ('unspecified', 'phone') else 'mixed'
        record.update(status='uploading', dirty=True, identityAcknowledged=False, partialAcknowledged=False)
    return store.change(identifier, apply)


def enqueue(identifier):
    with JOB_LOCK:
        if identifier in PENDING:
            return store.read(identifier)
        record = store.read(identifier)
        if not record['files']:
            raise ValueError('请先添加本次咨询的原始材料')
        def apply(row):
            row.update(status='queued', stage='已收到资料，等待本机整理', error='')
        record = store.change(identifier, apply)
        PENDING.add(identifier)
        JOBS.put(identifier)
        return record


def identify(files):
    names, phones = set(), set()
    refs = []
    for index, file in enumerate(files):
        if file.get('excluded'):
            continue
        for line in file['lines']:
            text = line.get('text', '')
            name = re.search(r'(?:客户姓名|姓名|客户代号|客户编号)\s*[:：]\s*([^\s,，;；:：]{1,18})', text)
            phone = re.search(r'(?:客户手机|手机号|联系电话|客户电话)\s*[:：]\s*(1[3-9]\d{9})', text)
            if name:
                names.add(name.group(1))
            if phone:
                phones.add(phone.group(1))
    warning = '材料中出现多个客户姓名或手机号，请核对是否属于同一客户，避免串档。' if len(names) > 1 or len(phones) > 1 else ''
    return next(iter(names)) if len(names) == 1 else '', next(iter(phones)) if len(phones) == 1 else '', warning


def worker():
    while True:
        identifier = JOBS.get()
        try:
            record = store.read(identifier)
            if record['mode'] == 'manual':
                store.change(identifier, lambda r: r.update(status='ready', stage='对照原始材料直接填写，完成后保存。'))
                continue
            store.change(identifier, lambda r: r.update(status='processing', stage='正在读取原始资料'))
            started = time.monotonic()
            asr_seconds = 0
            for index, file in enumerate(record['files']):
                if file.get('excluded'):
                    continue
                if file['status'] == 'done':
                    continue
                audio = file['mime'].startswith('audio/')
                store.change(identifier, lambda r, i=index, audio=audio: r.update(stage=f'正在本机转写第 {i+1} 份录音，完成后自动整理档案' if audio else f'正在识别第 {i+1} / {len(record["files"])} 份资料'))
                try:
                    if audio:
                        asr_started = time.monotonic()
                        audio_result = asr_engine.transcribe(file_path(file))
                        asr_seconds += time.monotonic() - asr_started
                        lines = audio_result['lines']
                        file.update(duration=audio_result['duration'], asrEngine=audio_result['engine'], speakerDiarization=False)
                    elif file['mime'] == 'text/plain':
                        lines = [{'text': text, 'roleHint': 'unknown'} for text in file_path(file).read_text(encoding='utf-8-sig').splitlines() if text.strip()]
                    else:
                        result = subprocess.run([str(OCR_BINARY), str(file_path(file))], capture_output=True, timeout=90)
                        if result.returncode:
                            raise ValueError('图片无法识别，请重新拍摄清晰图片')
                        lines = json.loads(result.stdout).get('lines', [])
                    if not any(line.get('text', '').strip() for line in lines):
                        raise ValueError('未识别到文字，请检查原图')
                    file.update(lines=lines, status='done', error='')
                except (ValueError, OSError, subprocess.TimeoutExpired):
                    import sys
                    reason = sys.exc_info()[1]
                    file.update(status='error', error=str(reason) if audio and isinstance(reason, ValueError) else '这份资料没有识别成功，可重试或暂不纳入。')
                def save_file(r, index=index, file=file):
                    r['files'][index] = file
                store.change(identifier, save_file)
            ocr_seconds = max(0, time.monotonic() - started - asr_seconds)
            if asr_seconds:
                store.change(identifier, lambda row: row['timing'].update(asr=round(row['timing'].get('asr', 0)+asr_seconds, 2)))
            if not any(file['status'] == 'done' and not file.get('excluded') for file in record['files']):
                raise RecordError('没有识别到可用文字。原图已保存，可重新上传清晰照片，或直接填写本次记录。')
            store.change(identifier, lambda r: r.update(stage='正在把多份资料填入同一张客户记录'))
            documents = []
            for file in record['files']:
                lines = file['lines'] if file['status'] == 'done' and not file.get('excluded') else []
                chat = sum(bool(re.search(r'已读|服务评价|分钟前在线', line.get('text', ''))) for line in lines) >= 2 or sum(line.get('roleHint') == 'client_color_hint' for line in lines) >= 2
                documents.append({'name': file['name'], 'kind': 'phone' if file['mime'].startswith('audio/') else 'chat' if chat else 'form', 'lines': lines})
            result = make_record(documents)
            name, phone, warning = identify(record['files'])
            def complete(row):
                row['aiApplied'] = []
                for section in result['sections']:
                    field = row['fields'][section['id']]
                    if field['modified']:
                        continue
                    missing = section['status'] == 'missing'
                    field.update(text='' if missing else section['text'], status=section['status'], refs=section['refs'])
                    if not missing and section['text']:
                        row['aiApplied'].append(section['id'])
                for key, value in [('name', name), ('phone', phone)]:
                    if value and not row['fields'][key]['modified']:
                        row['fields'][key].update(text=value, status='supported')
                        row['aiApplied'].append(key)
                if not row['fields']['notes']['modified']:
                    supplement = result.get('supplement', {})
                    row['fields']['notes'].update(text=supplement.get('text', ''), refs=supplement.get('refs', []), status='supported' if supplement.get('text') else 'empty')
                    if supplement.get('text'):
                        row['aiApplied'].append('notes')
                row.update(status='ready', stage='资料已填入，核对后直接保存', sources=result['sources'],
                           issues=result['issues'], identityWarning=warning, dirty=True, error='')
                row['timing']['ocr'] += round(ocr_seconds, 2)
                row['timing']['model'] += result['durationSeconds']
            store.change(identifier, complete)
        except Exception as error:
            message = str(error) if isinstance(error, (RecordError, ValueError)) else '本次自动整理未完成，原始资料与人工填写已保留，可重试或继续手动填写。'
            store.change(identifier, lambda row: row.update(status='error', stage='自动整理未完成', error=message))
        finally:
            with JOB_LOCK:
                PENDING.discard(identifier)
            JOBS.task_done()


def public_record(record, detailed=True):
    result = store.public(record, detailed)
    visits = [v for v in handoff.all_visits() if v['recordId'] == record['id']]
    visits.sort(key=lambda v: v['arrivedAt'], reverse=True)
    result['visits'] = [{k: v[k] for k in ('id','status','doctorName','arrivedAt','startedAt','completedAt')} for v in visits]
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_data(self, status, body, mime='application/json; charset=utf-8'):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        for key, value in {'Content-Type': mime, 'Content-Length': str(len(body)), 'Cache-Control': 'no-store',
                           'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'}.items():
            self.send_header(key, value)
        self.end_headers()
        try:
            if self.command != 'HEAD':
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def valid_host(self):
        return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

    def role(self):
        value = self.headers.get('X-Demo-Role', 'consultant')
        if value not in ('consultant', 'frontdesk', 'doctor'):
            raise ValueError('岗位视图不存在')
        return value

    def doctor_id(self):
        value = self.headers.get('X-Demo-Doctor', 'doctor-a')
        if value not in handoff.DOCTORS:
            raise ValueError('医生视图不存在')
        return value

    def send_file(self, path, mime):
        total = path.stat().st_size
        start, end, status = 0, total-1, 200
        requested = self.headers.get('Range')
        if requested:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
            if not match or not any(match.groups()):
                return self.send_data(416, {'error': '文件范围不正确'})
            left, right = match.groups()
            if left:
                start = int(left); end = min(total-1, int(right)) if right else total-1
            else:
                start = max(0, total-int(right))
            if start > end or start >= total:
                self.send_response(416); self.send_header('Content-Range', f'bytes */{total}'); self.end_headers(); return
            status = 206
        self.send_response(status)
        for key, value in {'Content-Type':mime,'Content-Length':str(end-start+1),'Accept-Ranges':'bytes',
                           'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}.items():
            self.send_header(key, value)
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{total}')
        self.end_headers()
        if self.command == 'HEAD': return
        try:
            with path.open('rb') as source:
                source.seek(start); remaining=end-start+1
                while remaining:
                    chunk=source.read(min(65536, remaining))
                    if not chunk:break
                    self.wfile.write(chunk);remaining-=len(chunk)
        except (BrokenPipeError, ConnectionResetError):pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.valid_host():
            return self.send_data(403, {'error': '仅限本机访问'})
        try:self.role();self.doctor_id()
        except ValueError as error:return self.send_data(422, {'error':str(error)})
        path = unquote(urlsplit(self.path).path)
        if path == '/api/status':
            return self.send_data(200, {'version': 7, 'application': 'xunzhao', 'token': TOKEN, 'model': MODEL_NAME,
                'installed': (runtime_path() / 'model/model.safetensors').exists(), 'modelState': MODEL.state, 'asrReady': asr_engine.ready(), 'doctors': handoff.DOCTORS, 'sharingMode': 'local-role-demo'})
        if path == '/api/arrival/lookup':
            try:
                if self.role() != 'frontdesk': return self.send_data(403, {'error':'请从前台视图查找到店客户'})
                query = parse_qs(urlsplit(self.path).query).get('q', [''])[0]
                return self.send_data(200, {'matches': handoff.lookup(query)})
            except ValueError as error:return self.send_data(422, {'error':str(error)})
        if path == '/api/visits':
            try:
                return self.send_data(200, {'visits':handoff.listing(self.doctor_id() if self.role()=='doctor' else None)})
            except ValueError as error:return self.send_data(422, {'error':str(error)})
        visit_match = re.fullmatch(r'/api/visits/([a-f0-9]{32})', path)
        if visit_match:
            try:
                if self.role() != 'doctor':return self.send_data(403, {'error':'接诊详情请从医生视图查看'})
                return self.send_data(200, handoff.detail(visit_match[1], self.doctor_id()))
            except KeyError:return self.send_data(404, {'error':'接诊记录不存在'})
            except ValueError as error:return self.send_data(422, {'error':str(error)})
        if path == '/api/records':
            if self.role() != 'consultant':return self.send_data(403, {'error':'请从咨询师视图查看和编辑咨询档案'})
            return self.send_data(200, {'records': [public_record(row, False) for row in store.list_records()]})
        match = re.fullmatch(r'/api/records/([a-f0-9]{32})', path)
        if match:
            try:
                if self.role() != 'consultant':return self.send_data(403, {'error':'请从咨询师视图编辑档案，医生可通过交接单查看'})
                return self.send_data(200, {'record': public_record(store.read(match[1]))})
            except KeyError:
                return self.send_data(404, {'error': '客户记录不存在'})
        match = re.fullmatch(r'/api/files/([a-f0-9]{32})', path)
        if match:
            for row in store.list_records():
                file = next((f for f in row['files'] if f['id'] == match[1]), None)
                if file:
                    try:
                        path = file_path(file)
                        mime = file['mime']
                        if mime in ('image/heic', 'image/heif'):
                            preview = path.with_suffix('.preview.jpg')
                            if not preview.exists():
                                subprocess.run(['/usr/bin/sips', '-s', 'format', 'jpeg', str(path), '--out', str(preview)], capture_output=True, timeout=30, check=True)
                            path, mime = preview, 'image/jpeg'
                        if file['mime'].startswith('audio/') and parse_qs(urlsplit(self.path).query).get('playback') == ['1']:
                            preview=path.with_suffix('.preview.wav')
                            if preview.exists():path,mime=preview,'audio/wav'
                        return self.send_file(path, mime)
                    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
                        break
            return self.send_data(404, {'error': '原始文件不存在'})
        allowed = {'/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/handoff-ui.js': 'handoff-ui.js'}
        if path in allowed:
            file = ROOT / allowed[path]
            mime = 'text/html; charset=utf-8' if file.suffix == '.html' else 'text/css; charset=utf-8' if file.suffix == '.css' else 'application/javascript; charset=utf-8'
            return self.send_data(200, file.read_bytes(), mime)
        return self.send_data(404, {'error': '页面不存在'})

    def do_POST(self):
        origin = self.headers.get('Origin')
        origins = (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}')
        if not self.valid_host() or origin not in origins or self.headers.get('X-Local-Token') != TOKEN:
            return self.send_data(403, {'error': '请从本机页面操作'})
        path = urlsplit(self.path).path
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 64*1024*1024:
                return self.send_data(413, {'error': '文件为空或超过64MB；图片限16MB，录音限64MB'})
            body = self.rfile.read(length)
            match = re.fullmatch(r'/api/records/([a-f0-9]{32})/files', path)
            if match:
                if self.role() != 'consultant':return self.send_data(403, {'error':'请由咨询师导入资料'})
                record = add_file(match[1], unquote(self.headers.get('X-File-Name', '资料.png')), body)
                return self.send_data(200, {'record': public_record(record)})
            if length > 200000:
                return self.send_data(413, {'error': '记录内容过长'})
            data = json.loads(body)
            if not isinstance(data, dict):
                raise ValueError('请求格式不正确')
            if path == '/api/visits/checkin':
                if self.role() != 'frontdesk':return self.send_data(403, {'error':'请从前台视图确认到店'})
                visit = handoff.checkin(str(data.get('recordId','')), data.get('doctorId'), data.get('identityConfirmed'), data.get('operation'))
                return self.send_data(200, {'visit':visit})
            visit_match = re.fullmatch(r'/api/visits/([a-f0-9]{32})/(start|note|complete|cancel)', path)
            if visit_match:
                identifier, action = visit_match.groups()
                visit = handoff.update(identifier, action, self.role(), self.doctor_id(), data.get('revision'), data.get('note'))
                return self.send_data(200, {'visit':visit})
            if self.role() != 'consultant':return self.send_data(403, {'error':'请由咨询师编辑咨询资料；医生记录单独保存在接诊单中'})
            if path == '/api/records':
                mode = 'manual' if data.get('mode') == 'manual' else 'ai'
                record = store.create(mode=mode)
                return self.send_data(200, {'record': public_record(record)})
            match = re.fullmatch(r'/api/records/([a-f0-9]{32})/(process|fields|save|toggle-file|channel)', path)
            if not match:
                return self.send_data(404, {'error': '接口不存在'})
            identifier, action = match.groups()
            if action == 'channel':
                channel=data.get('channel')
                if channel not in ('unspecified','online','phone','offline','mixed'):raise ValueError('咨询渠道不存在')
                def set_channel(row):
                    if row['status'] in ('processing','queued','uploading'):raise ValueError('请等待资料整理完成后修改渠道')
                    if row.get('channel','unspecified') != channel:row.update(channel=channel,dirty=True)
                record=store.change(identifier, set_channel)
            elif action == 'toggle-file':
                def toggle(record):
                    if record['status'] in ('processing', 'queued', 'uploading'):
                        raise ValueError('正在整理资料，请完成后调整')
                    file = next((file for file in record['files'] if file['id'] == data.get('fileId')), None)
                    if not file:
                        raise ValueError('资料不存在')
                    file['excluded'] = not file.get('excluded', False)
                    record.update(dirty=True, identityAcknowledged=False, partialAcknowledged=False)
                    # An excluded source must never leave an apparently current AI field.
                    for key, field in record['fields'].items():
                        if not field['modified']:
                            field.update(text='', status='empty', refs=[])
                    record.update(sources={}, issues=[], aiApplied=[], error='', identityWarning='')
                record = store.change(identifier, toggle)
                if any(not f.get('excluded') for f in record['files']):
                    record = enqueue(identifier)
                else:
                    record = store.change(identifier, lambda row: row.update(status='ready', stage='本次材料已全部移出，人工填写保留。'))
            elif action == 'process':
                record = enqueue(identifier)
            elif action == 'fields':
                def apply(record):
                    store.update_fields(record, data.get('fields', {}))
                record = store.change(identifier, apply)
            else:
                operation = data.get('operation')
                if not isinstance(operation, str) or not 8 <= len(operation) <= 80:
                    raise ValueError('保存请求缺少标识，请重试')
                record = store.save(identifier, data.get('fields', {}), data.get('revision'), operation, data.get('acknowledgements', {}))
            self.send_data(200, {'record': public_record(record)})
        except handoff.Conflict as error:
            self.send_data(409, {'error':str(error)})
        except KeyError:
            self.send_data(404, {'error': '客户记录不存在'})
        except (ValueError, TypeError):
            import sys
            error = sys.exc_info()[1]
            self.send_data(422, {'error': str(error) if isinstance(error, ValueError) else '请求格式不正确'})
        except Exception:
            self.send_data(500, {'error': '操作没有完成，已有记录仍保留，请重试。'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8770)
    args = parser.parse_args()
    store.initialize()
    handoff.initialize()
    OCR_BINARY = build_ocr()
    threading.Thread(target=worker, daemon=True).start()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'循照 · 客户档案 AI 录入：http://127.0.0.1:{args.port}/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        MODEL.stop()
        server.server_close()
