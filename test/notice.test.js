// 游戏内停服公告解析的自检：npm test（等于 node --test）
import assert from "node:assert/strict";
import { test } from "node:test";
import { coveringNotice, isPlanned, liveNotices, parseStopTime, stopPosts } from "../src/notice.js";

const cst = (iso) => Date.parse(`${iso}+08:00`) / 1000;

// 2026-11-05 那条临时停服公告的正文开头，原样保留：字符串里直接夹着换行
const REAL_BODY = `[
  {
    "type": 1,
    "text": "游侠亲启：

由于服务器故障，导致部分玩法无法正常体验的异常问题，十六巷决定对《燕云十六声》进行临时停服维护。
停服维护将于11月5日18:30开始，停服维护期间，游侠将暂时无法登录游戏。
"
  }
]`;

test("只挑标题带「停服」又不是「不停服」的公告", () => {
  const index = [
    { post_name: "a", post_title: "11月5日临时停服公告" },
    { post_name: "b", post_title: "10月30日2.9.0B版本更新公告" },
    { post_name: "c", post_title: "10月31日在线修复公告" },
    { post_name: "d", post_title: "11月7日不停服维护公告" },
    { post_name: "e", post_title: "停服维护公告丨明天，移动端不删档上线！" },
    { post_name: "f", post_title: "" },
    {},
  ];
  assert.deepEqual(stopPosts(index).map((p) => p.post_name), ["a", "e"]);
});

test("标题带「临时」「紧急」的是出了故障才决定的停服，其余是提前排好的停服维护", () => {
  assert.equal(isPlanned("11月5日临时停服公告"), false);
  assert.equal(isPlanned("紧急停服维护公告"), false);
  assert.equal(isPlanned("11月20日停服维护公告"), true);
  assert.equal(isPlanned("停服维护公告丨明天，移动端不删档上线！"), true);
});

test("官方正文不是合法 JSON，按纯文字也能读出开始时间", () => {
  assert.throws(() => JSON.parse(REAL_BODY));
  assert.deepEqual(parseStopTime(REAL_BODY, cst("2026-11-05T10:27:00")), { start: cst("2026-11-05T18:30:00"), end: null });
});

test("各种写法的停服时间", () => {
  const now = cst("2026-11-05T10:00:00");
  const at = (text, ref = now) => parseStopTime(text, ref);
  assert.deepEqual(at("计划于2026年1月8日06:00:00~10:00:00进行停服维护"), {
    start: cst("2026-01-08T06:00:00"),
    end: cst("2026-01-08T10:00:00"),
  });
  assert.deepEqual(at("11月6日6:00-12:00停服"), { start: cst("2026-11-06T06:00:00"), end: cst("2026-11-06T12:00:00") });
  assert.deepEqual(at("11月6日23:00～01:00"), { start: cst("2026-11-06T23:00:00"), end: cst("2026-11-07T01:00:00") }, "跨过半夜");
  assert.equal(at("近期将进行停服维护，具体时间另行通知"), null);
});

test("没写年份的取离现在最近的那一年", () => {
  const dec30 = cst("2026-12-30T12:00:00");
  assert.deepEqual(parseStopTime("1月2日6:00至10:00", dec30), {
    start: cst("2027-01-02T06:00:00"),
    end: cst("2027-01-02T10:00:00"),
  });
  assert.deepEqual(parseStopTime("12月31日22:00-1月1日2:00", dec30), {
    start: cst("2026-12-31T22:00:00"),
    end: cst("2027-01-01T02:00:00"),
  });
  assert.equal(parseStopTime("12月28日6:00", cst("2027-01-03T12:00:00")).start, cst("2026-12-28T06:00:00"));
});

test("公告管的时间段：开始前半小时起，到结束为止；没写结束就管一天", () => {
  const start = cst("2026-11-05T18:30:00");
  const open = { title: "临时停服", start, end: null };
  const fixed = { title: "停服维护", start, end: cst("2026-11-05T22:00:00") };
  assert.equal(coveringNotice([open], start - 30 * 60), open);
  assert.equal(coveringNotice([open], start - 31 * 60), null);
  assert.equal(coveringNotice([open], start + 86400), open);
  assert.equal(coveringNotice([open], start + 86401), null);
  assert.equal(coveringNotice([fixed], fixed.end), fixed);
  assert.equal(coveringNotice([fixed], fixed.end + 1), null);
  assert.deepEqual(liveNotices([open, fixed], fixed.end), [open]);
});
