import importlib.util
import pathlib
import sqlite3
import tempfile
import datetime
from unittest.mock import patch
import unittest

spec = importlib.util.spec_from_file_location('observer', pathlib.Path(__file__).parents[1] / 'scripts' / 'harvest-observe.py')
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class HarvestEvidenceTest(unittest.TestCase):
    def test_success_requires_explicit_positive_evidence(self):
        self.assertEqual(observer.classify('签到成功 这是第 1 次'), 'signed')
        self.assertEqual(observer.classify('已签到，请勿重复操作'), 'already_signed')
        self.assertEqual(observer.classify('成功,已连续签到81天,魔力值加170'), 'signed')
        self.assertEqual(observer.classify('今日签到排名：1 / 1 这是您的第209次签到，已连续签到209天，本次签到获得1000个'), 'signed')
        self.assertEqual(observer.classify('未签到'), 'not_signed')
        self.assertEqual(observer.classify('签到失败'), 'failed')
        for text in ['HTTP 200', '抓取成功', '请求超时', '']:
            self.assertEqual(observer.classify(text), 'unknown')

    def test_only_current_day_explicit_failure_is_an_observed_failure(self):
        shanghai = datetime.timezone(datetime.timedelta(hours=8))
        now = datetime.datetime(2026, 9, 20, 9, 0, tzinfo=shanghai)
        with tempfile.TemporaryDirectory() as folder:
            database = pathlib.Path(folder) / 'harvest.sqlite'
            conn = sqlite3.connect(database)
            conn.execute('CREATE TABLE mysite_mysite(mirror TEXT, nickname TEXT, user_id TEXT, username TEXT, sign_info TEXT)')
            conn.execute('CREATE TABLE harvest_schedule_task(task TEXT, enabled INTEGER)')
            conn.execute('CREATE TABLE harvest_schedule_result(id INTEGER, task_name TEXT, status TEXT, date_created TEXT, date_done TEXT)')
            conn.execute('INSERT INTO harvest_schedule_task VALUES(?,?)', ('自动签到任务', 1))
            conn.execute('INSERT INTO harvest_schedule_result VALUES(?,?,?,?,?)', (5, '自动签到任务', 'SUCCESS', '2026-09-20T08:00:00+08:00', '2026-09-20T08:01:00+08:00'))
            for origin, status, day in [('https://failed.example', '签到失败', '2026-09-20'),
                                        ('https://old.example', '未签到', '2026-09-19'),
                                        ('https://absent.example', '请求超时', '2026-09-20')]:
                record = {day: {'message': status, 'created_at': f'{day}T08:00:00+08:00'}}
                conn.execute('INSERT INTO mysite_mysite VALUES(?,?,?,?,?)', (origin, 'fixture', '7', 'fixture', observer.json.dumps(record)))
            conn.commit()
            conn.close()
            with patch.object(observer, 'ZoneInfo', return_value=shanghai):
                result = observer.export(str(database), now=now)
        statuses = {item['origin']: item for item in result['sites']}
        self.assertEqual(statuses['https://failed.example']['status'], 'failed')
        self.assertFalse(statuses['https://failed.example']['evidence']['authoritative'])
        self.assertEqual(statuses['https://old.example']['status'], 'unknown')
        self.assertEqual(statuses['https://absent.example']['status'], 'unknown')
        self.assertEqual(result['taskCompletion']['status'], 'completed')
        self.assertEqual(result['taskCompletion']['resultId'], 5)


if __name__ == '__main__':
    unittest.main()
