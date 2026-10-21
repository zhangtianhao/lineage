import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'mocha';

import { parseLinePorcelain } from '../../blameParser';
import { GitError, runBlame } from '../../git';

/** 真跑 git 子进程的集成测试：git init 的耗时远超 mocha 默认 2s 超时。 */
function git(args: string[], cwd: string): void {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('runBlame', function () {
    this.timeout(10_000);

    let repoDir: string;
    let plainDir: string;

    before(() => {
        repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-git-repo-'));
        plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-git-plain-'));
        // 仓库级身份配置：不依赖机器的全局 git config，测试才可复现
        git(['init'], repoDir);
        git(['config', 'user.name', 'Lineage Test'], repoDir);
        git(['config', 'user.email', 'lineage-test@example.com'], repoDir);
        fs.writeFileSync(path.join(repoDir, 'a.txt'), 'line1\n');
        git(['add', 'a.txt'], repoDir);
        // 全局配置可能强制 gpgsign 或挂载 pre-commit 钩子，逐项关闭保证测试在任何机器可复现
        git(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init'], repoDir);
    });

    after(() => {
        fs.rmSync(repoDir, { recursive: true, force: true });
        fs.rmSync(plainDir, { recursive: true, force: true });
    });

    it('--contents 传入修改后内容：改动行与新增行报告为未提交', async () => {
        const file = path.join(repoDir, 'a.txt');
        // line1 保持已提交内容，line2 为新增：两种行同时验证
        const out = await runBlame(file, 'line1\nline2\n');
        const lines = parseLinePorcelain(out);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].uncommitted, false);
        assert.equal(lines[0].author, 'Lineage Test');
        assert.equal(lines[1].uncommitted, true);
    });

    it('非 git 目录：拒绝 GitError', async () => {
        const file = path.join(plainDir, 'b.txt');
        fs.writeFileSync(file, 'x\n');
        await assert.rejects(
            () => runBlame(file, 'x\n'),
            (e: unknown): boolean => {
                assert.ok(e instanceof GitError);
                return true;
            },
        );
    });

    it('cwd 不存在：直接拒绝 GitError，不启动 git', async () => {
        const file = path.join(repoDir, 'no-such-dir', 'c.txt');
        await assert.rejects(
            () => runBlame(file, 'x\n'),
            (e: unknown): boolean => {
                assert.ok(e instanceof GitError);
                assert.match((e as Error).message, /工作目录不存在/);
                return true;
            },
        );
    });
});
