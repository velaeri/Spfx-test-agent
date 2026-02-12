import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TestAgent } from './agent/TestAgent';
import { Logger, LogLevel } from './services/Logger';
import { StateService } from './services/StateService';
import { ProjectSetupService } from './services/ProjectSetupService';
import { JestConfigurationService } from './services/JestConfigurationService';
import { PackageInstallationService } from './services/PackageInstallationService';
import { DependencyDetectionService } from './services/DependencyDetectionService';
import { TelemetryService } from './services/TelemetryService';
import { LLMProviderFactory } from './factories/LLMProviderFactory';
import { FileScanner } from './utils/FileScanner';
import { ConfigService } from './services/ConfigService';
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

    // Force strict setup with autoInstall check
    stream.progress('Verificando estado para instalación completa...');
    
    // Perform FULL setup (create config files + install dependencies)
    stream.markdown(`\n🔧 **Iniciando configuración completa (Config + Dependencias)...**\n\n`);
    
    const setupResult = await setupService.setupProject(workspaceRoot, { autoInstall: true });

    if (!setupResult.success) {
        stream.markdown(`\n❌ **Error crítico en el Setup**\n\n`);
        stream.markdown(`Por favor, revisa el Output Channel "SPFX Test Agent" para más detalles.\n`);
        return { errorDetails: { message: 'Setup failed' } };
    }

    // After setup, VERIFY installation with a dry-run check
    stream.progress('Verificando instalación...');
    const verifyStatus = await setupService.checkProjectSetup(workspaceRoot);
    
    // Explicitly check ts-jest installation
    const configService = new JestConfigurationService();
    const tsJestInstalled = configService.isTsJestInstalled(workspaceRoot);

    // Run verification test
    let verificationPassed = false;
    let verificationMsg = '';

    if (verifyStatus.missingDependencies.length === 0 && tsJestInstalled) {
        stream.progress('Ejecutando test de verificación...');
        const verifyResult = await setupService.verifyInstallation(workspaceRoot);
        verificationPassed = verifyResult.success;
        verificationMsg = verifyResult.message;
    }

    if (verifyStatus.missingDependencies.length === 0 && tsJestInstalled && verificationPassed) {
         stream.markdown(`\n🎉 **Configuración Completada y Verificada**\n\n`);
         stream.markdown(`✅ Dependencias instaladas (Jest, ts-jest, types)\n`);
         stream.markdown(`✅ Archivos de configuración creados\n`);
         stream.markdown(`✅ Scripts de package.json actualizados\n`);
         stream.markdown(`✅ **Test de verificación pasado correctamente**\n\n`);
         stream.markdown(`**Listo para usar:** \`@spfx-tester /generate-all\`\n`);
         telemetryService.trackSetup(true, Date.now() - setupStartTime);
         return { metadata: { command: 'setup' } };
    } else {
          stream.markdown(`\n⚠️ **Advertencia post-instalación**\n\n`);
          stream.markdown(`El proceso terminó, pero hubo problemas de verificación:\n`);
          if (!tsJestInstalled) stream.markdown(`- ❌ \`ts-jest\` no encontrado en node_modules\n`);
          verifyStatus.missingDependencies.forEach(d => stream.markdown(`- ❌ Faltante: \`${d}\`\n`));
          
          if (!verificationPassed && verificationMsg) {
             stream.markdown(`- ❌ **El test de verificación falló:**\n`);
             stream.markdown(`\`\`\`\n${verificationMsg}\n\`\`\`\n`);
          }

          stream.markdown(`\nIntenta ejecutar manualmente: \`npm install\` y revisa los logs.\n`);
          return { errorDetails: { message: 'Verification failed' } };
    }
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

    // CRITICAL: Also check if ts-jest is physically in node_modules
    const configService = new JestConfigurationService();
    const tsJestInstalled = configService.isTsJestInstalled(workspaceRoot);
    if (!tsJestInstalled && !setupStatus.missingDependencies.includes('ts-jest')) {
        setupStatus.missingDependencies.push('ts-jest');
    }

    // Check if setup is needed
    if (!setupStatus.hasJest || setupStatus.missingDependencies.length > 0) {
        stream.markdown(`\n⚠️ **Entorno Jest incompleto**\n\n`);
        stream.markdown(`- Jest instalado: ${setupStatus.hasJest ? '✅' : '❌'}\n`);
        stream.markdown(`- ts-jest en node_modules: ${tsJestInstalled ? '✅' : '❌ (REQUERIDO)'}\n`);
        stream.markdown(`- Dependencias faltantes: **${setupStatus.missingDependencies.length}**\n\n`);

        //  Use intelligent installation with LLM analysis
        stream.markdown(`🧠 **Intentando instalación inteligente con análisis de IA...**\n\n`);
        stream.progress('Analizando proyecto y consultando IA...');

        try {
            const pkgService = new PackageInstallationService();
            const depService = new DependencyDetectionService();
            const config = ConfigService.getConfig();

            // First attempt: try heuristic versions
            const existingJest = depService.getExistingJestVersion(workspaceRoot);
            const tsJestVersion = (existingJest && existingJest.major === 28) ? '^28.0.8' : '^29.1.1';
            const typesJestVersion = (existingJest && existingJest.major === 28) ? '^28.1.0' : '^29.5.11';

            stream.markdown(`📦 Instalando dependencias básicas...\n`);
            let result = await pkgService.installPackages(workspaceRoot, [
                `ts-jest@${tsJestVersion}`,
                `@types/jest@${typesJestVersion}`,
                'identity-obj-proxy@^3.0.0'
            ]);

            // If failed, use AI to analyze and fix
            if (!result.success && result.error) {
                stream.markdown(`⚠️ Instalación inicial falló. Consultando IA para análisis...\n\n`);
                
                const packageJsonPath = path.join(workspaceRoot, 'package.json');
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

                const llmProvider = LLMProviderFactory.createProvider();
                const solution = await llmProvider.analyzeAndFixError(result.error, {
                    packageJson,
                    errorType: 'dependency'
                });

                stream.markdown(`💡 **AI Diagnosis:** ${solution.diagnosis}\n\n`);

                if (solution.packages && solution.packages.length > 0) {
                    stream.markdown(`📦 Instalando versiones recomendadas por IA: ${solution.packages.join(', ')}\n`);
                    result = await pkgService.installPackages(workspaceRoot, solution.packages);

                    if (!result.success) {
                        throw new Error(`AI-recommended installation also failed: ${result.error}`);
                    }
                }
            }

            // Create config files if needed
            const configCreated = await configService.ensureValidJestConfig(workspaceRoot);
            if (configCreated) {
                stream.markdown(`🔧 Creado jest.config.js con ts-jest\n`);
            }

            const jestSetupPath = path.join(workspaceRoot, 'jest.setup.js');
            if (!fs.existsSync(jestSetupPath)) {
                await configService.createJestSetup(workspaceRoot);
            }
            await configService.createMockDirectory(workspaceRoot);
            await configService.updatePackageJsonScripts(workspaceRoot);

            stream.markdown(`\n✅ **Entorno configurado exitosamente con análisis IA**\n\n`);
            return true;
        } catch (error) {
            stream.markdown(`\n❌ **La instalación inteligente falló**\n\n`);
            logger.error('Intelligent setup failed', error);
            
            const errorMsg = error instanceof Error ? error.message : 'Error desconocido';
            stream.markdown(`Error: ${errorMsg}\n\n`);

            // Fallback: ask user to run manual setup
            stream.markdown(`### ⚠️ Acción Requerida (setup manual)\n\n`);
            stream.markdown(`El análisis automático con IA no pudo resolver el problema.\n\n`);
            stream.markdown(`Por favor, ejecuta \`/setup\` para configuración manual.\n\n`);

            stream.button({
                command: 'spfx-tester.setup',
                title: '🛠️ Ejecutar @spfx-tester /setup ahora'
            });
            
            return false;
        }
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
    const llmProvider = LLMProviderFactory.createProvider();
    const agent = new TestAgent(llmProvider, stateService);
    
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
    stateService: StateService,
    targetPath?: string
): Promise<vscode.ChatResult> {
    const batchStartTime = Date.now();
    telemetryService.trackCommandExecution('generate-all');
    
    // Determine which folders/URIs to scan
    let scanTargets: (vscode.WorkspaceFolder | vscode.Uri)[] = [];
    
    if (targetPath) {
        // User provided a specific path
        const normalizedPath = path.resolve(targetPath);
        
        if (fs.existsSync(normalizedPath)) {
            const uri = vscode.Uri.file(normalizedPath);
            scanTargets = [uri];
            logger.info(`Using specified path: ${normalizedPath}`);
        } else {
            stream.markdown(`❌ **Error:** La ruta especificada no existe: \`${targetPath}\`\n\n`);
            return { metadata: { command: 'generate-all', error: 'Invalid path' } };
        }
    } else {
        // No specific path - use all workspace folders
        const workspaceFolders = vscode.workspace.workspaceFolders;
        
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new WorkspaceNotFoundError();
        }
        
        scanTargets = [...workspaceFolders];
    }

    stream.markdown(`## 🚀 Generando Tests${targetPath ? ' para Proyecto Específico' : ' para Todo el Workspace'}\n\n`);
    if (targetPath) {
        stream.markdown(`📂 **Ruta de escaneo:** \`${targetPath}\`\n\n`);
    }
    stream.progress('Escaneando archivos fuente...');

    let allFiles: vscode.Uri[] = [];

    // Scan target folders/URIs
    for (const target of scanTargets) {
        const files = await FileScanner.findSourceFiles(target);
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
        
        const llmProvider = LLMProviderFactory.createProvider();
        const agent = new TestAgent(llmProvider, stateService);

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