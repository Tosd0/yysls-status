// 判定规则和状态累积：纯函数，Worker 和测试共用

export const OK_RATIO = 0.9; // 能连上的比例不低于这个算正常
export const DAYS = 30;
export const MAX_INCIDENTS = 20;
export const PERIOD = 180; // 和 wrangler.toml 里的 cron 一致，每 3 分钟检测一次
// 服务器都连得上时一轮几秒就写进 KV；有连不上的要等超时，会晚到 20 秒左右，那段靠 10 秒重试补上
const MIN_RUN = 5;
const RANK = { up: 0, partial: 1, down: 2 };
const CST_MS = 8 * 3600 * 1000;

// 一行一个入口：区名 _ 组号 _ _ _ 服名 ip:端口:_:_ 服号 主控域名 _。同一台服务器有好几个端口，测第一个就够
export function parseList(text) {
  const machines = new Map();
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length !== 11) continue;
    const [ip, port] = cols[7].split(":");
    if (!machines.has(ip)) machines.set(ip, { name: cols[6], ip, port: Number(port) });
  }
  // 单人服在前、大世界服在后，各自按编号排
  const key = (m) => (m.name.includes("大世界") ? 1000 : 0) + Number(m.name.match(/(\d+)$/)?.[1] ?? 0);
  return [...machines.values()].sort((a, b) => key(a) - key(b));
}

export function classify(ok, total) {
  if (total === 0) return "unknown"; // 列表都没拉到，说不清
  if (ok === 0) return "down";
  return ok / total >= OK_RATIO ? "up" : "partial";
}

export const cstDate = (t) => new Date(t * 1000 + CST_MS).toISOString().slice(0, 10);

// 把一次检测并进状态：按北京时间分天计数，连续不正常合成一次事件。检测失败的那次只更新 last，不计数也不打断事件
export function record(state, rec) {
  const s = state ? structuredClone(state) : { first_check: rec.t, days: {}, incidents: [] };
  s.last = rec;
  if (rec.s === "unknown") return s;

  const day = (s.days[cstDate(rec.t)] ??= { checks: 0, ups: 0, worst: "up" });
  day.checks++;
  if (rec.s === "up") day.ups++;
  if (RANK[rec.s] > RANK[day.worst]) day.worst = rec.s;
  const oldest = cstDate(rec.t - (DAYS - 1) * 86400);
  for (const d of Object.keys(s.days)) if (d < oldest) delete s.days[d];

  const open = s.incidents[0]?.end === null ? s.incidents[0] : null;
  if (rec.s === "up") {
    if (open) open.end = rec.t;
  } else if (!open) {
    s.incidents = [{ start: rec.t, end: null, worst: rec.s }, ...s.incidents].slice(0, MAX_INCIDENTS);
  } else if (RANK[rec.s] > RANK[open.worst]) {
    open.worst = rec.s;
  }
  return s;
}

// 接口缓存几秒：卡在下一轮结果最早写进来的时刻过期；到点了还没等到，10 秒后再问
export function maxAge(checkedAt, now) {
  return Math.max(10, checkedAt + PERIOD + MIN_RUN - now);
}

// 页面要的数据：近 DAYS 天逐天补齐，没数据的天给 null
export function view(state, now) {
  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const date = cstDate(now - i * 86400);
    const d = state.days[date];
    days.push(d
      ? { date, checks: d.checks, up: Math.round((d.ups / d.checks) * 1000) / 1000, worst: d.worst }
      : { date, checks: 0, up: null, worst: null });
  }
  const { last } = state;
  return {
    checked_at: last.t,
    status: last.s,
    ok: last.ok,
    total: last.total,
    list_modified: last.list_modified ?? null,
    first_check: state.first_check,
    machines: last.machines ?? [],
    days,
    incidents: state.incidents,
  };
}
