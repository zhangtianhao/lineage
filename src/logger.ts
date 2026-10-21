import * as vscode from 'vscode';

/**
 * 日志出口。所有异常静默，不弹窗打扰用户，只写日志。
 * 使用 LogOutputChannel（{ log: true }）以获得带时间戳和级别的输出。
 */
export class Logger implements vscode.Disposable {
    private readonly channel: vscode.LogOutputChannel;

    constructor() {
        this.channel = vscode.window.createOutputChannel('Lineage', { log: true });
    }

    debug(message: string): void {
        this.channel.debug(message);
    }

    info(message: string): void {
        this.channel.info(message);
    }

    warn(message: string): void {
        this.channel.warn(message);
    }

    error(message: string): void {
        this.channel.error(message);
    }

    dispose(): void {
        this.channel.dispose();
    }
}
