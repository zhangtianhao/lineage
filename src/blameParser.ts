/** 单行 blame 元数据。line 为 0 起始，对应当前编辑器内容（即 --contents 传入的内容）中的行号。 */
export interface BlameLine {
    line: number;
    sha: string;
    author: string;
    authorMail: string;
    authorTime: number;
    authorTz: string;
    summary: string;
    uncommitted: boolean;
}

/** porcelain 输出无法解析。message 携带输出中的行号（1 起始），便于定位问题。 */
export class BlameParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BlameParseError';
    }
}

// 头行：<sha 40 或 64 位> <orig_line> <final_line> [group_size]
// 64 位分支在前：40 位分支会先匹配成功再因剩余字符失败，靠回溯纠正；倒过来写在部分引擎上更直接
const HEADER_RE = /^([0-9a-f]{64}|[0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

// 本模块与 format.ts 一样禁止 import vscode：它们要在普通 Node 环境下被 mocha 直接测试

export function parseLinePorcelain(output: string): BlameLine[] {
    if (output === '') {
        return [];
    }

    const lines = output.split('\n');
    // 合法输出以 \n 结尾，split 会多出一个空元素；截断的输出末行非空，不受影响
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }

    const result: BlameLine[] = [];
    let inBlock = false;
    let cur: BlameLine | undefined;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];

        if (raw.startsWith('\t')) {
            // 块结束（源码内容本身不需要保存）
            if (!inBlock || !cur) {
                throw new BlameParseError(`源码行出现在块外（第 ${i + 1} 行）`);
            }
            result.push(cur);
            cur = undefined;
            inBlock = false;
            continue;
        }

        if (!inBlock) {
            const m = HEADER_RE.exec(raw);
            if (!m) {
                throw new BlameParseError(`头行格式错误（第 ${i + 1} 行）: ${raw}`);
            }
            cur = {
                line: Number(m[3]) - 1,
                sha: m[1],
                author: '',
                authorMail: '',
                authorTime: 0,
                authorTz: '',
                summary: '',
                // 不依赖作者字符串 Not Committed Yet：git 的文案将来可能变
                uncommitted: /^0+$/.test(m[1]),
            };
            inBlock = true;
            continue;
        }

        // key-value 行：只识别需要的 5 个 key，其余（committer*、previous、boundary、filename）忽略
        const sep = raw.indexOf(' ');
        const key = sep === -1 ? raw : raw.slice(0, sep);
        const value = sep === -1 ? '' : raw.slice(sep + 1);

        // 状态机不变式：inBlock 为 true 时 cur 必非空
        if (!cur) {
            throw new BlameParseError(`内部状态错误（第 ${i + 1} 行）`);
        }

        switch (key) {
            case 'author':
                cur.author = value;
                break;
            case 'author-mail':
                cur.authorMail = stripAngleBrackets(value);
                break;
            case 'author-time':
                cur.authorTime = Number(value);
                break;
            case 'author-tz':
                cur.authorTz = value;
                break;
            case 'summary':
                cur.summary = value;
                break;
            default:
                break;
        }
    }

    if (inBlock) {
        throw new BlameParseError('输出被截断：缺少源码行');
    }

    // git 按输出顺序产出，本身就是按行号升序；显式排序以作防御
    result.sort((a, b) => a.line - b.line);
    return result;
}

function stripAngleBrackets(value: string): string {
    if (value.startsWith('<') && value.endsWith('>')) {
        return value.slice(1, -1);
    }
    return value;
}
