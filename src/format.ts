import { BlameLine } from './blameParser';

// 本模块与 blameParser.ts 一样禁止 import vscode：它们要在普通 Node 环境下被 mocha 直接测试

export const ANNOTATION_WIDTH = 50;
const AUTHOR_COL = 12;
const DATE_COL = 10;
const SUMMARY_COL = 24;
const COL_GAP = 2;
// 12 + 2 + 10 + 2 + 24 = ANNOTATION_WIDTH

// decoration 的 contentText 会被注入 DOM 渲染，普通空格序列会被 HTML 折叠；
// NBSP 不折叠，才能保住列宽
const NBSP = '\u00A0';

/** 省略号在多数等宽字体中与半角字符同宽，按 1 列计。 */
const ELLIPSIS = '…';

/** 东亚宽字符（含全角标点）按 2 列计。覆盖 CJK、韩文、全角形式等常用范围。 */
function isWide(cp: number): boolean {
    return (
        (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x20000 && cp <= 0x3fffd)
    );
}

export function displayWidth(s: string): number {
    let width = 0;
    // for...of 按码点迭代，代理对（如 U+20000 以上的字符）才不会拆成两个半宽
    for (const ch of s) {
        width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    }
    return width;
}

/** 超宽则截断并以省略号结尾（省略号占 1 列），结果宽度不超过 width。 */
export function fitToWidth(s: string, width: number): string {
    if (displayWidth(s) <= width) {
        return s;
    }
    const limit = width - displayWidth(ELLIPSIS);
    let out = '';
    let widthSoFar = 0;
    for (const ch of s) {
        const charWidth = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
        if (widthSoFar + charWidth > limit) {
            break;
        }
        out += ch;
        widthSoFar += charWidth;
    }
    // 尾部空白紧贴省略号会显得"悬空"，先去掉再拼
    return out.trimEnd() + ELLIPSIS;
}

function padRight(s: string, width: number): string {
    let out = s;
    while (displayWidth(out) < width) {
        out += NBSP;
    }
    return out;
}

/** 内容中的空格换成 NBSP：单个空格虽不会折叠，但与尾部 NBSP 补齐相连时统一字形更稳。 */
function sanitizeSpaces(s: string): string {
    return s.replace(/ /g, NBSP);
}

/** ±HHMM 形式的时区字符串转为毫秒偏移。 */
function tzOffsetMs(tz: string): number {
    const sign = tz.startsWith('-') ? -1 : 1;
    const hh = Number.parseInt(tz.slice(1, 3), 10);
    const mm = Number.parseInt(tz.slice(3, 5), 10);
    return sign * (hh * 60 + mm) * 60_000;
}

function twoDigits(n: number): string {
    return `${n}`.padStart(2, '0');
}

// 按作者时区换算后再用 getUTC* 读取：结果与运行环境的本地时区无关，测试才可复现
function shifted(epochSec: number, tz: string): Date {
    return new Date(epochSec * 1000 + tzOffsetMs(tz));
}

export function formatDate(epochSec: number, tz: string): string {
    const d = shifted(epochSec, tz);
    return `${d.getUTCFullYear()}/${twoDigits(d.getUTCMonth() + 1)}/${twoDigits(d.getUTCDate())}`;
}

export function formatDateTime(epochSec: number, tz: string): string {
    const d = shifted(epochSec, tz);
    return `${formatDate(epochSec, tz)} ${twoDigits(d.getUTCHours())}:${twoDigits(
        d.getUTCMinutes(),
    )}:${twoDigits(d.getUTCSeconds())} ${tz}`;
}

/** 逐行注释：作者(12) 日期(10) 摘要(24)，列间 2 个 NBSP，各列右侧补 NBSP，总宽恒为 ANNOTATION_WIDTH。 */
export function formatAnnotation(b: BlameLine): string {
    if (b.uncommitted) {
        // 作者列固定显示"未提交"，不照抄 git 的 Not Committed Yet 文案
        return padRight(sanitizeSpaces('未提交'), ANNOTATION_WIDTH);
    }
    const author = padRight(sanitizeSpaces(fitToWidth(b.author, AUTHOR_COL)), AUTHOR_COL);
    const date = padRight(formatDate(b.authorTime, b.authorTz), DATE_COL);
    const summary = padRight(sanitizeSpaces(fitToWidth(b.summary, SUMMARY_COL)), SUMMARY_COL);
    return author + NBSP.repeat(COL_GAP) + date + NBSP.repeat(COL_GAP) + summary;
}

export function shortSha(sha: string): string {
    return sha.slice(0, 7);
}
