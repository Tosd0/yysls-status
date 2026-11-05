// 判定规则的自检：npm test（等于 node --test）
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, cstDate, DAYS, parseList, record, view } from "../src/logic.js";

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
