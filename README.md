# 燕云十六声服务器状态

玩家自建的非官方状态页，用来看《燕云十六声》的登录服务器现在能不能连上，还有近 30 天的可用情况和停服、异常记录。

页面：<https://yysls-status.netlify.app>

## 怎么判断的

每 5～15 分钟读一次官方服务器列表（游戏登录前读的就是这份），对列表里每台登录服务器做一次 TCP 握手。失败的补测一次，两次都失败才算连不上。

| 状态 | 条件 |
|---|---|
| 运行正常 | 90% 以上的服务器能连上 |
| 部分异常 | 能连上的不到 90%，但至少有一台 |
| 停服中 | 一台都连不上 |
| 检测失败 | 没拉到官方服务器列表，这次不算数 |

一次或连续几次检测不正常，算作一次事件，开始时间取第一次测到异常的时间。

这里只检测能不能连上登录服务器，能连上不代表所有玩法都正常，一切以官方公告为准。

## 目录

| 路径 | 是什么 |
|---|---|
| `probe.py` | 拉列表、握手、更新 `data/` |
| `test_probe.py` | 判定规则的自检，`python3 test_probe.py` |
| `data/history.jsonl` | 每次检测一行 |
| `data/status.json` | 页面读的全部数据 |
| `site/` | 静态页，部署在 Netlify |
| `.github/workflows/probe.yml` | 定时跑探测、提交数据 |

## 数据怎么到页面

GitHub Actions 定时跑 `probe.py`，把 `data/` 提交回仓库。页面部署在 Netlify，请求 `/data/*` 时由 Netlify 反向代理到本仓库的原始文件，国内访客不用直连 GitHub。页面只需要部署一次，数据更新了也不用重新部署。

部署页面：

```bash
npx netlify-cli deploy --prod --no-build --dir site
```

## 本机跑

```bash
python3 probe.py
```

开着 TUN 模式的代理时，代理会先替程序把连接接下来，不管服务器通不通都显示连上，所以结果不准。macOS 上可以绑定真实网卡绕开：

```bash
PROBE_IFACE=en0 python3 probe.py
```
