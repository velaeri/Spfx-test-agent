import * as vscode from 'vscode';
import { QueueService } from '../services/QueueService';
import { Logger } from '../services/Logger';

/**
 * Commands for controlling test generation queue
 */
export class QueueCommands {
    private queueService: QueueService;
    private logger: Logger;

    constructor(queueService: QueueService) {
        this.queueService = queueService;
        this.logger = Logger.getInstance();
    }

    /**
     * Register all queue control commands
     */
    public registerCommands(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.commands.registerCommand('spfx-test-agent.pauseQueue', async () => {
                await this.handlePauseCommand();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('spfx-test-agent.resumeQueue', async () => {
                await this.handleResumeCommand();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('spfx-test-agent.skipCurrent', async () => {
                await this.handleSkipCommand();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('spfx-test-agent.cancelQueue', async () => {
                await this.handleCancelCommand();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('spfx-test-agent.retryFailed', async () => {
                await this.handleRetryFailedCommand();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('spfx-test-agent.showQueueStatus', async () => {
                await this.handleShowStatusCommand();
            })
        );

        this.logger.info('Queue control commands registered');
    }

    private async handlePauseCommand(): Promise<void> {
        const queue = await this.queueService.getCurrentQueue();
        if (!queue) {
            vscode.window.showWarningMessage('No hay ninguna cola de generación activa');
            return;
        }
        if (queue.isPaused) {
            vscode.window.showInformationMessage('La cola ya está pausada');
            return;
        }
        await this.queueService.pause();
        vscode.window.showInformationMessage('⏸️ Cola pausada. Usa "Reanudar Cola" para continuar.');
        this.logger.info('Queue paused via command');
    }

    private async handleResumeCommand(): Promise<void> {
        const queue = await this.queueService.getCurrentQueue();
        if (!queue) {
            vscode.window.showWarningMessage('No hay ninguna cola de generación para reanudar');
            return;
        }
        if (!queue.isPaused) {
            vscode.window.showInformationMessage('La cola ya está ejecutándose');
            return;
        }
        await this.queueService.resume();
        const action = await vscode.window.showInformationMessage(
            '▶️ Cola reanudada. ¿Deseas continuar ahora?',
            'Continuar',
            'Más tarde'
        );
        if (action === 'Continuar') {
            vscode.commands.executeCommand('workbench.action.chat.open', {
                query: '@spfx-tester /continue'
            });
        }
        this.logger.info('Queue resumed via command');
    }

    private async handleSkipCommand(): Promise<void> {
        const queue = await this.queueService.getCurrentQueue();
        if (!queue) {
            vscode.window.showWarningMessage('No hay ninguna cola de generación activa');
            return;
        }
        const current = this.queueService.getNextFile();
        if (!current) {
            vscode.window.showInformationMessage('No hay ningún archivo actual para saltar');
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            `¿Saltar archivo "${current.fileName}"?`,
            { modal: true },
            'Saltar',
            'Cancelar'
        );
        if (confirm === 'Saltar') {
            await this.queueService.skipCurrent();
            vscode.window.showInformationMessage(`⏭️ Archivo "${current.fileName}" saltado`);
            this.logger.info(`File skipped via command: ${current.fileName}`);
        }
    }

    private async handleCancelCommand(): Promise<void> {
        const queue = await this.queueService.getCurrentQueue();
        if (!queue) {
            vscode.window.showWarningMessage('No hay ninguna cola de generación activa');
            return;
        }
        const stats = this.queueService.getStats();
        if (!stats) {
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            `¿Cancelar la generación? (${stats.success}/${stats.total} completados)`,
            { modal: true },
            'Cancelar Cola',
            'No'
        );
        if (confirm === 'Cancelar Cola') {
            await this.queueService.cancel();
            vscode.window.showInformationMessage('❌ Cola de generación cancelada');
            this.logger.info('Queue cancelled via command');
        }
    }

    private async handleRetryFailedCommand(): Promise<void> {
        const queue = await this.queueService.getCurrentQueue();
        if (!queue) {
            vscode.window.showWarningMessage('No hay ninguna cola de generación activa');
            return;
        }
        const failedFiles = this.queueService.getFailedFiles();
        if (failedFiles.length === 0) {
            vscode.window.showInformationMessage('No hay archivos fallidos para reintentar');
            return;
        }
        const confirm = await vscode.window.showInformationMessage(
            `¿Reintentar ${failedFiles.length} archivo(s) fallido(s)?`,
            'Reintentar',
            'Cancelar'
        );
        if (confirm === 'Reintentar') {
            await this.queueService.retryFailed();
            vscode.window.showInformationMessage(
                `🔄 Reintentando ${failedFiles.length} archivos. Usa "@spfx-tester /continue" para proceder.`
            );
            this.logger.info(`Retrying ${failedFiles.length} failed files`);
        }
    }

    private async handleShowStatusCommand(): Promise<void> {
        const queue = await this.queueService.getCurrentQueue();
        if (!queue) {
            vscode.window.showInformationMessage('No hay ninguna cola de generación activa');
            return;
        }
        const stats = this.queueService.getStats();
        if (!stats) {
            return;
        }
        const statusMessage = [
            `📊 Estado de la Cola`,
            ``,
            `Total: ${stats.total} archivos`,
            `✅ Exitosos: ${stats.success}`,
            `❌ Fallidos: ${stats.failed}`,
            `⏭️ Saltados: ${stats.skipped}`,
            `⏳ Pendientes: ${stats.pending}`,
            `📈 Progreso: ${Math.round(stats.progress)}%`,
            ``,
            `Estado: ${queue.isPaused ? '⏸️ Pausado' : '▶️ Activo'}`,
            `Modo: ${queue.mode.toUpperCase()}`
        ].join('\n');
        vscode.window.showInformationMessage(statusMessage, { modal: true });
    }
}
