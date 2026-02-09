import * as vscode from 'vscode';
import * as path from 'path';
import { TestAgent } from './agent/TestAgent';
import { Logger, LogLevel } from './services/Logger';
import { ConfigService } from './services/ConfigService';
import { StateService } from './services/StateService';
import { ProjectSetupService } from './services/ProjectSetupService';
import { FileScanner } from './utils/FileScanner';
import { 
    WorkspaceNotFoundError, 
    FileValidationError,
    JestNotFoundError,
    TestGenerationError,
    RateLimitError,
    LLMNotAvailableError,
    SPFXTestAgentError
} from './errors/CustomErrors';

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
        // Check if this is a generate-all command
        if (request.command === 'generate-all') {
            return await handleGenerateAllRequest(stream, token);
        }

        // Original single-file generation
        return await handleGenerateSingleRequest(stream, token);

    } catch (error) {
        return handleError(error, stream);
    }
}

/**
 * Handle generation for a single file (original behavior)
 */
async function handleGenerateSingleRequest(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    // Get the currently open file
    const activeEditor = vscode.window.activeTextEditor;
    
    if (!activeEditor) {
        stream.markdown('⚠️ Por favor, abre un archivo TypeScript/TSX para generar tests.\n\n');
        stream.markdown('**Uso:** Abre un componente SPFx (ej: `MiComponente.tsx`) e invoca `@spfx-tester generate`\n\n');
        stream.markdown('**O usa:** `@spfx-tester /generate-all` para generar tests de todos los archivos del workspace\n');
        logger.warn('No active editor found');
        return { metadata: { command: '' } };
    }

    const sourceFilePath = activeEditor.document.uri.fsPath;
    const fileName = path.basename(sourceFilePath);

    logger.debug('Processing file', { fileName, filePath: sourceFilePath });

    // Verify it's a TypeScript/TSX file
    if (!fileName.endsWith('.ts') && !fileName.endsWith('.tsx')) {
        stream.markdown('⚠️ Esta extensión solo genera tests para archivos TypeScript (.ts) y TSX (.tsx).\n\n');
        logger.warn('Invalid file type', { fileName });
        return { metadata: { command: '' } };
    }

    // Verify it's not already a test file
    if (fileName.includes('.test.') || fileName.includes('.spec.')) {
        stream.markdown('⚠️ Este ya es un archivo de test. Por favor, abre el archivo fuente.\n\n');
        logger.warn('Attempted to generate test for test file', { fileName });
        return { metadata: { command: '' } };
    }

    // Get workspace root
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (!workspaceFolder) {
        throw new WorkspaceNotFoundError();
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    logger.info('Workspace identified', { workspaceRoot });

    // Show what we're doing
    stream.markdown(`## 🚀 Generando Tests para \`${fileName}\`\n\n`);
    stream.markdown(`Usando workflow agentico con capacidades de auto-reparación...\n\n`);

    // Create and run the test agent
    const agent = new TestAgent(undefined, stateService);
    
    try {
        const testFilePath = await agent.generateAndHealTest(
            sourceFilePath,
            workspaceRoot,
            stream
        );

        // Open the generated test file
        const testFileUri = vscode.Uri.file(testFilePath);
        const doc = await vscode.workspace.openTextDocument(testFileUri);
        await vscode.window.showTextDocument(doc, { preview: false });

        stream.markdown(`\n📝 Archivo de test abierto: \`${path.basename(testFilePath)}\`\n`);
        
        logger.info('Test generation completed successfully', {
            sourceFile: fileName,
            testFile: path.basename(testFilePath)
        });

        return { metadata: { command: 'generate' } };
    } catch (error) {
        return handleError(error, stream, fileName);
    }
}

/**
 * Handle generation for all files in workspace
 */
async function handleGenerateAllRequest(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    // Get all workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new WorkspaceNotFoundError();
    }

    stream.markdown(`## 🚀 Generando Tests para Todo el Workspace\n\n`);
    stream.progress('Escaneando archivos fuente...');

    let allFiles: vscode.Uri[] = [];

    // Scan all workspace folders
    for (const folder of workspaceFolders) {
        const files = await FileScanner.findSourceFiles(folder);
        allFiles = allFiles.concat(files);
    }

    logger.info(`Found ${allFiles.length} source files in workspace`);

    // Filter out files that already have tests
    const filesWithoutTests = FileScanner.filterFilesWithoutTests(allFiles);

    logger.info(`${filesWithoutTests.length} files need tests`);

    if (filesWithoutTests.length === 0) {
        stream.markdown('✅ ¡Todos los archivos ya tienen tests!\n\n');
        return { metadata: { command: 'generate-all' } };
    }

    stream.markdown(`Encontrados **${allFiles.length}** archivos fuente\n`);
    stream.markdown(`**${filesWithoutTests.length}** archivos necesitan tests\n\n`);

    // Ask for confirmation
    stream.markdown(`⚠️ Esto generará tests para ${filesWithoutTests.length} archivos. Puede tomar varios minutos.\n\n`);

    // Group files by project (for better Jest execution)
    const projectMap = FileScanner.groupFilesByProject(filesWithoutTests);

    stream.markdown(`📁 Encontrados **${projectMap.size}** proyecto(s)\n\n`);

    let successCount = 0;
    let failCount = 0;
    let currentFile = 0;

    // Process each project
    for (const [projectRoot, files] of projectMap.entries()) {
        stream.markdown(`### Proyecto: \`${path.basename(projectRoot)}\`\n\n`);
        
        const agent = new TestAgent(undefined, stateService);

        for (const file of files) {
            if (token.isCancellationRequested) {
                stream.markdown('\n⚠️ Generación cancelada por el usuario\n');
                break;
            }

            currentFile++;
            const fileName = path.basename(file.fsPath);
            
            stream.progress(`[${currentFile}/${filesWithoutTests.length}] ${fileName}...`);
            stream.markdown(`\n#### [${currentFile}/${filesWithoutTests.length}] \`${fileName}\`\n`);

            try {
                await agent.generateAndHealTest(
                    file.fsPath,
                    projectRoot,
                    stream
                );
                successCount++;
                stream.markdown(`✅ Éxito\n`);
            } catch (error) {
                failCount++;
                const errorMsg = error instanceof Error ? error.message : 'Error desconocido';
                stream.markdown(`❌ Falló: ${errorMsg}\n`);
                logger.error(`Failed to generate test for ${fileName}`, error);
                
                // Continue with next file instead of stopping
                continue;
            }

            // Add delay to avoid rate limiting
            if (currentFile < filesWithoutTests.length) {
                stream.progress('Esperando para evitar límites de API...');
                await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay between files
            }
        }
    }

    // Summary
    stream.markdown(`\n---\n\n## 📊 Resumen\n\n`);
    stream.markdown(`- ✅ Generados exitosamente: **${successCount}** tests\n`);
    stream.markdown(`- ❌ Fallidos: **${failCount}** tests\n`);
    stream.markdown(`- 📝 Total procesados: **${currentFile}** archivos\n\n`);

    logger.info('Batch test generation completed', {
        total: currentFile,
        success: successCount,
        failed: failCount
    });

    return { metadata: { command: 'generate-all' } };
}

/**
 * Centralized error handling with user-friendly messages (unchanged)
 */
function handleError(
    error: unknown,
    stream: vscode.ChatResponseStream,
    fileName?: string
): vscode.ChatResult {
    logger.error('Error during test generation', error);

    if (error instanceof JestNotFoundError) {
        stream.markdown(`\n❌ **Jest No Encontrado**\n\n`);
        stream.markdown(error.message + '\n\n');
        stream.markdown('💡 **Configuración rápida:**\n');
        stream.markdown('```bash\nnpm install --save-dev jest @types/jest ts-jest\n```\n');
        return { errorDetails: { message: error.message } };
    }

    if (error instanceof LLMNotAvailableError) {
        stream.markdown(`\n❌ **LLM No Disponible**\n\n`);
        stream.markdown(error.message + '\n\n');
        stream.markdown('💡 **Consejo:** Asegúrate de que GitHub Copilot esté instalado y hayas iniciado sesión.\n');
        stream.markdown('💡 Verifica que tu suscripción de Copilot incluya acceso al modelo seleccionado.\n');
        return { errorDetails: { message: error.message } };
    }

    if (error instanceof RateLimitError) {
        stream.markdown(`\n❌ **Límite de Velocidad Excedido**\n\n`);
        stream.markdown(error.message + '\n\n');
        stream.markdown('💡 **Consejo:** Espera unos minutos e inténtalo de nuevo.\n');
        if (error.retryAfterMs) {
            stream.markdown(`⏳ Reintentar después de: ${(error.retryAfterMs / 1000).toFixed(0)}s\n`);
        }
        return { errorDetails: { message: error.message } };
    }

    if (error instanceof TestGenerationError) {
        stream.markdown(`\n⚠️ **Generación de Test Fallida**\n\n`);
        stream.markdown(`${error.message}\n\n`);
        stream.markdown('💡 **Sugerencias:**\n');
        stream.markdown('- Revisa el test generado manualmente\n');
        stream.markdown('- Verifica si tu componente tiene dependencias complejas\n');
        stream.markdown('- Intenta aumentar `spfx-tester.maxHealingAttempts` en la configuración\n');
        return { errorDetails: { message: error.message } };
    }

    if (error instanceof FileValidationError) {
        stream.markdown(`\n❌ **Error de Validación de Archivo**\n\n`);
        stream.markdown(`${error.message}\n\n`);
        stream.markdown(`Archivo: \`${error.filePath}\`\n`);
        return { errorDetails: { message: error.message } };
    }

    if (error instanceof WorkspaceNotFoundError) {
        stream.markdown(`\n❌ **Workspace No Encontrado**\n\n`);
        stream.markdown(error.message + '\n\n');
        return { errorDetails: { message: error.message } };
    }

    if (error instanceof SPFXTestAgentError) {
        stream.markdown(`\n❌ **Error (${error.code})**\n\n`);
        stream.markdown(`${error.message}\n\n`);
        return { errorDetails: { message: error.message } };
    }

    // Unknown error
    const errorMessage = error instanceof Error ? error.message : 'Ocurrió un error desconocido';
    stream.markdown(`\n❌ **Error Inesperado**\n\n`);
    stream.markdown(`${errorMessage}\n\n`);
    stream.markdown('💡 **Consejo:** Revisa el canal de salida "SPFX Test Agent" para más detalles.\n');
    stream.markdown('💡 Usa `View > Output` y selecciona "SPFX Test Agent" del desplegable.\n');
    
    // Suggest opening the output channel
    stream.button({
        command: 'workbench.action.output.show',
        title: 'Show Output Channel'
    });

    return { errorDetails: { message: errorMessage } };
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
