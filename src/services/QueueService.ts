import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './Logger';

/**
 * Status of a file in the generation queue
 */
export enum FileStatus {
    PENDING = 'pending',
    PROCESSING = 'processing',
    SUCCESS = 'success',
    FAILED = 'failed',
    SKIPPED = 'skipped'
}

/**
 * Queue item for test generation
 */
export interface QueueItem {
    filePath: string;
    fileName: string;
    projectRoot: string;
    status: FileStatus;
    attempts: number;
    error?: string;
    testFilePath?: string;
    addedAt: Date;
    processedAt?: Date;
}

/**
 * Generation queue state
 */
export interface QueueState {
    id: string;
    files: QueueItem[];
    currentIndex: number;
    isPaused: boolean;
    pausedAt?: Date;
    startedAt: Date;
    completedAt?: Date;
    mode: 'fast' | 'balanced' | 'thorough';
}

/**
 * Service to manage persistent generation queue
 */
export class QueueService {
    private static readonly QUEUE_STATE_KEY = 'generationQueueState';
    private static readonly CURRENT_QUEUE_ID_KEY = 'currentQueueId';
    
    private logger: Logger;
    private context: vscode.ExtensionContext;
    private currentQueue?: QueueState;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.logger = Logger.getInstance();
    }

    /**
     * Create a new generation queue
     */
    public async createQueue(
        files: vscode.Uri[], 
        projectRoot: string,
        mode: 'fast' | 'balanced' | 'thorough' = 'balanced'
    ): Promise<QueueState> {
        const queueId = this.generateQueueId();
        
        const queueItems: QueueItem[] = files.map(file => ({
            filePath: file.fsPath,
            fileName: path.basename(file.fsPath),
            projectRoot,
            status: FileStatus.PENDING,
            attempts: 0,
            addedAt: new Date()
        }));

        const queue: QueueState = {
            id: queueId,
            files: queueItems,
            currentIndex: 0,
            isPaused: false,
            startedAt: new Date(),
            mode
        };

        this.currentQueue = queue;
        await this.saveQueue(queue);
        await this.setCurrentQueueId(queueId);

        this.logger.info(`Queue created: ${queueId}`, { 
            fileCount: files.length,
            mode 
        });

        return queue;
    }

    /**
     * Get current active queue
     */
    public async getCurrentQueue(): Promise<QueueState | undefined> {
        if (this.currentQueue) {
            return this.currentQueue;
        }

        const queueId = await this.getCurrentQueueId();
        if (!queueId) {
            return undefined;
        }

        this.currentQueue = await this.loadQueue(queueId);
        return this.currentQueue;
    }

    /**
     * Get next file to process
     */
    public getNextFile(): QueueItem | undefined {
        if (!this.currentQueue) {
            return undefined;
        }

        const { files, currentIndex } = this.currentQueue;
        
        if (currentIndex >= files.length) {
            return undefined;
        }

        return files[currentIndex];
    }

    /**
     * Mark current file as processing
     */
    public async markProcessing(): Promise<void> {
        if (!this.currentQueue) {
            return;
        }

        const current = this.getNextFile();
        if (current) {
            current.status = FileStatus.PROCESSING;
            current.attempts++;
            await this.saveQueue(this.currentQueue);
        }
    }

    /**
     * Mark current file as success
     */
    public async markSuccess(testFilePath: string): Promise<void> {
        if (!this.currentQueue) {
            return;
        }

        const current = this.getNextFile();
        if (current) {
            current.status = FileStatus.SUCCESS;
            current.testFilePath = testFilePath;
            current.processedAt = new Date();
            this.currentQueue.currentIndex++;
            await this.saveQueue(this.currentQueue);
        }
    }

    /**
     * Mark current file as failed
     */
    public async markFailed(error: string): Promise<void> {
        if (!this.currentQueue) {
            return;
        }

        const current = this.getNextFile();
        if (current) {
            current.status = FileStatus.FAILED;
            current.error = error;
            current.processedAt = new Date();
            this.currentQueue.currentIndex++;
            await this.saveQueue(this.currentQueue);
        }
    }

    /**
     * Skip current file
     */
    public async skipCurrent(): Promise<void> {
        if (!this.currentQueue) {
            return;
        }

        const current = this.getNextFile();
        if (current) {
            current.status = FileStatus.SKIPPED;
            current.processedAt = new Date();
            this.currentQueue.currentIndex++;
            await this.saveQueue(this.currentQueue);
            
            this.logger.info(`File skipped: ${current.fileName}`);
        }
    }

    /**
     * Pause the queue
     */
    public async pause(): Promise<void> {
        if (!this.currentQueue) {
            return;
        }

        this.currentQueue.isPaused = true;
        this.currentQueue.pausedAt = new Date();
        await this.saveQueue(this.currentQueue);
        
        this.logger.info(`Queue paused: ${this.currentQueue.id}`);
    }

    /**
     * Resume the queue
     */
    public async resume(): Promise<void> {
        if (!this.currentQueue) {
            return;
        }

        this.currentQueue.isPaused = false;
        this.currentQueue.pausedAt = undefined;
        await this.saveQueue(this.currentQueue);
        
        this.logger.info(`Queue resumed: ${this.currentQueue.id}`);
    }

    /**
     * Complete the queue
     */
    public async complete(): Promise<void> {
        if (!this.currentQueue) {
            return;
        }

        this.currentQueue.completedAt = new Date();
        await this.saveQueue(this.currentQueue);
        await this.setCurrentQueueId(undefined);
        
        this.logger.info(`Queue completed: ${this.currentQueue.id}`);
        this.currentQueue = undefined;
    }

    /**
     * Cancel the queue
     */
    public async cancel(): Promise<void> {
        if (!this.currentQueue) {
            return;
        }

        const queueId = this.currentQueue.id;
        await this.deleteQueue(queueId);
        await this.setCurrentQueueId(undefined);
        
        this.logger.info(`Queue cancelled: ${queueId}`);
        this.currentQueue = undefined;
    }

    /**
     * Get queue statistics
     */
    public getStats(): { 
        total: number; 
        pending: number; 
        processing: number; 
        success: number; 
        failed: number; 
        skipped: number;
        progress: number;
    } | undefined {
        if (!this.currentQueue) {
            return undefined;
        }

        const { files, currentIndex } = this.currentQueue;
        
        const stats = {
            total: files.length,
            pending: files.filter(f => f.status === FileStatus.PENDING).length,
            processing: files.filter(f => f.status === FileStatus.PROCESSING).length,
            success: files.filter(f => f.status === FileStatus.SUCCESS).length,
            failed: files.filter(f => f.status === FileStatus.FAILED).length,
            skipped: files.filter(f => f.status === FileStatus.SKIPPED).length,
            progress: files.length > 0 ? (currentIndex / files.length) * 100 : 0
        };

        return stats;
    }

    /**
     * Get failed files
     */
    public getFailedFiles(): QueueItem[] {
        if (!this.currentQueue) {
            return [];
        }

        return this.currentQueue.files.filter(f => f.status === FileStatus.FAILED);
    }

    /**
     * Retry failed files
     */
    public async retryFailed(): Promise<void> {
        if (!this.currentQueue) {
            return;
        }

        const failedFiles = this.getFailedFiles();
        
        // Reset failed files to pending
        failedFiles.forEach(file => {
            file.status = FileStatus.PENDING;
            file.error = undefined;
            file.attempts = 0;
        });

        // Move current index to first failed file
        const firstFailedIndex = this.currentQueue.files.findIndex(f => f.status === FileStatus.PENDING);
        if (firstFailedIndex !== -1) {
            this.currentQueue.currentIndex = firstFailedIndex;
        }

        await this.saveQueue(this.currentQueue);
        
        this.logger.info(`Retrying ${failedFiles.length} failed files`);
    }

    /**
     * Check if queue is active
     */
    public isActive(): boolean {
        return this.currentQueue !== undefined && !this.currentQueue.isPaused;
    }

    /**
     * Check if queue is paused
     */
    public isPaused(): boolean {
        return this.currentQueue?.isPaused ?? false;
    }

    /**
     * Check if queue is complete
     */
    public isComplete(): boolean {
        if (!this.currentQueue) {
            return false;
        }

        return this.currentQueue.currentIndex >= this.currentQueue.files.length;
    }

    // Private helpers

    private generateQueueId(): string {
        return `queue_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private async saveQueue(queue: QueueState): Promise<void> {
        const key = `${QueueService.QUEUE_STATE_KEY}_${queue.id}`;
        await this.context.workspaceState.update(key, queue);
    }

    private async loadQueue(queueId: string): Promise<QueueState | undefined> {
        const key = `${QueueService.QUEUE_STATE_KEY}_${queueId}`;
        const queue = this.context.workspaceState.get<QueueState>(key);
        
        if (queue) {
            // Convert date strings back to Date objects
            queue.startedAt = new Date(queue.startedAt);
            if (queue.completedAt) {
                queue.completedAt = new Date(queue.completedAt);
            }
            if (queue.pausedAt) {
                queue.pausedAt = new Date(queue.pausedAt);
            }
            queue.files.forEach(file => {
                file.addedAt = new Date(file.addedAt);
                if (file.processedAt) {
                    file.processedAt = new Date(file.processedAt);
                }
            });
        }
        
        return queue;
    }

    private async deleteQueue(queueId: string): Promise<void> {
        const key = `${QueueService.QUEUE_STATE_KEY}_${queueId}`;
        await this.context.workspaceState.update(key, undefined);
    }

    private async getCurrentQueueId(): Promise<string | undefined> {
        return this.context.workspaceState.get<string>(QueueService.CURRENT_QUEUE_ID_KEY);
    }

    private async setCurrentQueueId(queueId: string | undefined): Promise<void> {
        await this.context.workspaceState.update(QueueService.CURRENT_QUEUE_ID_KEY, queueId);
    }
}
