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

## 公开接口

其他网站、wiki、机器人可以直接读页面用的同一份数据，浏览器里跨域请求也行：

```
GET https://yysls-status.netlify.app/data/status.json
```

- 数据每 3 分钟更新一次，接口有 60 秒缓存，没必要请求得比这更频繁。
- 请用上面这个地址。`workers.dev` 那个源地址在国内基本打不开，也没有缓存。
- 表里列出的字段会保持不变；没列出的字段只给本站页面用，随时可能调整。

| 字段 | 含义 |
|---|---|
| `status` | 最近一次检测的结果：`up` 运行正常、`partial` 部分异常、`down` 停服中、`unknown` 检测失败 |
| `checked_at` | 最近一次检测的时间，Unix 秒 |
| `ok` / `total` | 能连上的服务器数 / 列表里的服务器总数 |
| `first_check` | 本站开始检测的时间，Unix 秒 |
| `days[]` | 近 30 天，从早到晚：`date` 北京时间日期，`up` 当天正常的检测占比（0～1，没数据为 `null`），`worst` 当天最差的状态 |
| `incidents[]` | 最近的停服和异常事件，新的在前：`start`、`end` 为 Unix 秒，`end` 为 `null` 表示还没恢复，`worst` 是期间最差的状态。`start` 等于 `first_check` 时，说明本站开始检测前就已经停了，真实开始时间未知 |

## 常用命令

```bash
npm test                                               # 跑判定规则的自检
npx wrangler@4 deploy                                  # 部署 Worker
npx wrangler@4 tail                                    # 看 Worker 的实时日志
npx netlify-cli deploy --prod --no-build --dir site    # 部署页面
```
