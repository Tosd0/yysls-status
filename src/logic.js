// 判定规则和状态累积：纯函数，Worker 和测试共用
import { coveringNotice, liveNotices, until } from "./notice.js";

export const OK_RATIO = 0.9; // 能连上的比例不低于这个算正常
export const DAYS = 30;
export const MAX_INCIDENTS = 20;
export const PERIOD = 180; // 和 wrangler.toml 里的 cron 一致，每 3 分钟检测一次
// 服务器都连得上时一轮几秒就写进 KV；有连不上的要等超时，会晚到 20 秒左右，那段靠 10 秒重试补上
const MIN_RUN = 5;
const RANK = { up: 0, limited: 1, partial: 2, maintenance: 3, down: 4 };
// 过了公告写的结束时间这么久还没换服，就当这次不停服维护不换服，到点收掉
const LIMITED_MAX = 12 * 3600;
// 换服后旧的那批这么久还没关完就不再跟着测了
const DRAIN_MAX = 3 * 3600;
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

// 客户端按版本入口里的 client_switch 选列表：1 用 A，2 用 B（客户端日志里 2 时记着不用 A）。读不到或是没见过的值，沿用上一次的
export const pickList = (clientSwitch, prev) => ({ 1: "a", 2: "b" })[clientSwitch] ?? prev ?? "b";

// 这一轮要不要顺带测旧的那批：刚换服，或者上次换服后旧的还没关完。返回旧列表名，不用测给 null
export function drainingList(state, list) {
  const sw = state?.switches?.[0];
  if (sw?.end === null) return sw.from;
  const before = state?.last?.list;
  return before && before !== list ? before : null;
}

export function classify(ok, total) {
  if (total === 0) return "unknown"; // 列表都没拉到，说不清
  if (ok === 0) return "down";
  return ok / total >= OK_RATIO ? "up" : "partial";
}

export const cstDate = (t) => new Date(t * 1000 + CST_MS).toISOString().slice(0, 10);

// 把一次检测并进状态：按北京时间分天计数，连续不正常合成一次事件。检测失败的那次只更新 last，不计数也不打断事件
// rec.notices 是这次读到的公告，没读到（null）沿用上一次的；rec.list 是这次测的那份服务器列表（a / b），
// rec.old 是换服后顺带测的旧列表 { ok, total }
export function record(state, rec) {
  const s = state ? structuredClone(state) : { first_check: rec.t, days: {}, incidents: [] };
  const open = s.incidents[0]?.end === null ? s.incidents[0] : null;
  rec = { ...rec, notices: rec.notices ?? s.last?.notices ?? [], list: rec.list ?? s.last?.list ?? null };

  // 换服：列表从一份切到另一份记一笔，旧的那批测到全部连不上就是关完了。单独记，不影响状态和可用率
  s.switches ??= [];
  const before = s.last?.list;
  const sw = s.switches[0]?.end === null ? s.switches[0] : null;
  if (before && rec.list && rec.list !== before) {
    if (sw) Object.assign(sw, { end: rec.t, unclosed: true }); // 旧的还没关完又切了一次
    s.switches = [{ start: rec.t, end: null, from: before, to: rec.list }, ...s.switches].slice(0, MAX_INCIDENTS);
  } else if (sw && rec.old?.total && rec.old.ok === 0) {
    sw.end = rec.t;
  } else if (sw && rec.t - sw.start > DRAIN_MAX) {
    Object.assign(sw, { end: rec.t, unclosed: true });
  }

  if (rec.s === "partial" || rec.s === "down") {
    // 连不上时有官方停服公告罩着就挂上公告：提前排好的算停服维护，临时、紧急的照样算停服。
    // 事件挂上公告后一直沿用到恢复，公告写的时间过了也不会变
    const notice = (open?.notice?.online ? null : open?.notice) ?? coveringNotice(rec.notices, rec.t);
    if (notice) rec = { ...rec, s: notice.planned ? "maintenance" : rec.s, notice };
  } else if (rec.s === "up") {
    // 不停服维护：从公告写的开始时间起，到换服为止（维护完了才开新服务器、放新版本）。同一条公告只算一次
    const live = open?.notice?.online ? open : null;
    const seen = (n) => s.incidents.some((i) => i.notice?.online && i.notice.start === n.start && i.notice.title === n.title);
    const notice = live?.notice ??
      (!open && rec.notices.find((n) => n.online && rec.t >= n.start && rec.t <= until(n) && !seen(n)));
    if (notice && (!live || live.list === rec.list) && rec.t <= until(notice) + LIMITED_MAX) {
      rec = { ...rec, s: "limited", notice };
    }
  }
  s.last = rec;
  if (rec.s === "unknown") return s;

  const day = (s.days[cstDate(rec.t)] ??= { checks: 0, ups: 0, worst: "up" });
  day.checks++;
  if (rec.s === "up" || rec.s === "limited") day.ups++; // 不停服维护照常能登录
  if (RANK[rec.s] > RANK[day.worst]) day.worst = rec.s;
  const oldest = cstDate(rec.t - (DAYS - 1) * 86400);
  for (const d of Object.keys(s.days)) if (d < oldest) delete s.days[d];

  if (rec.s === "up") {
    if (open) open.end = rec.t;
  } else if (!open) {
    // 不停服维护从外面测不出开始，按公告写的时间；记下当时用的哪份列表，换了就是维护完
    const incident = rec.s === "limited"
      ? { start: Math.max(rec.notice.start, s.first_check), end: null, worst: rec.s, notice: rec.notice, list: rec.list }
      : { start: rec.t, end: null, worst: rec.s, ...(rec.notice && { notice: rec.notice }) };
    s.incidents = [incident, ...s.incidents].slice(0, MAX_INCIDENTS);
  } else {
    if (RANK[rec.s] > RANK[open.worst]) open.worst = rec.s;
    if (rec.notice && !open.notice) open.notice = rec.notice; // 先连不上、后发公告的，公告也挂到整次事件上
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
    notices: liveNotices(last.notices ?? [], now),
    days,
    incidents: state.incidents.map(({ list, ...i }) => ({ ...i, notice: i.notice ?? null })),
    switches: state.switches ?? [],
  };
}
