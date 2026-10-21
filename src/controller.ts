import * as vscode from 'vscode';

import { BlameLine, parseLinePorcelain } from './blameParser';
import { ANNOTATION_WIDTH, formatAnnotation } from './format';
import { runBlame } from './git';
import { Logger } from './logger';
import { ToggleState } from './state';

/** 文档变化后的防抖时长：连续输入期间不跑 git，停下后再计算。 */
const DEBOUNCE_MS = 300;

/** lines 为 null 表示负缓存：同一 version 内不再重试，避免反复对非 git 文件拉起进程。 */
type CacheEntry =
    | { version: number; lines: BlameLine[] }
    | { version: number; lines: null };

/**
 * 把状态、事件、缓存与渲染串起来。所有副作用集中于此，
 * 解析与格式化保持纯函数以便在普通 Node 中测试。
 */
export class BlameController implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    private readonly cache = new Map<string, CacheEntry>();
    private readonly inflight = new Map<string, { version: number; promise: Promise<void> }>();
    private readonly timers = new Map<string, NodeJS.Timeout>();

    private decorationType: vscode.TextEditorDecorationType | undefined;
    /** 每次开关变化 +1，用于丢弃跨越开关切换的过期异步结果。 */
    private generation = 0;

    /** 渲染资源就绪即视为激活：以 decorationType 的生命周期为准，与 state 之间不存在同步窗口。 */
    private get active(): boolean {
        return this.decorationType !== undefined;
    }

    constructor(private readonly state: ToggleState, private readonly logger: Logger) {
        this.disposables.push(
            state.onDidChange((enabled) => {
                this.logger.info(`blame ${enabled ? 'enabled' : 'disabled'}`);
                if (enabled) {
                    this.onEnabled();
                } else {
                    this.onDisabled();
                }
            }),
            // 打开/切换编辑器 tab：补渲染（缓存命中时不跑 git）
            vscode.window.onDidChangeVisibleTextEditors((editors) => {
                if (!this.active) {
                    return;
                }
                for (const editor of editors) {
                    this.refresh(editor);
                }
            }),
            // 内容变化：只关心用户正在编辑的可见文档，并做防抖
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (!this.active || e.contentChanges.length === 0) {
                    return;
                }
                if (!this.isVisible(e.document)) {
                    return;
                }
                this.scheduleDebounce(e.document);
            }),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                const key = doc.uri.toString();
                const timer = this.timers.get(key);
                if (timer) {
                    clearTimeout(timer);
                    this.timers.delete(key);
                }
                this.cache.delete(key);
                this.inflight.delete(key);
            }),
        );

        // 重启恢复：持久化为开时没有 onDidChange 事件，必须在此自行开启。
        // 此时 decorationType 尚未创建，只能读 state 而不能用 active 判断
        if (state.enabled) {
            this.onEnabled();
        }
    }

    /** 供悬停查询：缓存与当前文档版本一致时才有有效结果。 */
    getBlameLine(document: vscode.TextDocument, line: number): BlameLine | undefined {
        const entry = this.cache.get(document.uri.toString());
        if (!entry || entry.version !== document.version || entry.lines === null) {
            return undefined;
        }
        return entry.lines.find((b) => b.line === line);
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.clearTimers();
        this.decorationType?.dispose();
        this.decorationType = undefined;
        this.cache.clear();
        this.inflight.clear();
    }

    private onEnabled(): void {
        this.generation++;
        this.cache.clear();
        this.decorationType = vscode.window.createTextEditorDecorationType({
            before: {
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                backgroundColor: new vscode.ThemeColor('editor.lineHighlightBackground'),
                margin: '0 1.5em 0 0',
                // CSS 宽度与 contentText 的 NBSP 补齐双重保证列宽固定
                width: `${ANNOTATION_WIDTH}ch`,
                fontStyle: 'normal',
            },
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        });
        for (const editor of vscode.window.visibleTextEditors) {
            this.refresh(editor);
        }
    }

    private onDisabled(): void {
        this.generation++;
        this.clearTimers();
        // dispose decoration type 本身即可：VSCode 会把它从所有编辑器上移除
        this.decorationType?.dispose();
        this.decorationType = undefined;
        this.cache.clear();
        this.inflight.clear();
    }

    private refresh(editor: vscode.TextEditor): void {
        if (!this.active) {
            return;
        }
        const doc = editor.document;
        if (doc.uri.scheme !== 'file') {
            // untitled / diff / output 等视图：静默清空装饰
            editor.setDecorations(this.requireDecorationType(), []);
            return;
        }
        const key = doc.uri.toString();
        const entry = this.cache.get(key);
        if (entry && entry.version === doc.version) {
            this.render(editor, entry);
            return;
        }
        const pending = this.inflight.get(key);
        if (pending && pending.version === doc.version) {
            return; // 进行中的计算完成后会渲染所有相关编辑器
        }
        void this.startCompute(doc);
    }

    private async startCompute(doc: vscode.TextDocument): Promise<void> {
        const key = doc.uri.toString();
        const gen = this.generation;
        const version = doc.version;

        const promise = (async () => {
            let lines: BlameLine[] | null;
            try {
                // 每次 git 调用都记 debug，验收防抖时以日志为准
                this.logger.debug(`git blame：${doc.uri.fsPath}（version ${version}）`);
                const out = await runBlame(doc.uri.fsPath, doc.getText());
                lines = parseLinePorcelain(out);
            } catch (e) {
                this.logger.warn(
                    `blame 失败：${doc.uri.fsPath}（${e instanceof Error ? e.message : String(e)}）`,
                );
                lines = null;
            }
            // 渲染阶段的异常也必须吞掉：utility 进程模式下未处理的 rejection
            // 会让整个 Extension Host abort()，用户表现为窗口闪退
            try {
                if (gen !== this.generation) {
                    return; // 期间开关被切换过，结果作废
                }
                if (doc.isClosed) {
                    return;
                }
                if (doc.version !== version) {
                    return; // 内容又变了：过期结果不写缓存也不渲染，防抖到期后会重算
                }
                this.cache.set(key, { version, lines });
                for (const editor of vscode.window.visibleTextEditors) {
                    if (editor.document === doc) {
                        this.render(editor, { version, lines });
                    }
                }
            } catch (e) {
                this.logger.error(
                    `渲染失败：${doc.uri.fsPath}（${e instanceof Error ? e.message : String(e)}）`,
                );
            }
        })();
        this.inflight.set(key, { version, promise });

        // 完成后按 promise 引用清理自身记录：期间若被更新的计算覆盖，引用不再相等，
        // 不删后来者，保持它的去重保护
        void promise.finally(() => {
            const entry = this.inflight.get(key);
            if (entry?.promise === promise) {
                this.inflight.delete(key);
            }
        }).catch(() => {});
    }

    private render(editor: vscode.TextEditor, entry: CacheEntry): void {
        const type = this.requireDecorationType();
        if (entry.lines === null) {
            editor.setDecorations(type, []);
            return;
        }
        const doc = editor.document;
        const options: vscode.DecorationOptions[] = [];
        for (const b of entry.lines) {
            // 内容收缩后行数少于 blame 结果时跳过，防止 setDecorations 抛错
            if (b.line >= doc.lineCount) {
                continue;
            }
            options.push({
                range: new vscode.Range(b.line, 0, b.line, 0),
                renderOptions: { before: { contentText: formatAnnotation(b) } },
            });
        }
        editor.setDecorations(type, options);
    }

    private scheduleDebounce(doc: vscode.TextDocument): void {
        const key = doc.uri.toString();
        const existing = this.timers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.timers.delete(key);
            if (!this.active || doc.isClosed) {
                return;
            }
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document === doc) {
                    this.refresh(editor);
                }
            }
        }, DEBOUNCE_MS);
        this.timers.set(key, timer);
    }

    private isVisible(doc: vscode.TextDocument): boolean {
        return vscode.window.visibleTextEditors.some((e) => e.document === doc);
    }

    private clearTimers(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }

    private requireDecorationType(): vscode.TextEditorDecorationType {
        if (!this.decorationType) {
            throw new Error('decoration type 未创建（开关应为开启状态）');
        }
        return this.decorationType;
    }
}
