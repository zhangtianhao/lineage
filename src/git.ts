import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** git 调用失败。code 为 'ENOENT' 表示系统未安装 git；其余情况携带 stderr。 */
export class GitError extends Error {
    constructor(message: string, readonly code?: string | number, readonly stderr?: string) {
        super(message);
        this.name = 'GitError';
    }
}

export function execGit(args: string[], cwd: string, stdin?: string): Promise<string> {
    // cwd 不存在时 git 自身的报错晦涩且要白拉起一个进程，直接拒绝更可控
    if (!fs.existsSync(cwd)) {
        return Promise.reject(new GitError(`工作目录不存在：${cwd}`));
    }
    return new Promise((resolve, reject) => {
        const child = execFile(
            'git',
            args,
            {
                cwd,
                encoding: 'utf8',
                // 默认 maxBuffer 仅 1MB，大文件的 porcelain 输出会溢出
                maxBuffer: 64 * 1024 * 1024,
                timeout: 15_000,
                windowsHide: true,
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new GitError(error.message, error.code ?? undefined, stderr));
                } else {
                    resolve(stdout);
                }
            },
        );

        if (stdin !== undefined && child.stdin) {
            // git 提前退出（例如非 git 目录）时，写入端会收到 EPIPE；
            // 不消费 'error' 事件的话它是未处理异常，会被记进 Extension Host 错误日志。
            // 失败本身已通过 execFile 回调上报，这里吞掉即可。
            child.stdin.on('error', () => {});
            child.stdin.end(stdin);
        }
    });
}

/** 对当前编辑器内容执行 blame（而非磁盘内容），未保存的修改也能得到正确行号。 */
export function runBlame(filePath: string, contents: string): Promise<string> {
    // cwd 用文件所在目录、路径只传 basename：即使文件名以 '-' 开头也不会被当成选项
    return execGit(
        ['blame', '--line-porcelain', '--contents', '-', '--', path.basename(filePath)],
        path.dirname(filePath),
        contents,
    );
}

export async function getCommitMessage(sha: string, cwd: string): Promise<string> {
    // sha 来自 git 输出，正常必然合法；此处校验是防止未来改动把不可控来源拼进命令
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
        throw new GitError(`invalid sha: ${sha}`);
    }
    const out = await execGit(['log', '-1', '--format=%B', sha], cwd);
    return out.trimEnd();
}
