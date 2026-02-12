import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TestAgent } from './agent/TestAgent';
import { Logger, LogLevel } from './services/Logger';
import { StateService } from './services/StateService';
import { ProjectSetupService } from './services/ProjectSetupService';
import { TelemetryService } from './services/TelemetryService';
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

const logger = Logger.getInstance();
const telemetryService = TelemetryService.getInstance();

/**
 * Handle setup command - Configure Jest environment
 */
export async function handleSetupRequest(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const setupStartTime = Date.now();
    telemetryService.trackCommandExecution('setup');
    
    // Get workspace folder
    const workspaceFolders = vscode.workspace.workspaceFolders;
    
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new WorkspaceNotFoundError();
    }

    stream.markdown(`## 🔧 Configurando Entorno Jest\n\n`);
    stream.progress('Buscando proyectos Node.js...');

    // Find all projects with package.json
    const setupService = new ProjectSetupService();
    const projects: { path: string; name: string; hasJest: boolean }[] = [];

    for (const folder of workspaceFolders) {
        const packageJsonPath = path.join(folder.uri.fsPath, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            const status = await setupService.checkProjectSetup(folder.uri.fsPath);
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            projects.push({
                path: folder.uri.fsPath,
                name: packageJson.name || path.basename(folder.uri.fsPath),
                hasJest: status.hasJest
            });
        }
    }

    if (projects.length === 0) {
        stream.markdown(`❌ **No se encontró ningún proyecto Node.js (package.json) en el workspace**\n\n`);
        stream.markdown(`Por favor, abre la carpeta de tu proyecto SPFx.\n\n`);
        stream.markdown(`💡 **Sugerencia:** \`File > Open Folder\` y selecciona tu proyecto SPFx.\n`);
        return { errorDetails: { message: 'No package.json found' } };
    }

    // Select project if multiple
    let workspaceRoot: string;
    if (projects.length > 1) {
        stream.markdown(`📁 **Encontrados ${projects.length} proyectos:**\n\n`);
        projects.forEach((p, i) => {
            stream.markdown(`${i + 1}. \`${p.name}\` ${p.hasJest ? '✅ Jest' : '❌ Sin Jest'}\n`);
        });
        stream.markdown(`\n`);
        
        // For now, use the first one (we can improve this later with buttons)
        workspaceRoot = projects[0].path;
        stream.markdown(`🎯 Configurando: **${projects[0].name}**\n\n`);
    } else {
        workspaceRoot = projects[0].path;
        stream.markdown(`📁 Proyecto: **${projects[0].name}**\n\n`);
    }

    stream.progress('Verificando estado actual...');
    const setupStatus = await setupService.checkProjectSetup(workspaceRoot);

    // Show current status
    stream.markdown(`### 📊 Estado Actual\n\n`);
    stream.markdown(`- Package.json: ${setupStatus.hasPackageJson ? '✅' : '❌'}\n`);
    stream.markdown(`- Jest instalado: ${setupStatus.hasJest ? '✅' : '❌'}\n`);
    stream.markdown(`- Jest config: ${setupStatus.hasJestConfig ? '✅' : '⚠️ (se creará)'}\n`);
    stream.markdown(`- Jest setup: ${setupStatus.hasJestSetup ? '✅' : '⚠️ (se creará)'}\n`);
    stream.markdown(`- Dependencias faltantes: **${setupStatus.missingDependencies.length}**\n\n`);

    if (setupStatus.missingDependencies.length > 0) {
        stream.markdown(`### 📦 Dependencias a Instalar\n\n`);
        setupStatus.missingDependencies.forEach(dep => {
            stream.markdown(`  - \`${dep}\`\n`);
        });
        stream.markdown(`\n`);
    }

    // Check if already configured
    if (setupStatus.hasJest && 
        setupStatus.missingDependencies.length === 0 && 
        setupStatus.hasJestConfig && 
        setupStatus.hasJestSetup) {
        stream.markdown(`✅ **¡El entorno Jest ya está completamente configurado!**\n\n`);
        stream.markdown(`Puedes usar \`@spfx-tester /generate\` para generar tests.\n`);
        return { metadata: { command: 'setup' } };
    }

    // Perform setup (create config files, generate install command)
    stream.markdown(`\n🔧 **Creando archivos de configuración...**\n\n`);
    stream.progress('Creando archivos Jest...');

    const setupResult = await setupService.setupProject(workspaceRoot);

    if (!setupResult.success) {
        stream.markdown(`\n❌ **Error al crear archivos de configuración**\n\n`);
        stream.markdown(`Por favor, revisa el Output Channel "SPFX Test Agent" para más detalles.\n`);
        return { errorDetails: { message: 'Setup failed' } };
    }

    // Show success message
    stream.markdown(`\n✅ **Archivos de configuración creados correctamente**\n\n`);
    
    // If there are missing dependencies, show the install command
    if (setupResult.installCommand) {
        stream.markdown(`### 📦 Instalación de Dependencias\n\n`);
        stream.markdown(`⚠️ **Faltan ${setupStatus.missingDependencies.length} dependencias Jest**\n\n`);
        stream.markdown(`Por favor, ejecuta el siguiente comando en el terminal:\n\n`);
        stream.markdown(`\`\`\`bash\n${setupResult.installCommand}\n\`\`\`\n\n`);
        stream.button({
            command: 'workbench.action.terminal.sendSequence',
            arguments: [{ text: `${setupResult.installCommand}\n` }],
            title: '▶️ Ejecutar comando'
        });
        stream.markdown(`\n\n💡 **Nota:** Este comando usa \`--legacy-peer-deps\` para evitar conflictos de dependencias peer.\n\n`);
        stream.markdown(`Las versiones han sido analizadas por IA para garantizar compatibilidad con tu proyecto.\n\n`);
    } else {
        stream.markdown(`### 🎉 Configuración Completada\n\n`);
        stream.markdown(`✅ Todas las dependencias ya están instaladas\n`);
    }
    
    stream.markdown(`### 📁 Archivos Creados\n\n`);
    stream.markdown(`- \`jest.config.js\` - Configuración de Jest\n`);
    stream.markdown(`- \`jest.setup.js\` - Inicialización de testing-library\n`);
    stream.markdown(`- \`__mocks__/fileMock.js\` - Mock para archivos estáticos\n\n`);
    stream.markdown(`**Siguiente paso:** Usa \`@spfx-tester /generate\` para generar tests automáticamente.\n`);

    const setupDuration = Date.now() - setupStartTime;
    telemetryService.trackSetup(setupResult.success, setupDuration);

    logger.info('Setup completed successfully via chat command');

    return { metadata: { command: 'setup' } };
}

/**
 * Helper: Check and setup Jest environment if needed
 * Returns true if environment is ready, false if user cancelled
 */
async function ensureJestEnvironment(
    workspaceRoot: string,
    stream: vscode.ChatResponseStream
): Promise<boolean> {
    stream.progress('Verificando entorno Jest...');
    const setupService = new ProjectSetupService();
    const setupStatus = await setupService.checkProjectSetup(workspaceRoot);

    if (!setupStatus.hasPackageJson) {
        stream.markdown(`❌ **No se encontró package.json en la raíz del proyecto**\n\n`);
        return false;
    }

    // Check if setup is needed
    if (!setupStatus.hasJest || setupStatus.missingDependencies.length > 0) {
        stream.markdown(`\n❌ **Entorno Jest no está listo**\n\n`);
        stream.markdown(`- Jest instalado: ${setupStatus.hasJest ? '✅' : '❌'}\n`);
        stream.markdown(`- Dependencias faltantes: **${setupStatus.missingDependencies.length}**\n\n`);

        if (setupStatus.missingDependencies.length > 0) {
            stream.markdown(`### 📦 Dependencias Faltantes\n\n`);
            setupStatus.missingDependencies.forEach(dep => {
                stream.markdown(`  - \`${dep}\`\n`);
            });
            stream.markdown(`\n`);
        }

        stream.markdown(`### ⚠️ Acción Requerida\n\n`);
        stream.markdown(`**No puedo generar tests sin las dependencias Jest instaladas.**\n\n`);
        
        if (setupStatus.installCommand) {
            stream.markdown(`Por favor, ejecuta el siguiente comando en el terminal:\n\n`);
            stream.markdown(`\`\`\`bash\n${setupStatus.installCommand}\n\`\`\`\n\n`);
            stream.button({
                command: 'workbench.action.terminal.sendSequence',
                arguments: [{ text: `${setupStatus.installCommand}\n` }],
                title: '▶️ Ejecutar comando'
            });
            stream.markdown(`\n\n`);
        }
        
        stream.markdown(`**O usa:** \`@spfx-tester /setup\` para configurar el entorno paso a paso.\n\n`);
        stream.markdown(`Después de instalar las dependencias, vuelve a ejecutar \`/generate-all\`.\n`);
        
        return false;
    } else {
        stream.markdown(`✅ Entorno Jest listo\n\n`);
        return true;
    }
}

/**
 * Handle generation for a single file (original behavior)
 */
export async function handleGenerateSingleRequest(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    stateService: StateService
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

    // ✨ Check and setup Jest environment if needed
    const envReady = await ensureJestEnvironment(workspaceRoot, stream);
    if (!envReady) {
        return { metadata: { command: 'generate' } };
    }

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
export async function handleGenerateAllRequest(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    stateService: StateService
): Promise<vscode.ChatResult> {
    const batchStartTime = Date.now();
    telemetryService.trackCommandExecution('generate-all');
    
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

    // Group files by project (for better Jest execution)
    const projectMap = FileScanner.groupFilesByProject(filesWithoutTests);

    stream.markdown(`📁 Encontrados **${projectMap.size}** proyecto(s)\n\n`);

    // ✨ Check and setup Jest environment ONCE before processing all files
    const firstProjectRoot = projectMap.keys().next().value;
    
    if (!firstProjectRoot) {
        stream.markdown('⚠️ No se encontró ningún proyecto válido.\n');
        return { metadata: { command: 'generate-all' } };
    }
    
    const envReady = await ensureJestEnvironment(firstProjectRoot, stream);
    if (!envReady) {
        return { metadata: { command: 'generate-all' } };
    }

    // Ask for confirmation to proceed
    stream.markdown(`⚠️ Esto generará tests para ${filesWithoutTests.length} archivos. Puede tomar varios minutos.\n\n`);

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

    const batchDuration = Date.now() - batchStartTime;
    telemetryService.trackBatchGeneration(
        currentFile,
        successCount,
        failCount,
        batchDuration
    );

    logger.info('Batch test generation completed', {
        total: currentFile,
        success: successCount,
        failed: failCount
    });

    return { metadata: { command: 'generate-all' } };
}

/**
 * Centralized error handling with user-friendly messages
 */
export function handleError(
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