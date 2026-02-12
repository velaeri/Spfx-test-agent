import * as vscode from 'vscode';
import { Logger, LogLevel } from './services/Logger';
import { ConfigService } from './services/ConfigService';
import { StateService } from './services/StateService';
import { ProjectSetupService } from './services/ProjectSetupService';
import { WorkspaceNotFoundError } from './errors/CustomErrors';
import { 
    handleSetupRequest, 
    handleGenerateAllRequest, 
    handleGenerateSingleRequest, 
    handleError 
} from './ChatHandlers';

/**
 * SPFX Test Agent Extension
 * 
 * This extension implements an "Agentic Workflow" for automated test generation.
 * It uses GPT-4 via GitHub Copilot to generate, run, and self-heal unit tests
 * for SharePoint Framework components.
 */

let logger: Logger;
let stateService: StateService;

// This method is called when the extension is activated
export function activate(context: vscode.ExtensionContext) {
    // Initialize services
    logger = Logger.getInstance();
    stateService = new StateService(context);

    // Configure logger from settings
    const config = ConfigService.getConfig();
    logger.setLogLevel(getLogLevel(config.logLevel));

    logger.info('SPFX Test Agent extension is now active!', {
        version: context.extension.packageJSON.version,
        config: {
            maxAttempts: config.maxHealingAttempts,
            llmProvider: config.llmProvider,
            llmVendor: config.llmVendor,
            llmFamily: config.llmFamily
        }
    });

    // Register the chat participant with ID 'spfx-tester'
    // This matches the configuration in package.json
    const chatParticipant = vscode.chat.createChatParticipant('spfx-tester', handleChatRequest);
    
    // Set metadata for the participant
    chatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');

    context.subscriptions.push(chatParticipant);
    context.subscriptions.push(logger);

    // Register commands
    const setupCommand = vscode.commands.registerCommand('spfx-test-agent.setup', async () => {
        await handleSetupCommand();
    });

    const checkSetupCommand = vscode.commands.registerCommand('spfx-test-agent.checkSetup', async () => {
        await handleCheckSetupCommand();
    });

    context.subscriptions.push(setupCommand);
    context.subscriptions.push(checkSetupCommand);

    // Watch for configuration changes
    context.subscriptions.push(
        ConfigService.onDidChangeConfiguration((newConfig) => {
            logger.setLogLevel(getLogLevel(newConfig.logLevel));
            logger.info('Configuration updated', newConfig);
        })
    );

    logger.info('Extension activation complete');
}

// This method is called when the extension is deactivated
export function deactivate() {
    logger?.info('SPFX Test Agent extension is now deactivated');
}

/**
 * Convert string log level to enum
 */
function getLogLevel(level: string): LogLevel {
    switch (level.toLowerCase()) {
        case 'debug': return LogLevel.DEBUG;
        case 'info': return LogLevel.INFO;
        case 'warn': return LogLevel.WARN;
        case 'error': return LogLevel.ERROR;
        default: return LogLevel.INFO;
    }
}

/**
 * Handler for chat requests
 * 
 * This orchestrates the agentic workflow:
 * 1. Identifies the file(s) to test
 * 2. Calls TestAgent to generate and heal tests
 * 3. Streams progress and results back to the user
 */
async function handleChatRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    
    logger.info('Chat request received', { 
        prompt: request.prompt,
        command: request.command
    });

    // Check if the request was cancelled
    if (token.isCancellationRequested) {
        logger.warn('Request cancelled by user');
        return { errorDetails: { message: 'Request cancelled' } };
    }

    try {
        // Check command type
        if (request.command === 'setup') {
            return await handleSetupRequest(stream, token);
        }
        
        if (request.command === 'generate-all') {
            return await handleGenerateAllRequest(stream, token, stateService);
        }

        // Original single-file generation
        return await handleGenerateSingleRequest(stream, token, stateService);

    } catch (error) {
        return handleError(error, stream);
    }
}



/**
 * Command to setup Jest environment in current workspace
 */
async function handleSetupCommand() {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new WorkspaceNotFoundError();
        }
        
        const workspaceRoot = workspaceFolder.uri.fsPath;
        const setupService = new ProjectSetupService();
        
        await setupService.setupProject(workspaceRoot, { autoInstall: true });
    } catch (error) {
        logger.error('Setup command failed', error);
        vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Command to check Jest environment setup status
 */
async function handleCheckSetupCommand() {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new WorkspaceNotFoundError();
        }
        
        const workspaceRoot = workspaceFolder.uri.fsPath;
        const setupService = new ProjectSetupService();
        
        await setupService.showSetupStatus(workspaceRoot);
    } catch (error) {
        logger.error('Check setup command failed', error);
        vscode.window.showErrorMessage(`Check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
