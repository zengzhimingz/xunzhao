"""Local durable drafts and customer records. No browser storage is required."""
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('RECORD_DATA_DIR', str(ROOT / '.data')))
LOCK = threading.RLock()
FIELD_LABELS = {'name': '客户姓名 / 代号', 'phone': '联系电话', 'need': '客户诉求',
                'history': '客户自述的既往情况', 'progress': '本次沟通进展',
                'pricing': '项目与费用说明', 'appointment': '到店与预约', 'notes': '补充备注'}


def connect():
    DATA.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(DATA / 'records.sqlite3'), timeout=20)
    db.execute('PRAGMA journal_mode=WAL')
    return db


def initialize():
    with LOCK, connect() as db:
        db.execute('CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
        for identifier, body in db.execute('SELECT id,body FROM records').fetchall():
            record = json.loads(body)
            if record['status'] in ('processing', 'queued', 'uploading'):
                record.update(status='error', stage='上次处理已中断，原始资料已保留，可继续整理。')
                db.execute('UPDATE records SET body=? WHERE id=?', (json.dumps(record, ensure_ascii=False), identifier))


def read(identifier):
    with LOCK, connect() as db:
        row = db.execute('SELECT body FROM records WHERE id=?', (identifier,)).fetchone()
        if not row:
            raise KeyError('客户记录不存在')
        return json.loads(row[0])


def change(identifier, update):
    with LOCK, connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT body FROM records WHERE id=?', (identifier,)).fetchone()
        if not row:
            raise KeyError('客户记录不存在')
        record = json.loads(row[0])
        update(record)
        record['updatedAt'] = time.time()
        db.execute('UPDATE records SET body=? WHERE id=?', (json.dumps(record, ensure_ascii=False), identifier))
        return record


def create(mode='ai'):
    now = time.time()
    record = {'id': uuid.uuid4().hex, 'createdAt': now, 'updatedAt': now, 'startedAt': now,
              'firstSavedAt': None, 'savedAt': None, 'savedRevision': 0, 'lastOperation': '',
              'channel': 'unspecified', 'status': 'empty', 'stage': '等待添加资料', 'mode': mode,
              'fields': {key: {'text': '', 'status': 'empty', 'refs': [], 'modified': False} for key in FIELD_LABELS},
              'files': [], 'sources': {}, 'issues': [], 'timing': {'ocr': 0, 'asr': 0, 'model': 0},
              'edits': 0, 'aiApplied': [], 'identityWarning': '', 'identityAcknowledged': False,
              'partialAcknowledged': False, 'error': '', 'dirty': True}
    with LOCK, connect() as db:
        db.execute('INSERT INTO records VALUES (?,?)', (record['id'], json.dumps(record, ensure_ascii=False)))
    return record


def list_records():
    with LOCK, connect() as db:
        rows = [json.loads(row[0]) for row in db.execute('SELECT body FROM records')]
    return sorted(rows, key=lambda row: row['updatedAt'], reverse=True)


def public(record, detailed=True):
    record = json.loads(json.dumps(record))
    record.setdefault('channel','unspecified')
    record.pop('savedSnapshot', None)
    for file in record['files']:
        file.pop('path', None)
        file['url'] = '/api/files/' + file['id']
        if file['mime'].startswith('audio/'):
            file['playbackUrl'] = file['url']+'?playback=1&state='+file['status']
    if not detailed:
        record.pop('sources', None)
        for file in record['files']:
            file.pop('lines', None)
    return record


def update_fields(record, values):
    if not isinstance(values, dict) or any(key not in FIELD_LABELS for key in values):
        raise ValueError('记录字段格式不正确')
    for key, value in values.items():
        if not isinstance(value, str) or len(value) > (120 if key in ('name', 'phone') else 2500):
            raise ValueError('记录内容过长，请精简后保存')
        field = record['fields'][key]
        if field['text'] != value:
            field.update(text=value, modified=True, refs=[], status='manual' if value.strip() else 'empty')
            record['edits'] += 1
            record['dirty'] = True


def save(identifier, values, revision, operation, acknowledgements):
    def apply(record):
        if record['lastOperation'] == operation:
            return
        if record['status'] in ('processing', 'queued', 'uploading'):
            raise ValueError('资料正在整理，请完成后保存')
        if record['savedRevision'] != revision:
            raise ValueError('这份记录已在其他页面保存，请刷新后核对，当前内容可先留在页面中。')
        update_fields(record, values)
        if not any(record['fields'][key]['text'].strip() for key in ('need', 'progress', 'history', 'pricing', 'notes')):
            raise ValueError('这份记录还没有咨询内容，请添加资料或填写实际记录。')
        if record['identityWarning'] and not acknowledgements.get('identity'):
            raise ValueError('材料中出现不同的客户标识，请先核对资料归属。')
        if any(f['status'] == 'error' and not f.get('excluded') for f in record['files']) and not acknowledgements.get('partial'):
            raise ValueError('部分资料没有识别成功，请重试，或确认暂不纳入本次记录。')
        now = time.time()
        record.update(status='saved', savedAt=now, savedRevision=revision+1, lastOperation=operation,
                      firstSavedAt=record['firstSavedAt'] or now, dirty=False, error='',
                      identityAcknowledged=bool(acknowledgements.get('identity')),
                      partialAcknowledged=bool(acknowledgements.get('partial')), stage='已保存到本机客户档案')
        record['savedSnapshot'] = json.loads(json.dumps({key:value for key,value in record.items() if key != 'savedSnapshot'}))
    return change(identifier, apply)
