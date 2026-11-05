# 燕云十六声服务器状态

玩家自建的非官方状态页，用来看《燕云十六声》的登录服务器现在能不能连上，还有近 30 天的可用情况和停服、异常记录。

页面：<https://yysls-status.netlify.app>

## 怎么判断的

每 3 分钟读一次官方服务器列表（游戏登录前读的就是这份），对列表里每台登录服务器做一次 TCP 握手。失败的补测一次，两次都失败才算连不上。

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
| `src/logic.js` | 判定规则、按天统计、事件合并 |
| `src/worker.js` | Cloudflare Worker：定时探测（分组交给 `Prober` 入口去测），`/status.json` 给页面数据 |
| `test/logic.test.js` | 判定规则的自检 |
| `wrangler.toml` | Worker 的配置：定时、KV 存储 |
| `site/` | 静态页，部署在 Netlify |

## 数据怎么到页面

Cloudflare Worker 每 3 分钟跑一次探测，结果累积在 Workers KV 里，访问 `/status.json` 就能拿到页面要的数据。页面部署在 Netlify，请求 `/data/status.json` 时由 Netlify 反向代理到 Worker，国内访客不用直连 workers.dev。页面只需要部署一次，数据更新了也不用重新部署。

## 常用命令

```bash
npm test                                               # 跑判定规则的自检
npx wrangler@4 deploy                                  # 部署 Worker
npx wrangler@4 tail                                    # 看 Worker 的实时日志
npx netlify-cli deploy --prod --no-build --dir site    # 部署页面
```
