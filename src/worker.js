// Cloudflare Worker：定时读官方服务器列表、逐台握手、把结果累积进 KV；GET /status.json 给页面数据
import { connect } from "cloudflare:sockets";
import { WorkerEntrypoint } from "cloudflare:workers";
import { classify, drainingList, maxAge, parseList, pickList, record, view } from "./logic.js";
import { isPlanned, onlinePosts, parseOnlineTime, parseStopTime, stopPosts } from "./notice.js";

// 官方服务器列表有 A、B 两份，是两批不同的机器，换版本时整批切过去；后面接 a.txt 或 b.txt
const LIST_URL = "https://h72.update.nieapps.com/server_list_prod_";
// 游戏登录界面的公告：列表在 game_notice_index，每条的正文在同目录下以 post_name 为文件名
const NOTICE_URL = "https://h72.update.nieapps.com/game_notice/";
// 客户端启动时读的版本入口（PC 版）。不停服维护完了才放新版本，version 一换就是维护结束；Mac 版换得晚，不用它。
// 里面的 client_switch 是客户端该用哪份服务器列表
const VER_URL = "https://h72.update.nieapps.com/pl/patchmd5_publish_win64_formal_o_usual.txt";
const UA = { headers: { "User-Agent": "yysls-status" } };
const TIMEOUT_MS = 4000;
// 平台限制同一时间最多 6 个连接处在建立中，多出来的会排队；排队的时间不能算进超时，所以自己控制并发
const POOL = 6;
// 免费版每次运行最多 50 个子请求，TCP 连接也算。每组 10 台、算上补测最多 20 个连接，交给单独一次运行去测
const CHUNK = 10;

// TCP 握手成功返回毫秒数，失败或超时返回 null
async function handshake(hostname, port) {
  const t0 = Date.now();
  const socket = connect({ hostname, port });
  socket.closed.catch(() => {});
  let timer;
  try {
    await Promise.race([socket.opened, new Promise((_, fail) => (timer = setTimeout(fail, TIMEOUT_MS)))]);
    return Date.now() - t0;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    Promise.resolve().then(() => socket.close()).catch(() => {});
  }
}

// 失败的补测一次，两次都失败才算连不上，免得网络抖一下就误报
async function probeAll(machines) {
  const results = [];
  let next = 0;
  const lane = async () => {
    while (next < machines.length) {
      const i = next++;
      const { name, ip, port } = machines[i];
      const ms = (await handshake(ip, port)) ?? (await handshake(ip, port));
      results[i] = { name, ok: ms !== null, ms };
    }
  };
  await Promise.all(Array.from({ length: POOL }, lane));
  return results;
}

// 公告正文：普通公告在 /game_notice/<post_name>；版本更新公告打包在 mpk 里（几十 MB 图片），文字在最前面，只读开头
async function noticeBody(p) {
  if (!p.mpk_url) {
    const resp = await fetch(NOTICE_URL + encodeURIComponent(p.post_name), UA);
    return resp.ok ? resp.text() : "";
  }
  // 从 Worker 发出去的 Range 会被忽略、照样回整包，所以边读边数，读够就掐断
  const resp = await fetch(p.mpk_url, UA);
  if (!resp.ok) return "";
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (let n = 0; n < 65536; ) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    text += dec.decode(value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return text;
}

// 公告列表里的停服公告和不停服维护公告，带上从正文读出来的时间；读不出时间的跳过
async function fetchNotices(now) {
  const resp = await fetch(NOTICE_URL + "game_notice_index", UA);
  if (!resp.ok) throw new Error(`notice index HTTP ${resp.status}`);
  const index = await resp.json();
  const notices = [];
  for (const p of stopPosts(index).slice(0, 3)) {
    const time = parseStopTime(await noticeBody(p), now);
    if (time) notices.push({ title: p.post_title, planned: isPlanned(p.post_title), ...time });
  }
  for (const p of onlinePosts(index).slice(0, 2)) {
    const time = parseOnlineTime(await noticeBody(p), now);
    if (time) notices.push({ title: p.post_title, planned: true, online: true, ...time });
  }
  return notices;
}

// 读一份服务器列表（a / b），分组交给 Prober 去测
async function probeList(env, list) {
  const resp = await fetch(`${LIST_URL}${list}.txt`, UA);
  if (!resp.ok) throw new Error(`server list ${list} HTTP ${resp.status}`);
  const modified = resp.headers.get("Last-Modified");
  const all = parseList(await resp.text());
  const chunks = [];
  for (let i = 0; i < all.length; i += CHUNK) chunks.push(all.slice(i, i + CHUNK));
  return { modified, machines: (await Promise.all(chunks.map((c) => env.PROBER.probe(c)))).flat() };
}

// 只能通过服务绑定调用，外面访问不到
export class Prober extends WorkerEntrypoint {
  async probe(machines) {
    return probeAll(machines);
  }
}

export default {
  async scheduled(controller, env) {
    const t = Math.floor(controller.scheduledTime / 1000);
    const prev = await env.KV.get("state", "json");
    // 和探测同时读公告。没读到给 null，record 会沿用上一次的
    const noticesP = fetchNotices(t).catch((e) => (console.log("notices failed:", String(e)), null));
    // 先读版本入口，才知道该测哪份列表；没读到就沿用上一次测的那份
    const patch = await fetch(VER_URL, UA)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const ver = patch?.version ?? null;
    const list = pickList(patch?.client_switch, prev?.last?.list);
    // 换服后旧的那批还没关完，就顺带测一下，记下几点关完的
    const draining = drainingList(prev, list);
    const oldP = draining
      ? probeList(env, draining)
          .then(({ machines: ms }) => ({ ok: ms.filter((m) => m.ok).length, total: ms.length }))
          .catch(() => undefined)
      : undefined;
    let machines = [];
    let list_modified = null;
    try {
      ({ machines, modified: list_modified } = await probeList(env, list));
    } catch (e) {
      console.log("probe failed:", String(e)); // 记一笔检测失败，不当停服
      machines = [];
    }
    const ok = machines.filter((m) => m.ok).length;
    const [notices, old] = await Promise.all([noticesP, oldP]);
    const rec = { t, ok, total: machines.length, s: classify(ok, machines.length), machines, list, list_modified, notices, ver, old };
    const state = record(prev, rec);
    await env.KV.put("state", JSON.stringify(state));
    console.log(state.last.s, `${ok}/${machines.length}`, `list=${list}`, old ? `old=${old.ok}/${old.total}` : "", `notices=${state.last.notices.length}`, state.last.ver);
  },

  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/status.json") return new Response("not found", { status: 404 });
    // 公开接口：允许别的网站在浏览器里直接读
    const cors = { "Access-Control-Allow-Origin": "*" };
    const state = await env.KV.get("state", "json");
    if (!state) return new Response("no data yet", { status: 503, headers: cors });
    const now = Math.floor(Date.now() / 1000);
    return Response.json(view(state, now), {
      headers: { ...cors, "Cache-Control": `public, max-age=${maxAge(state.last.t, now)}` },
    });
  },
};
