"""燕云十六声服务器状态探测：读官方服务器列表，每台入口机器握手一次，更新 data/。

跑法：python3 probe.py
本机开着 TUN 代理时，代理会替程序「假装连上」，得绑真实网卡：PROBE_IFACE=en0 python3 probe.py（仅 macOS）
"""
import concurrent.futures as cf
import json
import os
import re
import socket
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

LIST_URL = "https://h72.update.nieapps.com/server_list_prod_b.txt"
DATA = Path(__file__).parent / "data"
HISTORY = DATA / "history.jsonl"
STATUS = DATA / "status.json"
CST = timezone(timedelta(hours=8))
TIMEOUT = 4  # 秒
OK_RATIO = 0.9  # 能连上的比例不低于这个算正常
DAYS = 30
MAX_INCIDENTS = 20
RANK = {"up": 0, "partial": 1, "down": 2}
IP_BOUND_IF = 25  # macOS 的 socket 选项：把连接钉在指定网卡上


def fetch_list(url=LIST_URL):
    req = urllib.request.Request(url, headers={"User-Agent": "yysls-status"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8"), resp.headers.get("Last-Modified")


def parse_list(text):
    """一行一个入口：区名 _ 组号 _ _ _ 服名 ip:端口:_:_ 服号 主控域名 _。同一台机器有好几个端口，测第一个就够。"""
    machines = {}
    for line in text.splitlines():
        cols = line.split()
        if len(cols) != 11:
            continue
        ip, port = cols[7].split(":")[:2]
        if ip not in machines:
            machines[ip] = {"name": cols[6], "hostnum": int(cols[8]), "ip": ip, "port": int(port)}

    def order(m):  # 单人服在前、大世界服在后，各自按编号排
        num = re.search(r"(\d+)$", m["name"])
        return ("大世界" in m["name"], int(num.group(1)) if num else 0)

    return sorted(machines.values(), key=order)


def handshake(ip, port, timeout=TIMEOUT, iface=None):
    """TCP 握手成功返回毫秒数，失败返回 None。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if iface:
            s.setsockopt(socket.IPPROTO_IP, IP_BOUND_IF, socket.if_nametoindex(iface))
        s.settimeout(timeout)
        t0 = time.monotonic()
        s.connect((ip, port))
        return round((time.monotonic() - t0) * 1000)
    except OSError:
        return None
    finally:
        s.close()


def probe_all(machines, iface=None):
    """并发握手；失败的补测一次，两次都失败才算不通，免得网络抖一下就误报。"""
    def once(m):
        ms = handshake(m["ip"], m["port"], iface=iface)
        return ms if ms is not None else handshake(m["ip"], m["port"], iface=iface)

    with cf.ThreadPoolExecutor(16) as ex:
        return [{"name": m["name"], "ok": ms is not None, "ms": ms} for m, ms in zip(machines, ex.map(once, machines))]


def classify(ok, total):
    if total == 0:
        return "unknown"  # 列表都没拉到，说不清
    if ok == 0:
        return "down"
    return "up" if ok / total >= OK_RATIO else "partial"


def incidents(history):
    """连续几次不正常合成一次事件；检测失败的那几次跳过，既不开始也不结束事件。新的在前。"""
    out, cur = [], None
    for r in history:
        s = r["s"]
        if s == "unknown":
            continue
        if s == "up":
            if cur:
                cur["end"] = r["t"]
                out.append(cur)
                cur = None
        elif cur is None:
            cur = {"start": r["t"], "end": None, "worst": s}
        elif RANK[s] > RANK[cur["worst"]]:
            cur["worst"] = s
    if cur:
        out.append(cur)
    return out[::-1][:MAX_INCIDENTS]


def daily(history, now, days=DAYS):
    """近 days 天按北京时间分天：检测次数、正常占比、当天最差状态。没数据的天给 None。"""
    today = datetime.fromtimestamp(now, CST).date()
    buckets = {today - timedelta(d): [] for d in range(days)}
    for r in history:
        d = datetime.fromtimestamp(r["t"], CST).date()
        if d in buckets and r["s"] != "unknown":
            buckets[d].append(r["s"])
    return [
        {
            "date": d.isoformat(),
            "checks": len(v),
            "up": round(v.count("up") / len(v), 3) if v else None,
            "worst": max(v, key=RANK.get) if v else None,
        }
        for d, v in sorted(buckets.items())
    ]


def load_history(path=HISTORY):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main():
    now = int(time.time())
    try:
        text, modified = fetch_list()
        machines = probe_all(parse_list(text), iface=os.environ.get("PROBE_IFACE"))
    except OSError as e:  # 列表拉不下来：记一笔检测失败，不当停服
        print("fetch failed:", e)
        modified, machines = None, []
    ok = sum(m["ok"] for m in machines)
    record = {"t": now, "ok": ok, "total": len(machines), "s": classify(ok, len(machines))}

    DATA.mkdir(exist_ok=True)
    with HISTORY.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")
    history = load_history()
    status = {
        "checked_at": now,
        "status": record["s"],
        "ok": ok,
        "total": len(machines),
        "list_modified": modified,
        "first_check": history[0]["t"],
        "machines": machines,
        "days": daily(history, now),
        "incidents": incidents(history),
    }
    STATUS.write_text(json.dumps(status, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(record)


if __name__ == "__main__":
    main()
