"""probe.py 的规则自检：python3 test_probe.py，全过打印 ok。"""
import socket
from datetime import datetime

from probe import CST, classify, daily, handshake, incidents, parse_list

SAMPLE = """\
正式区 1001 10001 5 3 0 正式大服大世界服1 45.253.181.184:10400:12:1 12001 h72-ms-prod.netease.com 1
正式区 1001 10001 5 3 0 正式大服单人服10 223.252.222.175:10200:12:1 10010 h72-ms-prod.netease.com 1
正式区 1001 10001 5 3 0 正式大服单人服2 123.58.168.21:10400:12:1 10002 h72-ms-prod.netease.com 1
正式区 1001 10001 5 3 0 正式大服单人服2 123.58.168.21:11800:12:1 10002 h72-ms-prod.netease.com 1
坏掉的一行
"""


def test_parse_list():
    ms = parse_list(SAMPLE)
    assert [m["name"] for m in ms] == ["正式大服单人服2", "正式大服单人服10", "正式大服大世界服1"]
    assert ms[0] == {"name": "正式大服单人服2", "hostnum": 10002, "ip": "123.58.168.21", "port": 10400}


def test_classify():
    assert classify(65, 65) == "up"
    assert classify(59, 65) == "up"  # 59/65 ≈ 0.908
    assert classify(58, 65) == "partial"
    assert classify(0, 65) == "down"
    assert classify(0, 0) == "unknown"


def test_incidents():
    h = [{"t": t, "s": s} for t, s in
         [(1, "up"), (2, "partial"), (3, "down"), (4, "unknown"), (5, "up"), (6, "partial")]]
    assert incidents(h) == [
        {"start": 6, "end": None, "worst": "partial"},  # 还没恢复
        {"start": 2, "end": 5, "worst": "down"},  # 中间那次检测失败不打断事件
    ]
    assert incidents([{"t": 1, "s": "up"}]) == []


def test_daily():
    now = datetime(2026, 11, 5, 23, 0, tzinfo=CST).timestamp()
    h = [
        {"t": datetime(2026, 11, 5, 0, 30, tzinfo=CST).timestamp(), "s": "up"},
        {"t": datetime(2026, 11, 5, 19, 0, tzinfo=CST).timestamp(), "s": "down"},
        {"t": datetime(2026, 11, 4, 23, 50, tzinfo=CST).timestamp(), "s": "unknown"},
        {"t": datetime(2026, 9, 1, tzinfo=CST).timestamp(), "s": "down"},  # 30 天以外
    ]
    days = daily(h, now)
    assert len(days) == 30 and days[-1]["date"] == "2026-11-05"
    assert days[-1] == {"date": "2026-11-05", "checks": 2, "up": 0.5, "worst": "down"}
    assert days[-2] == {"date": "2026-11-04", "checks": 0, "up": None, "worst": None}


def test_handshake():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    port = srv.getsockname()[1]
    assert isinstance(handshake("127.0.0.1", port, timeout=2), int)
    srv.close()
    assert handshake("127.0.0.1", port, timeout=2) is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
