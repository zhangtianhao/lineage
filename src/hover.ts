import * as vscode from 'vscode';
import * as path from 'node:path';

import { BlameLine } from './blameParser';
import { formatDateTime, shortSha } from './format';
import { getCommitMessage } from './git';
import { Logger } from './logger';
import { BlameController } from './controller';
import { ToggleState } from './state';

export class BlameHoverProvider implements vscode.HoverProvider, vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    /** 完整 commit message 按 sha 懒加载缓存，同一 commit 的多行只跑一次 git log。 */
    private readonly messageCache = new Map<string, string>();

    constructor(
        private readonly state: ToggleState,
        private readonly controller: BlameController,
        private readonly logger: Logger,
    ) {
        // 关闭功能时清空 message 缓存：重新开启后以最新仓库状态为准
        this.disposables.push(
            state.onDidChange((enabled) => {
                if (!enabled) {
                    this.messageCache.clear();
                }
            }),
        );
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Hover | undefined> {
        if (!this.state.enabled || position.character !== 0) {
            return undefined;
        }
        const blameLine = this.controller.getBlameLine(document, position.line);
        if (!blameLine) {
            return undefined;
        }

        const md = new vscode.MarkdownString();
        // 保持 false：外部输入的作者名/message 不应获得命令链接等高权限语法
        md.isTrusted = false;

        const range = new vscode.Range(position.line, 0, position.line, 0);

        if (blameLine.uncommitted) {
            md.appendText('未提交的更改');
            return new vscode.Hover(md, range);
        }

        // 标题中的 markdown 语法只作用于我们控制的短 hash；作者与邮箱是外部输入，
        // 用 appendText 自动转义，防止其中的 Markdown/HTML 被渲染
        md.appendMarkdown(`**${shortSha(blameLine.sha)}** · `);
        md.appendText(`${blameLine.author} <${blameLine.authorMail}>`);
        md.appendMarkdown('\n\n');
        md.appendText(formatDateTime(blameLine.authorTime, blameLine.authorTz));
        md.appendMarkdown('\n\n---\n\n');
        md.appendText(await this.loadMessage(blameLine, document));
        return new vscode.Hover(md, range);
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.messageCache.clear();
    }

    private async loadMessage(
        blameLine: BlameLine,
        document: vscode.TextDocument,
    ): Promise<string> {
        const cached = this.messageCache.get(blameLine.sha);
        if (cached !== undefined) {
            return cached;
        }
        try {
            const message = await getCommitMessage(blameLine.sha, path.dirname(document.uri.fsPath));
            this.messageCache.set(blameLine.sha, message);
            return message;
        } catch (e) {
            // 失败回退到 summary：悬停不应因 git log 失败而无内容
            this.logger.warn(
                `获取 commit message 失败：${blameLine.sha}（${e instanceof Error ? e.message : String(e)}）`,
            );
            return blameLine.summary;
        }
    }
}
