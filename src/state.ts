import * as vscode from 'vscode';

/**
 * 开关状态：globalState 持久化 + setContext 驱动菜单 when 子句 + 事件广播。
 */
export class ToggleState implements vscode.Disposable {
    // 键名与菜单 when 子句中的上下文键保持一致，避免两处配置漂移
    static readonly KEY = 'lineage.blameEnabled';

    private readonly emitter = new vscode.EventEmitter<boolean>();

    readonly onDidChange: vscode.Event<boolean> = this.emitter.event;

    constructor(private readonly memento: vscode.Memento) {}

    get enabled(): boolean {
        return this.memento.get<boolean>(ToggleState.KEY, false);
    }

    /** 激活时同步一次上下文键；不这样做的话，扩展未激活期间菜单显示的勾选状态可能与持久化值不符 */
    async init(): Promise<void> {
        await vscode.commands.executeCommand('setContext', ToggleState.KEY, this.enabled);
    }

    async set(value: boolean): Promise<void> {
        if (value === this.enabled) {
            return;
        }
        // 先落盘再改上下文：若 setContext 先行而 update 失败，菜单勾选与真实状态将不一致
        await this.memento.update(ToggleState.KEY, value);
        await vscode.commands.executeCommand('setContext', ToggleState.KEY, value);
        this.emitter.fire(value);
    }

    dispose(): void {
        this.emitter.dispose();
    }
}
