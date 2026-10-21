import assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { BlameParseError, parseLinePorcelain } from '../../blameParser';

const SHA40 = '3e5e7c4b0c9f9b1a2d3e4f5a6b7c8d9e0f1a2b3c';
const SHA64 = '3e5e7c4b0c9f9b1a2d3e4f5a6b7c8d9e0f1a2b3c0123456789abcdef01234567';
const SHA_ZERO = '0'.repeat(40);

// 构造一个完整块。groupSize 只出现在组首块的头行
function block(
    sha: string,
    orig: number,
    final: number,
    source: string,
    groupSize?: number,
): string {
    const head =
        groupSize === undefined ? `${sha} ${orig} ${final}` : `${sha} ${orig} ${final} ${groupSize}`;
    return [
        head,
        'author Alice',
        'author-mail <alice@example.com>',
        'author-time 1709619730',
        'author-tz +0800',
        'committer Alice',
        'committer-mail <alice@example.com>',
        'committer-time 1709619730',
        'committer-tz +0800',
        'summary Fix parser bug',
        'filename a.ts',
        `\t${source}`,
    ].join('\n');
}

const TWO_LINES = `${block(SHA40, 1, 1, 'const a = 1;', 2)}\n${block(SHA40, 2, 2, 'const b = 2;')}\n`;

describe('parseLinePorcelain', () => {
    it('空字符串返回空数组', () => {
        assert.deepEqual(parseLinePorcelain(''), []);
    });

    it('同一 commit 的连续两行：两条记录，line 分别为 0 和 1', () => {
        const lines = parseLinePorcelain(TWO_LINES);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].line, 0);
        assert.equal(lines[1].line, 1);
        assert.equal(lines[0].author, 'Alice');
        assert.equal(lines[0].summary, 'Fix parser bug');
        assert.equal(lines[1].author, 'Alice');
        assert.equal(lines[1].summary, 'Fix parser bug');
        assert.equal(lines[0].authorTime, 1709619730);
        assert.equal(lines[0].authorTz, '+0800');
    });

    it('未提交行（sha 全 0）uncommitted 为 true，判断不依赖作者文案', () => {
        const out = [
            `${SHA_ZERO} 1 1`,
            'author Not Committed Yet',
            'author-mail <not.committed.yet>',
            'author-time 1709619730',
            'author-tz +0800',
            'committer Not Committed Yet',
            'committer-mail <not.committed.yet>',
            'committer-time 1709619730',
            'committer-tz +0800',
            'summary Fix parser bug',
            'filename a.ts',
            '\tdraft',
        ].join('\n') + '\n';
        const lines = parseLinePorcelain(out);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].sha, SHA_ZERO);
        assert.equal(lines[0].uncommitted, true);
    });

    it('包含 previous 和 boundary（无值）行时忽略它们，不报错', () => {
        const out = [
            `${SHA40} 1 1`,
            'author Alice',
            'author-mail <alice@example.com>',
            'author-time 1709619730',
            'author-tz +0800',
            'committer Alice',
            'committer-mail <alice@example.com>',
            'committer-time 1709619730',
            'committer-tz +0800',
            'summary Fix parser bug',
            `previous ${SHA40} a.ts`,
            'boundary',
            'filename a.ts',
            '\tconst a = 1;',
        ].join('\n') + '\n';
        const lines = parseLinePorcelain(out);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].author, 'Alice');
        assert.equal(lines[0].summary, 'Fix parser bug');
    });

    it('源码内容形如头行或 key 行（\\tauthor x、\\t<sha> 1 1）时不被误判', () => {
        const out = [
            block(SHA40, 1, 1, 'author x'),
            block(SHA40, 2, 2, `${SHA40} 1 1`),
        ].join('\n') + '\n';
        const lines = parseLinePorcelain(out);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].line, 0);
        assert.equal(lines[1].line, 1);
        assert.equal(lines[0].author, 'Alice');
        assert.equal(lines[1].author, 'Alice');
    });

    it('源码为空行（只有 \\t）时正常结束该块', () => {
        const out = `${block(SHA40, 1, 1, '')}\n`;
        const lines = parseLinePorcelain(out);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].summary, 'Fix parser bug');
    });

    it('64 位 sha（SHA-256 仓库）正常解析', () => {
        const lines = parseLinePorcelain(`${block(SHA64, 1, 1, 'code')}\n`);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].sha, SHA64);
        assert.equal(lines[0].uncommitted, false);
    });

    it('空 summary（summary 后无内容）解析为空字符串', () => {
        const out = [
            `${SHA40} 1 1`,
            'author Alice',
            'author-mail <alice@example.com>',
            'author-time 1709619730',
            'author-tz +0800',
            'committer Alice',
            'committer-mail <alice@example.com>',
            'committer-time 1709619730',
            'committer-tz +0800',
            'summary ',
            'filename a.ts',
            '\tconst a = 1;',
        ].join('\n') + '\n';
        const lines = parseLinePorcelain(out);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].summary, '');
    });

    it('头行格式错误时抛出包含行号的异常', () => {
        assert.throws(
            () => parseLinePorcelain('garbage line\n'),
            (err: unknown): boolean => {
                assert.ok(err instanceof BlameParseError);
                assert.match(err.message, /第 1 行/);
                return true;
            },
        );
    });

    it('输出被截断（缺少源码行）时抛出异常', () => {
        const out = [`${SHA40} 1 1`, 'author Alice'].join('\n');
        assert.throws(
            () => parseLinePorcelain(out),
            (err: unknown): boolean => {
                assert.ok(err instanceof BlameParseError);
                assert.match(err.message, /截断/);
                return true;
            },
        );
    });

    it('author-mail 去掉尖括号', () => {
        const lines = parseLinePorcelain(`${block(SHA40, 1, 1, 'x')}\n`);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].authorMail, 'alice@example.com');
    });
});
