// Cloudflare Worker：定时读官方服务器列表、逐台握手、把结果累积进 KV；GET /status.json 给页面数据
import { connect } from "cloudflare:sockets";
import { WorkerEntrypoint } from "cloudflare:workers";
import { classify, parseList, record, view } from "./logic.js";

const LIST_URL = "https://h72.update.nieapps.com/server_list_prod_b.txt";
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

// 只能通过服务绑定调用，外面访问不到
export class Prober extends WorkerEntrypoint {
  async probe(machines) {
    return probeAll(machines);
  }
}

export default {
  async scheduled(controller, env) {
    let machines = [];
    let list_modified = null;
    try {
      const resp = await fetch(LIST_URL, { headers: { "User-Agent": "yysls-status" } });
      if (!resp.ok) throw new Error(`server list HTTP ${resp.status}`);
      list_modified = resp.headers.get("Last-Modified");
      const all = parseList(await resp.text());
      const chunks = [];
      for (let i = 0; i < all.length; i += CHUNK) chunks.push(all.slice(i, i + CHUNK));
      machines = (await Promise.all(chunks.map((c) => env.PROBER.probe(c)))).flat();
    } catch (e) {
      console.log("probe failed:", String(e)); // 记一笔检测失败，不当停服
      machines = [];
    }
    const ok = machines.filter((m) => m.ok).length;
    const t = Math.floor(controller.scheduledTime / 1000);
    const rec = { t, ok, total: machines.length, s: classify(ok, machines.length), machines, list_modified };
    await env.KV.put("state", JSON.stringify(record(await env.KV.get("state", "json"), rec)));
    console.log(rec.s, `${ok}/${machines.length}`);
  },

  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/status.json") return new Response("not found", { status: 404 });
    const state = await env.KV.get("state", "json");
    if (!state) return new Response("no data yet", { status: 503 });
    return Response.json(view(state, Math.floor(Date.now() / 1000)), {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  },
};
