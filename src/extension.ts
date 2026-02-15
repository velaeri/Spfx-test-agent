import * as vscode from 'vscode';
import * as fs from 'fs';
import { Logger, LogLevel } from './services/Logger';
import { ConfigService } from './services/ConfigService';
import { StateService } from './services/StateService';
import { ProjectSetupService } from './services/ProjectSetupService';
import { WorkspaceNotFoundError } from './errors/CustomErrors';
import { 
    handleSetupRequest,
    handleInstallRequest,
    handleGenerateAllRequest, 
    handleGenerateSingleRequest, 
    handleError 
} from './ChatHandlers';
import { LLMOrchestrator } from './orchestrator/LLMOrchestrator';
import { OrchestratorFactory } from './orchestrator/OrchestratorFactory';
import { CopilotProvider } from './providers/CopilotProvider';
import { AzureOpenAIProvider } from './providers/AzureOpenAIProvider';

/**
 * Test Agent Extension
 * 
 * This extension implements an "Agentic Workflow" for automated test generation.
 * It uses LLMs via GitHub Copilot to generate, run, and self-heal unit tests
 * for any JavaScript/TypeScript project.
 */

let logger: Logger;
let stateService: StateService;
let orchestrator: LLMOrchestrator;

// This method is called when the extension is activated
export function activate(context: vscode.ExtensionContext) {
    // Initialize services
    logger = Logger.getInstance();
    stateService = new StateService(context);

    // Configure logger from settings
    const config = ConfigService.getConfig();
    logger.setLogLevel(getLogLevel(config.logLevel));

    // Initialize LLM provider
    const hasAzureConfig = config.azureOpenAI?.endpoint && 
                           config.azureOpenAI?.apiKey && 
                           config.azureOpenAI?.deploymentName;
    const llmProvider = hasAzureConfig
        ? new AzureOpenAIProvider()
        : new CopilotProvider(config.llmVendor, config.llmFamily);

    // Initialize tool registry and orchestrator
    const toolRegistry = OrchestratorFactory.createToolRegistry(llmProvider);
    orchestrator = new LLMOrchestrator(toolRegistry, llmProvider);

    logger.info('Test Agent extension is now active!', {
        version: context.extension.packageJSON.version,
        tools: toolRegistry.getToolNames(),
        config: {
            maxAttempts: config.maxHealingAttempts,
            llmProvider: config.llmProvider,
            llmVendor: config.llmVendor,
            llmFamily: config.llmFamily
        }
    });

    // Register the chat participant with ID 'test-agent'
    // This matches the configuration in package.json
    const chatParticipant = vscode.chat.createChatParticipant('test-agent', handleChatRequest);
    
    // Set metadata for the participant
    chatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');

    context.subscriptions.push(chatParticipant);
    context.subscriptions.push(logger);

    // Register commands
    const setupCommand = vscode.commands.registerCommand('test-agent.setup', async () => {
        await handleSetupCommand();
    });

    const checkSetupCommand = vscode.commands.registerCommand('test-agent.checkSetup', async () => {
        await handleCheckSetupCommand();
    });

    // Command to retry install with a specific command (from LLM suggestion)
    const installWithCommandCommand = vscode.commands.registerCommand(
        'test-agent.installWithCommand',
        async (command: string) => {
            // Open chat with /install command
            await vscode.commands.executeCommand('vscode.chat.open', {
                query: `@test-agent /install ${command}`
            });
        }
    );

    context.subscriptions.push(setupCommand);
    context.subscriptions.push(checkSetupCommand);
    context.subscriptions.push(installWithCommandCommand);

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
    logger?.info('Test Agent extension is now deactivated');
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
        command: request.command,
        referencesCount: request.references?.length || 0
    });
    
    // Log references for debugging
    if (request.references && request.references.length > 0) {
        request.references.forEach((ref, idx) => {
            logger.info(`Reference ${idx}:`, {
                type: typeof ref.value,
                isUri: ref.value instanceof vscode.Uri,
                value: ref.value instanceof vscode.Uri ? ref.value.fsPath : String(ref.value)
            });
        });
    }

    // Check if the request was cancelled
    if (token.isCancellationRequested) {
        logger.warn('Request cancelled by user');
        return { errorDetails: { message: 'Request cancelled' } };
    }

    try {
        // 1. Identify target path (priority: references > prompt)
        let targetPath = extractPathFromReferences(request.references);
        
        if (!targetPath) {
            targetPath = extractPathFromPrompt(request.prompt);
        }

        logger.info('Identified target path', { targetPath });
        
        // Check command type
        if (request.command === 'setup') {
            return await handleSetupRequest(stream, token);
        }
        
        if (request.command === 'install') {
            // Extract command from prompt if provided (for retry with suggested versions)
            const commandFromPrompt = request.prompt.trim();
            return await handleInstallRequest(stream, token, commandFromPrompt || undefined);
        }
        
        if (request.command === 'generate-all') {
            return await handleGenerateAllRequest(stream, token, stateService, targetPath, orchestrator);
        }

        // Single-file generation via orchestrator
        return await handleGenerateSingleRequest(stream, token, stateService, orchestrator);

    } catch (error) {
        return handleError(error, stream);
    }
}

/**
 * Extract path from chat references (attached files/folders)
 */
function extractPathFromReferences(references: readonly vscode.ChatPromptReference[]): string | undefined {
    if (!references || references.length === 0) return undefined;
    
    // Look for the first URI reference (file or folder)
    for (const ref of references) {
        if (ref.value instanceof vscode.Uri) {
            return ref.value.fsPath;
        }
    }
    
    return undefined;
}

/**
 * Extract file/folder path from chat prompt
 * Supports: C:\path\to\folder, /path/to/folder, relative paths, quoted paths
 */
function extractPathFromPrompt(prompt: string): string | undefined {
    if (!prompt) return undefined;

    // First try to match quoted paths (handles spaces)
    const quotedPath = prompt.match(/"([^"]+)"|'([^']+)'/);
    if (quotedPath) {
        return quotedPath[1] || quotedPath[2];
    }
    
    // Match Windows paths (handles some spaces if not too complex, but stops at common breaks if not quoted)
    // Improved regex to try to capture paths with spaces if they look like a Windows path until the end or a newline
    const windowsPath = prompt.match(/[A-Za-z]:[\\\/](?:[^"<>|*?]+)/);
    if (windowsPath) {
        let p = windowsPath[0].trim();
        // If it starts looking like a path, try to validate it exists
        if (fs.existsSync(p)) return p;
        
        // If not, it might have captured too much (e.g. part of the sentence)
        // Let's try the original restricted regex for fallback
        const strictWindowsPath = prompt.match(/[A-Za-z]:[\\\/](?:[^\s"'<>|*?]+[\\\/]?)+/);
        if (strictWindowsPath) return strictWindowsPath[0];
    }
    
    // Match Unix absolute paths: /path/to/folder
    const unixPath = prompt.match(/\/(?:[^\s"'<>|*?]+\/?)*/);
    if (unixPath && unixPath[0].length > 1) {
        return unixPath[0];
    }
    
    // Match relative paths if they look like paths (contain / or \)
    const relativePath = prompt.match(/(?:[.\w-]+[\\\/])+[.\w-]*/);
    if (relativePath) {
        return relativePath[0];
    }
    
    return undefined;
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
