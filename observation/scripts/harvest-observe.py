"""Read only Harvest's non-secret identity fields and today's check-in evidence."""
import datetime
import json
import re
import sqlite3
import sys
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


def classify(message):
    if re.search(r'签到失败|簽到失敗|check.?in fail|sign.?in fail', message, re.I):
        return 'failed'
    if re.search(r'未签到|未簽到|not signed|not checked', message, re.I):
        return 'not_signed'
    if re.search(r'已签到|已簽到|重复操作|already.*(?:signed|checked)', message, re.I):
        return 'already_signed'
    if re.fullmatch(r'您今天已经在其他地方签到了哦[！!。]?', message.strip()):
        return 'already_signed'
    if re.search(r'签到成功|簽到成功|check.?in success', message, re.I):
        return 'signed'
    # Site-specific positive receipts observed in Harvest's daily sign_info.
    if re.search(r'^成功[,，].*已连续签到\d+天', message):
        return 'signed'
    if re.search(r'今日签到排名.*这是您的第\d+次签到.*本次签到获得', message):
        return 'signed'
    return 'unknown'


def completed_daily_task(conn, now, day):
    try:
        tasks = conn.execute("SELECT task FROM harvest_schedule_task WHERE enabled=1 AND task LIKE '%签到%'").fetchall()
        if len(tasks) != 1:
            return None
        row = conn.execute(
            'SELECT id,status,date_created,date_done FROM harvest_schedule_result '
            'WHERE task_name=? ORDER BY id DESC LIMIT 1', (tasks[0][0],)
        ).fetchone()
        if not row:
            return None
        active = conn.execute(
            "SELECT COUNT(*) FROM harvest_schedule_result WHERE task_name=? "
            "AND UPPER(status) IN ('PENDING','STARTED','RECEIVED','PROGRESS','RETRY')",
            (tasks[0][0],)
        ).fetchone()[0]
        if active:
            return {'resultId': row[0], 'status': 'running', 'startedAt': row[2],
                    'completedAt': None, 'activeTaskCount': active,
                    'activityCoverage': 'recorded_results'}
        started = datetime.datetime.fromisoformat(row[2])
        ended = datetime.datetime.fromisoformat(row[3])
        if started.tzinfo is None:
            started = started.replace(tzinfo=ZoneInfo('Asia/Shanghai'))
        if ended.tzinfo is None:
            ended = ended.replace(tzinfo=ZoneInfo('Asia/Shanghai'))
        if (started.astimezone(ZoneInfo('Asia/Shanghai')).date().isoformat() != day
                or ended.astimezone(ZoneInfo('Asia/Shanghai')).date().isoformat() != day
                or ended < started or ended > now):
            return None
        return {'resultId': row[0], 'status': 'completed' if row[1] == 'SUCCESS' else 'failed',
                'activeTaskCount': 0, 'activityCoverage': 'recorded_results',
                'startedAt': started.isoformat(), 'completedAt': ended.isoformat()}
    except (sqlite3.OperationalError, ValueError, TypeError, AttributeError):
        return None


def export(db_path, now=None):
    now = now or datetime.datetime.now(ZoneInfo('Asia/Shanghai'))
    day = now.date().isoformat()
    conn = sqlite3.connect('file:' + db_path + '?mode=ro', uri=True, timeout=5)
    conn.execute('PRAGMA query_only=ON')
    columns = {row[1] for row in conn.execute('PRAGMA table_info(mysite_mysite)')}
    ownership_columns = {'available', 'sign_in'}.issubset(columns)
    ownership_select = ',available,sign_in' if ownership_columns else ',NULL,NULL'
    rows = conn.execute('SELECT mirror,nickname,user_id,username,sign_info' + ownership_select + ' FROM mysite_mysite').fetchall()
    task_completion = completed_daily_task(conn, now, day)
    conn.close()
    sites = []
    inventory_complete = ownership_columns
    for mirror, name, uid, username, raw, available, sign_in in rows:
        flags_known = type(available) in (int, bool) and available in (0, 1) and type(sign_in) in (int, bool) and sign_in in (0, 1)
        if not flags_known:
            inventory_complete = False
        url = urlsplit(mirror or '')
        if url.scheme != 'https' or not url.hostname or url.username or url.password:
            if not flags_known or available and sign_in:
                inventory_complete = False
            continue
        try:
            record = json.loads(raw or '{}').get(day) or {}
            message = str(record.get('message') or record.get('info') or '')
            stamp = datetime.datetime.fromisoformat(record.get('created_at', ''))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=ZoneInfo('Asia/Shanghai'))
            valid = stamp.astimezone(ZoneInfo('Asia/Shanghai')).date().isoformat() == day and stamp <= now
        except (ValueError, TypeError, AttributeError):
            valid = False
        status = classify(message) if valid else 'unknown'
        sites.append({
            'origin': 'https://' + url.netloc, 'displayName': str(name or '')[:80],
            'username': str(username or '')[:80], 'userId': str(uid or '')[:40],
            **({'checkinEnabled': bool(available and sign_in)} if flags_known else {}),
            'status': status, 'observedAt': stamp.isoformat() if valid else None,
            'evidence': {'source': 'harvest', 'authoritative': status in ('signed', 'already_signed'),
                         'summary': 'Harvest 当日签到回执' if status in ('signed', 'already_signed')
                         else 'Harvest 当日明确未签到记录' if status == 'not_signed'
                         else 'Harvest 当日失败记录' if status == 'failed'
                         else 'Harvest 暂无可确认的今日签到记录'}
        })
    return {'schemaVersion': 1, 'source': 'harvest', 'businessDate': day,
            'generatedAt': now.isoformat(), 'taskCompletion': task_completion,
            'checkinInventoryComplete': inventory_complete, 'sites': sites}


if __name__ == '__main__':
    print(json.dumps(export(sys.argv[1]), ensure_ascii=True))
