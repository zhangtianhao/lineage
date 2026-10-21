import assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import {
    ANNOTATION_WIDTH,
    displayWidth,
    fitToWidth,
    formatAnnotation,
    formatDate,
    formatDateTime,
    shortSha,
} from '../../format';
import { BlameLine } from '../../blameParser';

const SHA40 = '3e5e7c4b0c9f9b1a2d3e4f5a6b7c8d9e0f1a2b3c';

function makeLine(overrides: Partial<BlameLine> = {}): BlameLine {
    return {
        line: 0,
        sha: SHA40,
        author: 'Alice',
        authorMail: 'alice@example.com',
        authorTime: 1709619730,
        authorTz: '+0800',
        summary: 'Fix parser bug',
        uncommitted: false,
        ...overrides,
    };
}

describe('formatDate / formatDateTime', () => {
    it('formatDate 按作者时区计算', () => {
        assert.equal(formatDate(1709619730, '+0800'), '2024/03/05');
    });

    it('formatDate 负时区跨日边界', () => {
        // 2024-03-05T01:00:00Z，-0500 时区已退回到 03-04
        assert.equal(formatDate(1709600400, '-0500'), '2024/03/04');
    });

    it('formatDateTime 包含完整时分秒和时区', () => {
        assert.equal(formatDateTime(1709619730, '+0800'), '2024/03/05 14:22:10 +0800');
    });

    it('formatDate 与运行环境本地时区无关（+0000 与 -0000 一致）', () => {
        assert.equal(formatDate(1709619730, '+0000'), formatDate(1709619730, '-0000'));
    });
});

describe('displayWidth', () => {
    it('ASCII 字符按 1 计', () => {
        assert.equal(displayWidth('abc'), 3);
        assert.equal(displayWidth('a.b'), 3);
        assert.equal(displayWidth('a b'), 3);
    });

    it('中文字符按 2 计', () => {
        assert.equal(displayWidth('你好'), 4);
    });

    it('省略号按 1 列计', () => {
        assert.equal(displayWidth('…'), 1);
    });

    it('混合内容', () => {
        assert.equal(displayWidth('a你b'), 4);
    });
});

describe('fitToWidth', () => {
    it('未超宽原样返回', () => {
        assert.equal(fitToWidth('abcde', 5), 'abcde');
        assert.equal(fitToWidth('abc', 5), 'abc');
    });

    it('超宽 ASCII 截断加省略号，总宽恰为 width', () => {
        const out = fitToWidth('abcdefgh', 5);
        assert.equal(out, 'abcd…');
        assert.equal(displayWidth(out), 5);
    });

    it('宽字符序列截断：加省略号后不超出', () => {
        const out = fitToWidth('你好世界', 5);
        assert.equal(out, '你好…');
        assert.ok(displayWidth(out) <= 5);
    });

    it('截断位置落在空白上时先去除尾部空白再拼省略号', () => {
        assert.equal(fitToWidth('ab   ', 4), 'ab…');
    });
});

describe('formatAnnotation', () => {
    it('普通行：总宽恒为 ANNOTATION_WIDTH，三列内容齐全', () => {
        const out = formatAnnotation(makeLine());
        assert.equal(displayWidth(out), ANNOTATION_WIDTH);
        assert.ok(out.startsWith('Alice'), '作者列在前');
        assert.ok(out.includes('2024/03/05'), '日期列');
        assert.ok(out.includes('Fix' + '\u00A0' + 'parser' + '\u00A0' + 'bug'), '摘要列');
    });

    it('结果中不含普通空格（全部为 NBSP）', () => {
        const out = formatAnnotation(makeLine({ author: 'Zhang San' }));
        assert.ok(!out.includes(' '));
    });

    it('未提交行：以"未提交"开头并补齐到 ANNOTATION_WIDTH', () => {
        const out = formatAnnotation(makeLine({ uncommitted: true }));
        assert.ok(out.startsWith('未提交'));
        assert.equal(displayWidth(out), ANNOTATION_WIDTH);
        assert.ok(!out.includes(' '));
    });

    it('超长作者名在 12 列内截断', () => {
        const out = formatAnnotation(makeLine({ author: 'A'.repeat(20) }));
        const authorCol = out.slice(0, 12);
        assert.ok(authorCol.includes('…'));
        assert.ok(authorCol.startsWith('A'));
        assert.equal(displayWidth(out), ANNOTATION_WIDTH);
    });

    it('超长摘要按 24 列截断，总宽不变', () => {
        const out = formatAnnotation(makeLine({ summary: 'x'.repeat(60) }));
        // 摘要列起点：作者 12 + 间隔 2 + 日期 10 + 间隔 2 = 26（本用例各列均为单 code unit 字符，索引即列位）
        const summaryCol = out.slice(26);
        assert.ok(summaryCol.startsWith('x'));
        assert.ok(summaryCol.includes('…'));
        assert.equal(displayWidth(out), ANNOTATION_WIDTH);
    });

    it('普通行与截断行的字符数都恰为 ANNOTATION_WIDTH（全窄字符场景）', () => {
        const normal = formatAnnotation(makeLine());
        assert.equal(normal.length, ANNOTATION_WIDTH);
        const truncated = formatAnnotation(
            makeLine({ author: 'A'.repeat(20), summary: 'x'.repeat(60) }),
        );
        assert.equal(truncated.length, ANNOTATION_WIDTH);
    });
});

describe('shortSha', () => {
    it('shortSha 取前 7 位', () => {
        assert.equal(shortSha(SHA40), SHA40.slice(0, 7));
    });
});
