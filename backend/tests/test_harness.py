#!/usr/bin/env python3
"""Tests for harness.free_port()'s fetch-banned-port guard (#277).

不启动服务端，所以「抽到禁用端口会重抽」这件事可以用打桩确定性地证明，不必去赌
0.11% 的命中率——纯抽样断言在低位段以外的机器上近似恒真，正是本条要避免的那种测试。
"""
import importlib.util
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    'harness_under_test', Path(__file__).resolve().parent / 'harness.py')
harness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(harness)

# #277 在 1024–15000 逐点实测出来的、Node `fetch` 会拒绝的端口。
# 表是抄规格抄来的，这几个则是**实测**锚点：表漂移时先红的就是它们。
REPRO_FROM_ISSUE = (2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
                    6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080)


class _FakeSocket:
    """只回答 getsockname()，让 free_port 以为 OS 给了这个端口。"""

    def __init__(self, port):
        self._port = port

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def bind(self, address):
        pass

    def getsockname(self):
        return ('127.0.0.1', self._port)


def _socket_sequence(ports):
    """按顺序交出端口；数目不够就 IndexError，好让「多抽了几次」也变成失败。"""
    remaining = list(ports)

    def factory():
        return _FakeSocket(remaining.pop(0))

    return factory


class BannedPortTable(unittest.TestCase):
    def test_ports_are_in_range_and_the_issue_repro_is_covered(self):
        for port in harness.BANNED_PORTS:
            self.assertTrue(1 <= port <= 65535, f'{port} 不是合法端口号')
        for port in REPRO_FROM_ISSUE:
            self.assertIn(port, harness.BANNED_PORTS,
                          f'#277 实测命中的 {port} 不在表里，本表已与实现漂移')

    def test_the_table_is_a_frozenset_not_a_list(self):
        # 查表在 free_port 的热路径上，且重复项会让「表有多大」这个数字不可信。
        self.assertIsInstance(harness.BANNED_PORTS, frozenset)


class FreePortRerolls(unittest.TestCase):
    def test_rerolls_when_the_operating_system_hands_back_a_banned_port(self):
        """抽到禁用端口必须重抽——这是修复本身，不是「恰好没抽中」。"""
        banned = min(harness.BANNED_PORTS)
        factory = _socket_sequence([banned, banned, 45001])
        with mock.patch.object(harness.socket, 'socket', factory):
            self.assertEqual(harness.free_port(), 45001)

    def test_rerolls_for_an_empirically_banned_port_too(self):
        factory = _socket_sequence([6679, 6697, 45002])
        with mock.patch.object(harness.socket, 'socket', factory):
            self.assertEqual(harness.free_port(), 45002)

    def test_returns_the_first_port_when_it_is_already_fine(self):
        factory = _socket_sequence([45003])
        with mock.patch.object(harness.socket, 'socket', factory):
            self.assertEqual(harness.free_port(), 45003)

    def test_giving_up_mentions_the_port_in_the_error(self):
        """验收第 3 条：失败路径不能让人以为「套件坏了」。"""
        always_banned = _socket_sequence([min(harness.BANNED_PORTS)] * harness._FREE_PORT_ATTEMPTS)
        with mock.patch.object(harness.socket, 'socket', always_banned):
            with self.assertRaises(RuntimeError) as caught:
                harness.free_port()
        self.assertIn('端口', str(caught.exception))

    def test_giving_up_is_bounded_rather_than_an_infinite_retry(self):
        # 序列只够 ATTEMPTS 次，多抽一次就 IndexError——所以这里通过本身就是「有上界」的证明。
        factory = _socket_sequence([min(harness.BANNED_PORTS)] * harness._FREE_PORT_ATTEMPTS)
        with mock.patch.object(harness.socket, 'socket', factory):
            with self.assertRaises(RuntimeError):
                harness.free_port()

    def test_sampling_never_yields_a_banned_port_on_this_machine(self):
        """在动态范围覆盖禁用端口的机器上（Windows 默认 1024 起）这条才有牙齿。"""
        drawn = {harness.free_port() for _ in range(300)}
        self.assertFalse(drawn & harness.BANNED_PORTS,
                         f'抽到了禁用端口：{sorted(drawn & harness.BANNED_PORTS)}')


class TableMatchesWhatNodeActuallyRejects(unittest.TestCase):
    """表是抄规格的，那就拿 Node 当裁判——抄错或漏抄时这条会红，而不是等到有人本地偶发失败。

    没有 node 时跳过：这不是「以 CI 为准」，而是这台机器上确实没有裁判可问。
    """

    def _node_rejects(self, port):
        """返回 fetch 是否以 bad port 拒绝了该端口。"""
        script = (
            "fetch('http://127.0.0.1:%d/').then(() => console.log('ok'))"
            ".catch(e => console.log((e.cause && e.cause.message) || e.message))"
        ) % port
        result = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=30)
        return 'bad port' in (result.stdout or '')

    def test_node_rejects_every_port_in_the_table_and_a_control_group_is_not_rejected(self):
        if shutil.which('node') is None:
            self.skipTest('node 不在 PATH 上，本机没有裁判可问')

        sample = sorted(list(harness.BANNED_PORTS)[:20]) + list(REPRO_FROM_ISSUE)
        for port in sample:
            with self.subTest(banned=port):
                self.assertTrue(self._node_rejects(port),
                                f'{port} 在表里，但 Node 并不拒绝它——表多抄了')

        # 对照组：表外的端口不该被 bad-port 拦下（连不上是另一回事，那会走套件自己的断言）。
        for port in (45011, 45012, 45013):
            with self.subTest(control=port):
                self.assertFalse(self._node_rejects(port),
                                 f'{port} 不在表里，但 Node 拒绝了它——表漏抄了')


if __name__ == '__main__':
    unittest.main()
