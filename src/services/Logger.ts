import * as vscode from 'vscode';

/**
 * Log levels
 */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

/**
 * Logger service with VS Code Output Channel integration
 */
export class Logger {
    private static instance: Logger;
    private outputChannel: vscode.OutputChannel;
    private logLevel: LogLevel = LogLevel.INFO;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('SPFX Test Agent');
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    /**
     * Set the minimum log level
     */
    public setLogLevel(level: LogLevel): void {
        this.logLevel = level;
    }

    /**
     * Show the output channel
     */
    public show(): void {
        this.outputChannel.show();
    }

    /**
     * Debug level logging
     */
    public debug(message: string, data?: unknown): void {
        this.log(LogLevel.DEBUG, message, data);
    }

    /**
     * Info level logging
     */
    public info(message: string, data?: unknown): void {
        this.log(LogLevel.INFO, message, data);
    }

    /**
     * Warning level logging
     */
    public warn(message: string, data?: unknown): void {
        this.log(LogLevel.WARN, message, data);
    }

    /**
     * Error level logging
     */
    public error(message: string, error?: unknown): void {
        this.log(LogLevel.ERROR, message, error);
        
        // For errors, also log the stack trace if available
        if (error instanceof Error && error.stack) {
            this.outputChannel.appendLine(`Stack trace: ${error.stack}`);
        }
    }

    /**
     * Internal logging method
     */
    private log(level: LogLevel, message: string, data?: unknown): void {
        if (level < this.logLevel) {
            return; // Skip if below current log level
        }

        const timestamp = new Date().toISOString();
        const levelStr = LogLevel[level].padEnd(5);
        const logMessage = `[${timestamp}] [${levelStr}] ${message}`;

        this.outputChannel.appendLine(logMessage);

        if (data !== undefined) {
            try {
                const dataStr = typeof data === 'string' 
                    ? data 
                    : JSON.stringify(data, null, 2);
                this.outputChannel.appendLine(dataStr);
            } catch (err) {
                this.outputChannel.appendLine(`[Failed to stringify data: ${err}]`);
            }
        }

        // Also log to console for development
        if (level === LogLevel.ERROR) {
            console.error(logMessage, data);
        } else if (level === LogLevel.WARN) {
            console.warn(logMessage, data);
        } else {
            console.log(logMessage, data);
        }
    }

    /**
     * Clear the output channel
     */
    public clear(): void {
        this.outputChannel.clear();
    }

    /**
     * Dispose the logger
     */
    public dispose(): void {
        this.outputChannel.dispose();
    }
}
