import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LearningEntry } from '../interfaces/ILLMProvider';
import { Logger } from './Logger';

/**
 * Service to persist learning experiences (adversarial review improvements)
 * to a local knowledge base in the workspace.
 */
export class LearningService {
    private static instance: LearningService;
    private logger: Logger;
    private readonly LOG_FOLDER = '.test-agent';
    private readonly LOG_FILE = 'discovery_logs.jsonl';

    private constructor() {
        this.logger = Logger.getInstance();
    }

    public static getInstance(): LearningService {
        if (!LearningService.instance) {
            LearningService.instance = new LearningService();
        }
        return LearningService.instance;
    }

    /**
     * Persist a learning entry to the local jsonl file
     */
    public async logExperience(entry: LearningEntry, workspaceRoot: string): Promise<void> {
        try {
            const logDirPath = path.join(workspaceRoot, this.LOG_FOLDER);
            const logFilePath = path.join(logDirPath, this.LOG_FILE);

            // Ensure directory exists
            if (!fs.existsSync(logDirPath)) {
                fs.mkdirSync(logDirPath, { recursive: true });
            }

            // Append entry as a single line JSON
            const logLine = JSON.stringify(entry) + '\n';
            fs.appendFileSync(logFilePath, logLine, 'utf-8');

            this.logger.info(`Learning experience captured for: ${entry.fileName}`);
        } catch (error) {
            this.logger.error('Failed to log learning experience', error);
        }
    }

    /**
     * Get all logged experiences from the workspace
     */
    public async getExperiences(workspaceRoot: string): Promise<LearningEntry[]> {
        const logFilePath = path.join(workspaceRoot, this.LOG_FOLDER, this.LOG_FILE);
        
        if (!fs.existsSync(logFilePath)) {
            return [];
        }

        try {
            const content = fs.readFileSync(logFilePath, 'utf-8');
            return content
                .split('\n')
                .filter(line => line.trim() !== '')
                .map(line => JSON.parse(line));
        } catch (error) {
            this.logger.error('Failed to read learning experiences', error);
            return [];
        }
    }
}
