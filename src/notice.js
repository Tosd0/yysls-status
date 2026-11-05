// 游戏内公告（客户端登录界面读的那份）：挑出停服公告，从正文里读出停服时间。纯函数，Worker 和测试共用

const CST_S = 8 * 3600;
const EARLY = 30 * 60; // 服务器可能比公告写的时间早一点关
const NO_END = 24 * 3600; // 公告没写结束时间时，从开始算这么久

// 第一处「[YYYY年]M月D日 H:MM[:SS]」是开始，紧跟着「~ [M月D日] H:MM」的是结束
// shortcut: 只认第一处时间和紧挨着的结束时间，「预计至…结束」「顺延至…」这类写法不认；真出现了再加
const TIME =
  /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[:：](\d{2})(?:[:：]\d{2})?(?:\s*[-~～至到—–]+\s*(?:(\d{1,2})月(\d{1,2})日)?\s*(\d{1,2})[:：](\d{2}))?/;

const cstUnix = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) / 1000 - CST_S;

// 公告里多半不写年份，取离 ref 最近的那一年，跨年前后也不会错
function nearest(y, mo, d, h, mi, ref) {
  if (y) return cstUnix(y, mo, d, h, mi);
  const year = new Date((ref + CST_S) * 1000).getUTCFullYear();
  const options = [year - 1, year, year + 1].map((yy) => cstUnix(yy, mo, d, h, mi));
  return options.reduce((a, b) => (Math.abs(b - ref) < Math.abs(a - ref) ? b : a));
}

// 标题带「停服」又不是「不停服」的才是停服公告；在线修复、版本更新这些维护期间照常能登录
export const stopPosts = (index) =>
  index.filter((p) => p.post_title?.includes("停服") && !p.post_title.includes("不停服"));

// 标题带「临时」「紧急」的是出了故障才决定的停服，照样算停服；其余的是提前排好的停服维护
export const isPlanned = (title) => !/临时|紧急/.test(title);

// 正文原样传进来：官方的正文字符串里直接夹着换行，不是合法 JSON，按纯文字找时间
export function parseStopTime(text, now) {
  const m = text.match(TIME);
  if (!m) return null;
  const [, y, mo, d, h, mi, mo2, d2, h2, mi2] = m;
  const start = nearest(y, mo, d, h, mi, now);
  let end = null;
  if (h2 !== undefined) {
    end = nearest(undefined, mo2 ?? mo, d2 ?? d, h2, mi2, start);
    if (end <= start) end += 86400; // 只写了钟点、跨过了半夜
  }
  return { start, end };
}

// 公告管到什么时候：写了结束时间就到结束，没写就从开始算一天
const until = (n) => n.end ?? n.start + NO_END;

// t 这一刻罩着它的停服公告，没有就是 null
export const coveringNotice = (notices, t) =>
  notices.find((n) => t >= n.start - EARLY && t <= until(n)) ?? null;

// 还没过期的停服公告，页面拿来提前预告
export const liveNotices = (notices, now) => notices.filter((n) => until(n) > now);
