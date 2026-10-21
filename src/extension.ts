import * as vscode from 'vscode';

import { ToggleState } from './state';
import { Logger } from './logger';
import { BlameController } from './controller';
import { BlameHoverProvider } from './hover';

export async function activate(context: vscode.ExtensionContext) {
    // 每创建一个对象立即注册：后续任何一步抛异常时，已创建的资源仍会被
    // VSCode 统一释放（activate 失败时 subscriptions 照常 dispose）
    const logger = new Logger();
    context.subscriptions.push(logger);

    const state = new ToggleState(context.globalState);
    context.subscriptions.push(state);

    // 激活后立即同步上下文键，让菜单勾选状态与持久化值一致
    await state.init();

    const controller = new BlameController(state, logger);
    context.subscriptions.push(controller);

    const hoverProvider = new BlameHoverProvider(state, controller, logger);
    context.subscriptions.push(hoverProvider);
    const hoverRegistration = vscode.languages.registerHoverProvider(
        { scheme: 'file' },
        hoverProvider,
    );
    context.subscriptions.push(hoverRegistration);

    const enableCommand = vscode.commands.registerCommand('lineage.enableBlame', () => {
        // set 内部有多个 await：任一失败若无人接住会成为 unhandled rejection，可能击穿扩展宿主
        state.set(true).catch((e) =>
            logger.error(`开启失败：${e instanceof Error ? e.message : String(e)}`),
        );
    });
    context.subscriptions.push(enableCommand);

    const disableCommand = vscode.commands.registerCommand('lineage.disableBlame', () => {
        state.set(false).catch((e) =>
            logger.error(`关闭失败：${e instanceof Error ? e.message : String(e)}`),
        );
    });
    context.subscriptions.push(disableCommand);
}

export function deactivate() {}
