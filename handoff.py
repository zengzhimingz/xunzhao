"""Shared visit workflow for the local role-view prototype; not account authentication."""
import json
import re
import sqlite3
import time
import uuid

import store

DOCTORS = {'doctor-a': '演示医生 A', 'doctor-b': '演示医生 B'}
ACTIVE_STATES = ('waiting', 'in_consultation')


class Conflict(ValueError):
    pass


def initialize():
    with store.LOCK, store.connect() as db:
        db.execute('CREATE TABLE IF NOT EXISTS visits (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL)')
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_visit ON visits(record_id) WHERE state IN ('waiting','in_consultation')")


def phone(value):
    value = re.sub(r'\D', '', str(value))
    return value[2:] if len(value) == 13 and value.startswith('86') else value


def record_summary(record):
    shared = (record.get('savedSnapshot') or record) if record['dirty'] and record['savedRevision'] else record
    fields = shared['fields']
    return {'id': record['id'], 'code': record['id'][:8].upper(),
            'name': fields['name']['text'].strip() or '未提供姓名',
            'phone': fields['phone']['text'], 'need': fields['need']['text'],
            'channel': shared.get('channel', 'unspecified'), 'updatedAt': record['updatedAt'],
            'ready': record['status'] == 'saved' and not record['dirty'],
            'savedRevision': record['savedRevision']}


def all_visits():
    with store.LOCK, store.connect() as db:
        return [json.loads(row[0]) for row in db.execute('SELECT body FROM visits')]


def lookup(query):
    query = str(query).strip()
    if not 2 <= len(query) <= 120:
        raise ValueError('请填写至少2个字的姓名、完整手机号、4位手机尾号或6/8位咨询编号')
    raw_phone = phone(query)
    numeric = bool(re.fullmatch(r'[+\d\s()-]+', query))
    code_query = len(query) in (6, 8, 32) and bool(re.fullmatch(r'[a-fA-F0-9]+', query))
    if numeric and len(raw_phone) not in (4, 11) and not code_query:
        raise ValueError('手机号请填写完整11位，或4位尾号后再人工核对')
    visits = all_visits()
    matches = []
    for record in store.list_records():
        summary = record_summary(record)
        full_phone = phone(summary['phone'])
        if numeric and len(raw_phone) == 11:
            matched = full_phone == raw_phone
            reason = '完整手机号匹配'
        elif numeric and len(raw_phone) == 4:
            matched = bool(full_phone) and full_phone.endswith(raw_phone)
            reason = '仅尾号候选，需核对身份'
        elif len(query) >= 4 and re.fullmatch(r'[a-fA-F0-9]+', query):
            matched = record['id'].lower().startswith(query.lower())
            reason = '咨询编号匹配'
        else:
            matched = query.casefold() in summary['name'].casefold()
            reason = '姓名候选，需核对身份'
        if matched:
            current = next((v for v in visits if v['recordId'] == record['id'] and v['status'] in ACTIVE_STATES), None)
            matches.append(dict(summary, matchReason=reason, activeVisitId=current['id'] if current else None,
                                activeVisitState=current['status'] if current else None))
    return matches[:30]


def event(visit, action, role, detail=''):
    visit['events'].append({'at': time.time(), 'action': action, 'role': role, 'detail': detail})


def checkin(record_id, doctor_id, identity_confirmed, operation):
    if doctor_id not in DOCTORS:
        raise ValueError('请选择接诊医生')
    if identity_confirmed is not True:
        raise ValueError('请先与客户本人核对姓名、手机号或咨询编号')
    if not isinstance(operation, str) or not 8 <= len(operation) <= 80:
        raise ValueError('到店登记缺少操作标识，请重试')
    with store.LOCK, store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT body FROM records WHERE id=?', (record_id,)).fetchone()
        if not row:
            raise KeyError('咨询档案不存在')
        record = json.loads(row[0])
        if record['status'] != 'saved' or record['dirty']:
            raise ValueError('这份咨询档案尚未核对保存，请由咨询师先保存后交接')
        existing = db.execute('SELECT body FROM visits WHERE record_id=?', (record_id,)).fetchall()
        for row in existing:
            visit = json.loads(row[0])
            if visit['operation'] == operation:
                return visit
            if visit['status'] in ACTIVE_STATES:
                raise Conflict('该客户已在接诊队列，请勿重复登记')
        now = time.time()
        visit = {'id': uuid.uuid4().hex, 'recordId': record_id, 'doctorId': doctor_id,
                 'doctorName': DOCTORS[doctor_id], 'status': 'waiting', 'arrivedAt': now,
                 'startedAt': None, 'completedAt': None, 'updatedAt': now, 'revision': 1,
                 'identityConfirmed': True, 'operation': operation, 'note': '',
                 'consultationRevision': record['savedRevision'], 'events': [],
                 'consultationSnapshot': {key:value for key,value in record.items() if key != 'savedSnapshot'}}
        event(visit, '确认到店并交接', 'frontdesk', DOCTORS[doctor_id])
        db.execute('INSERT INTO visits VALUES (?,?,?,?)', (visit['id'], record_id, 'waiting', json.dumps(visit, ensure_ascii=False)))
        return visit


def read(identifier):
    with store.LOCK, store.connect() as db:
        row = db.execute('SELECT body FROM visits WHERE id=?', (identifier,)).fetchone()
        if not row:
            raise KeyError('接诊记录不存在')
        return json.loads(row[0])


def listing(doctor_id=None):
    if doctor_id is not None and doctor_id not in DOCTORS:
        raise ValueError('接诊医生不存在')
    records = {record['id']: record for record in store.list_records()}
    result = []
    for visit in sorted(all_visits(), key=lambda visit: visit['arrivedAt'], reverse=True):
        if doctor_id and visit['doctorId'] != doctor_id:
            continue
        if visit['recordId'] not in records:
            continue
        result.append({key: value for key, value in visit.items() if key not in ('note', 'operation', 'events', 'consultationSnapshot')})
        result[-1]['customer'] = record_summary(records[visit['recordId']])
    return result


def detail(identifier, doctor_id):
    visit = read(identifier)
    if visit['doctorId'] != doctor_id:
        raise ValueError('请切换至该次接诊对应的医生视图')
    record = store.read(visit['recordId'])
    shared_record = (record.get('savedSnapshot') or visit.get('consultationSnapshot') or record) if record['dirty'] else record
    public_visit = {key:value for key,value in visit.items() if key != 'consultationSnapshot'}
    return {'visit': public_visit, 'record': store.public(shared_record),
            'consultationUpdated': record['savedRevision'] != visit['consultationRevision'],
            'consultationHasDraft': record['dirty']}


def update(identifier, action, role, doctor_id, revision, note=None):
    with store.LOCK, store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT body FROM visits WHERE id=?', (identifier,)).fetchone()
        if not row:
            raise KeyError('接诊记录不存在')
        visit = json.loads(row[0])
        if visit['revision'] != revision:
            raise Conflict('该接诊记录已有更新，当前输入已保留，请重新打开并核对最新内容')
        if action == 'cancel':
            if role != 'frontdesk' or visit['status'] != 'waiting':
                raise ValueError('仅前台可撤销尚未开始的到店登记')
            visit['status'] = 'cancelled'
            event(visit, '撤销到店登记', role)
        else:
            if role != 'doctor' or doctor_id != visit['doctorId']:
                raise ValueError('请由本次接诊对应的医生操作')
            if action == 'start':
                if visit['status'] != 'waiting':
                    raise ValueError('本次接诊已开始或已结束，请刷新队列')
                visit.update(status='in_consultation', startedAt=time.time())
                event(visit, '开始接诊', role, DOCTORS[doctor_id])
            elif action in ('note', 'complete'):
                if visit['status'] != 'in_consultation':
                    raise ValueError('请先开始接诊，再记录本次面诊情况')
                if not isinstance(note, str) or not note.strip() or len(note) > 5000:
                    raise ValueError('请填写医生接诊记录，最多5000字')
                # Clinical notes are separate from AI consultation fields and retain prior versions.
                event(visit, '保存接诊记录' if action == 'note' else '完成接诊', role, visit['note'])
                visit['note'] = note.strip()
                if action == 'complete':
                    visit.update(status='completed', completedAt=time.time())
            else:
                raise ValueError('接诊操作不存在')
        visit.update(updatedAt=time.time(), revision=visit['revision'] + 1)
        db.execute('UPDATE visits SET state=?,body=? WHERE id=?', (visit['status'], json.dumps(visit, ensure_ascii=False), identifier))
        return visit
