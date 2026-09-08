"""Read only Harvest's non-secret identity fields and today's check-in evidence."""
import datetime
import json
import re
import sqlite3
import sys
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


def classify(message):
    if re.search(r'未签到|未簽到|签到失败|簽到失敗|not signed|not checked', message, re.I):
        return 'unknown'
    if re.search(r'已签到|已簽到|重复操作|already.*(?:signed|checked)', message, re.I):
        return 'already_signed'
    if re.search(r'签到成功|簽到成功|check.?in success', message, re.I):
        return 'signed'
    # Site-specific positive receipts observed in Harvest's daily sign_info.
    if re.search(r'^成功[,，].*已连续签到\d+天', message):
        return 'signed'
    if re.search(r'今日签到排名.*这是您的第\d+次签到.*本次签到获得', message):
        return 'signed'
    return 'unknown'


def export(db_path, now=None):
    now = now or datetime.datetime.now(ZoneInfo('Asia/Shanghai'))
    day = now.date().isoformat()
    conn = sqlite3.connect('file:' + db_path + '?mode=ro', uri=True, timeout=5)
    conn.execute('PRAGMA query_only=ON')
    rows = conn.execute('SELECT mirror,nickname,user_id,username,sign_info FROM mysite_mysite').fetchall()
    conn.close()
    sites = []
    for mirror, name, uid, username, raw in rows:
        url = urlsplit(mirror or '')
        if url.scheme != 'https' or not url.hostname or url.username or url.password:
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
            'status': status, 'observedAt': stamp.isoformat() if valid else None,
            'evidence': {'source': 'harvest', 'authoritative': status in ('signed', 'already_signed'),
                         'summary': 'Harvest 当日签到回执' if status != 'unknown' else 'Harvest 暂无可确认的今日签到记录'}
        })
    return {'schemaVersion': 1, 'source': 'harvest', 'businessDate': day, 'generatedAt': now.isoformat(), 'sites': sites}


if __name__ == '__main__':
    print(json.dumps(export(sys.argv[1]), ensure_ascii=True))
