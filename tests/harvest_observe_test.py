import importlib.util
import pathlib
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
        for text in ['未签到', '签到失败', 'HTTP 200', '抓取成功', '请求超时', '']:
            self.assertEqual(observer.classify(text), 'unknown')


if __name__ == '__main__':
    unittest.main()
