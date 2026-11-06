// 判定规则的自检：npm test（等于 node --test）
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, cstDate, DAYS, drainingList, maxAge, parseList, pickList, record, view } from "../src/logic.js";

const SAMPLE = `\
正式区 1001 10001 5 3 0 正式大服大世界服1 45.253.181.184:10400:12:1 12001 h72-ms-prod.netease.com 1
正式区 1001 10001 5 3 0 正式大服单人服10 223.252.222.175:10200:12:1 10010 h72-ms-prod.netease.com 1
正式区 1001 10001 5 3 0 正式大服单人服2 123.58.168.21:10400:12:1 10002 h72-ms-prod.netease.com 1
正式区 1001 10001 5 3 0 正式大服单人服2 123.58.168.21:11800:12:1 10002 h72-ms-prod.netease.com 1
坏掉的一行
`;

// 北京时间的某一刻 → 秒级时间戳
const cst = (iso) => Date.parse(`${iso}+08:00`) / 1000;
const fold = (recs) => recs.reduce((s, [t, st]) => record(s, { t, s: st, ok: 0, total: 65 }), null);

test("解析列表：同一台服务器去重、只留第一个端口、单人服在前按编号排", () => {
  const ms = parseList(SAMPLE);
  assert.deepEqual(ms.map((m) => m.name), ["正式大服单人服2", "正式大服单人服10", "正式大服大世界服1"]);
  assert.deepEqual(ms[0], { name: "正式大服单人服2", ip: "123.58.168.21", port: 10400 });
});

test("判定阈值", () => {
  assert.equal(classify(65, 65), "up");
  assert.equal(classify(59, 65), "up"); // 59/65 ≈ 0.908
  assert.equal(classify(58, 65), "partial");
  assert.equal(classify(0, 65), "down");
  assert.equal(classify(0, 0), "unknown");
});

test("按北京时间分天", () => {
  assert.equal(cstDate(cst("2026-11-05T00:30:00")), "2026-11-05");
  assert.equal(cstDate(cst("2026-11-04T23:59:00")), "2026-11-04");
});

test("事件：连续不正常合成一次，检测失败不打断，恢复时记结束时间", () => {
  const s = fold([[1, "up"], [2, "partial"], [3, "down"], [4, "unknown"], [5, "up"], [6, "partial"]]);
  assert.deepEqual(s.incidents, [
    { start: 6, end: null, worst: "partial" },
    { start: 2, end: 5, worst: "down" },
  ]);
  assert.equal(s.first_check, 1);
  assert.equal(s.last.t, 6);
  assert.deepEqual(fold([[1, "up"]]).incidents, []);
});

test("按天统计：检测失败不计数，超过 30 天的天删掉", () => {
  let s = fold([
    [cst("2026-11-05T00:30:00"), "up"],
    [cst("2026-11-05T19:00:00"), "down"],
    [cst("2026-11-05T20:00:00"), "unknown"],
  ]);
  assert.deepEqual(s.days["2026-11-05"], { checks: 2, ups: 1, worst: "down" });
  s = record(s, { t: cst("2026-12-10T12:00:00"), s: "up", ok: 65, total: 65 });
  assert.deepEqual(Object.keys(s.days), ["2026-12-10"]);
});

test("页面数据：近 30 天逐天补齐，最后一天是今天", () => {
  const s = fold([[cst("2026-11-05T00:30:00"), "up"], [cst("2026-11-05T19:00:00"), "down"]]);
  const v = view(s, cst("2026-11-05T23:00:00"));
  assert.equal(v.days.length, DAYS);
  assert.deepEqual(v.days.at(-1), { date: "2026-11-05", checks: 2, up: 0.5, worst: "down" });
  assert.deepEqual(v.days.at(-2), { date: "2026-11-04", checks: 0, up: null, worst: null });
  assert.equal(v.status, "down");
  assert.deepEqual(v.machines, []);
});

test("接口缓存卡在下一轮结果最早写进来时过期，到点没等到就 10 秒后再问", () => {
  assert.equal(maxAge(1000, 1000), 185); // 刚检测完：缓存到上次检测后 3 分 05 秒
  assert.equal(maxAge(1000, 1150), 35);
  assert.equal(maxAge(1000, 1185), 10); // 到点了还是旧数据
  assert.equal(maxAge(1000, 9000), 10); // 检测停了很久也不会缓存太久
});

const STOP = { title: "11月5日停服维护公告", planned: true, start: cst("2026-11-05T18:30:00"), end: null };
const URGENT = { ...STOP, title: "11月5日临时停服公告", planned: false };
const at = (state, iso, s, notices) => record(state, { t: cst(iso), s, ok: 0, total: 65, notices });

test("停服维护：连不上又有停服公告罩着，算停服维护，可用率照样扣", () => {
  let s = at(null, "2026-11-05T18:00:00", "up", [STOP]);
  s = at(s, "2026-11-05T18:15:00", "partial", null); // 开始前半小时内就算，公告没读到就沿用上一次的
  assert.equal(s.last.s, "maintenance");
  s = at(s, "2026-11-05T18:30:00", "down", [STOP]);
  assert.equal(s.last.s, "maintenance");
  assert.deepEqual(s.incidents, [{ start: cst("2026-11-05T18:15:00"), end: null, worst: "maintenance", notice: STOP }]);
  assert.deepEqual(s.days["2026-11-05"], { checks: 3, ups: 1, worst: "maintenance" });
});

test("停服维护一直算到恢复，之后再连不上、公告也过期了就是停服", () => {
  let s = at(null, "2026-11-05T19:00:00", "down", [STOP]);
  s = at(s, "2026-11-07T19:00:00", "down", [STOP]); // 公告只管一天，但事件挂着公告
  assert.equal(s.last.s, "maintenance");
  s = at(s, "2026-11-07T19:03:00", "up", [STOP]);
  s = at(s, "2026-11-07T20:00:00", "down", [STOP]);
  assert.equal(s.last.s, "down");
  assert.deepEqual(s.incidents[0], { start: cst("2026-11-07T20:00:00"), end: null, worst: "down" });
});

test("临时、紧急停服：公告挂到事件上，但照样算停服", () => {
  let s = at(null, "2026-11-05T18:30:00", "down", [URGENT]);
  s = at(s, "2026-11-05T18:33:00", "partial", [URGENT]);
  assert.equal(s.last.s, "partial");
  assert.deepEqual(s.last.notice, URGENT);
  assert.deepEqual(s.incidents, [{ start: cst("2026-11-05T18:30:00"), end: null, worst: "down", notice: URGENT }]);
  assert.deepEqual(s.days["2026-11-05"], { checks: 2, ups: 0, worst: "down" });
});

test("先连不上、后发停服公告：整次事件挂上公告，最差状态还是停服", () => {
  let s = at(null, "2026-11-05T17:00:00", "down", []);
  assert.equal(s.last.s, "down");
  s = at(s, "2026-11-05T18:30:00", "down", [STOP]);
  assert.equal(s.last.s, "maintenance");
  assert.deepEqual(s.incidents, [{ start: cst("2026-11-05T17:00:00"), end: null, worst: "down", notice: STOP }]);
});

test("当天既有停服维护又有意外停服，柱子按停服算", () => {
  let s = at(null, "2026-11-05T19:00:00", "down", [STOP]);
  s = at(s, "2026-11-05T20:00:00", "up", [STOP]);
  assert.equal(s.days["2026-11-05"].worst, "maintenance");
  s = at(s, "2026-11-06T08:00:00", "down", []); // 换了一天，公告列表里也没有停服公告了
  s = at(s, "2026-11-06T09:00:00", "up", []);
  s = at(s, "2026-11-06T10:00:00", "partial", [{ ...STOP, start: cst("2026-11-06T10:00:00") }]);
  assert.equal(s.days["2026-11-06"].worst, "down");
});

test("页面数据：只给还没过期的停服公告，事件没挂公告的给 null", () => {
  const later = { title: "11月20日停服维护公告", planned: true, start: cst("2026-11-20T06:00:00"), end: cst("2026-11-20T10:00:00") };
  let s = at(null, "2026-11-05T17:00:00", "down", []);
  s = at(s, "2026-11-05T17:03:00", "up", [STOP, later]);
  assert.deepEqual(view(s, cst("2026-11-06T12:00:00")).notices, [STOP, later]);
  assert.deepEqual(view(s, cst("2026-11-07T12:00:00")).notices, [later]);
  assert.equal(view(s, cst("2026-11-07T12:00:00")).incidents[0].notice, null);
});

// 2026-11-06 那次不停服维护：公告写 05:10～10:00，10:01 从 B 列表换到 A 列表（新服务器开放）
const ONLINE = { title: "11月6日2.9.5A版本更新公告", planned: true, online: true, start: cst("2026-11-06T05:10:00"), end: cst("2026-11-06T10:00:00") };
const OLD = "b";
const NEW = "a";
const atv = (state, iso, s, list, notices = [ONLINE], old) => record(state, { t: cst(iso), s, ok: 65, total: 65, notices, list, old });

test("不停服维护：公告写的开始时间起算，一换服就结束，可用率不扣", () => {
  let s = atv(null, "2026-11-06T05:00:00", "up", OLD);
  assert.equal(s.last.s, "up"); // 还没到公告写的开始时间
  s = atv(s, "2026-11-06T05:12:00", "up", OLD);
  assert.equal(s.last.s, "limited");
  s = atv(s, "2026-11-06T10:00:00", "up", null); // 没给列表，沿用上一次的
  assert.equal(s.last.s, "limited");
  s = atv(s, "2026-11-06T10:01:00", "up", NEW);
  assert.equal(s.last.s, "up");
  assert.deepEqual(s.incidents, [{ start: ONLINE.start, end: cst("2026-11-06T10:01:00"), worst: "limited", notice: ONLINE, list: OLD }]);
  assert.deepEqual(s.days["2026-11-06"], { checks: 4, ups: 4, worst: "limited" });
  s = atv(s, "2026-11-06T10:03:00", "up", NEW); // 同一条公告不会再算一次
  assert.equal(s.last.s, "up");
  assert.equal(view(s, cst("2026-11-06T10:04:00")).incidents[0].list, undefined);
});

test("不停服维护：过了结束时间也可能还没换服，晚多久都等；一直不换的 12 小时后收掉", () => {
  let s = atv(null, "2026-11-06T05:12:00", "up", OLD);
  s = atv(s, "2026-11-06T11:30:00", "up", OLD, []); // 公告已经从列表撤了也照样算
  assert.equal(s.last.s, "limited");
  s = atv(s, "2026-11-06T22:01:00", "up", OLD);
  assert.equal(s.last.s, "up");
  assert.equal(s.incidents[0].end, cst("2026-11-06T22:01:00"));
});

test("不停服维护期间连不上：照常按异常算，不会被当成停服维护；恢复后接着算不停服维护", () => {
  let s = atv(null, "2026-11-06T05:12:00", "up", OLD);
  s = atv(s, "2026-11-06T06:00:00", "down", OLD);
  assert.equal(s.last.s, "down");
  s = atv(s, "2026-11-06T06:03:00", "up", OLD);
  assert.equal(s.last.s, "limited");
  assert.equal(s.incidents.length, 1);
  assert.equal(s.incidents[0].worst, "down");
});

test("服务器列表跟着客户端选：client_switch 1 用 A、2 用 B，读不到沿用上一次的", () => {
  // 2026-11-06 换版本：client_switch 2 → 1，B 那批旧服务器随后关掉，测 B 会把正常报成全部连不上
  assert.equal(pickList(2, undefined), "b");
  assert.equal(pickList(1, "b"), "a");
  assert.equal(pickList(undefined, "a"), "a");
  assert.equal(pickList(3, "a"), "a");
  assert.equal(pickList(undefined, undefined), "b");
});

test("换服：切列表记一笔，旧的那批全部连不上记为关完；不影响状态和可用率", () => {
  let s = atv(null, "2026-11-06T09:58:00", "up", "b", []);
  assert.equal(drainingList(s, "b"), null);
  assert.equal(drainingList(s, "a"), "b"); // 这一轮刚切过去，顺带测旧的
  s = atv(s, "2026-11-06T10:03:00", "up", "a", [], { ok: 65, total: 65 });
  assert.deepEqual(s.switches, [{ start: cst("2026-11-06T10:03:00"), end: null, from: "b", to: "a" }]);
  assert.equal(drainingList(s, "a"), "b");
  s = atv(s, "2026-11-06T10:24:00", "up", "a", [], { ok: 30, total: 65 });
  s = atv(s, "2026-11-06T10:27:00", "up", "a", [], { ok: 0, total: 0 }); // 旧列表没拉到，不算关完
  assert.equal(s.switches[0].end, null);
  s = atv(s, "2026-11-06T10:30:00", "up", "a", [], { ok: 0, total: 65 });
  assert.equal(s.switches[0].end, cst("2026-11-06T10:30:00"));
  assert.equal(drainingList(s, "a"), null);
  assert.deepEqual(s.incidents, []);
  assert.deepEqual(s.days["2026-11-06"], { checks: 5, ups: 5, worst: "up" });
  assert.equal(view(s, cst("2026-11-06T10:31:00")).switches.length, 1);
});

test("换服：旧的 3 小时还没关完就不再跟着测，标成没关完", () => {
  let s = atv(null, "2026-11-06T09:58:00", "up", "b", []);
  s = atv(s, "2026-11-06T10:03:00", "up", "a", [], { ok: 65, total: 65 });
  s = atv(s, "2026-11-06T13:04:00", "up", "a", [], { ok: 10, total: 65 });
  assert.deepEqual(s.switches[0], { start: cst("2026-11-06T10:03:00"), end: cst("2026-11-06T13:04:00"), from: "b", to: "a", unclosed: true });
  assert.equal(drainingList(s, "a"), null);
});
