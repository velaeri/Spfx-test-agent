import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TestAgent } from './agent/TestAgent';
import { Logger, LogLevel } from './services/Logger';
import { StateService } from './services/StateService';
import { ProjectSetupService } from './services/ProjectSetupService';
import { TelemetryService } from './services/TelemetryService';
import { CoverageService, CoverageReport } from './services/CoverageService';
import { LLMProviderFactory } from './factories/LLMProviderFactory';
import { BatchGenerationPlan } from './interfaces/ILLMProvider';
import { FileScanner } from './utils/FileScanner';
import { spawn } from 'child_process';
import { 
    WorkspaceNotFoundError, 
    FileValidationError,
    JestNotFoundError,
    TestGenerationError,
    RateLimitError,
    LLMNotAvailableError,
    SPFXTestAgentError
} from './errors/CustomErrors';
import { LLMOrchestrator } from './orchestrator/LLMOrchestrator';

const logger = Logger.getInstance();
const telemetryService = TelemetryService.getInstance();

/**
 * Handle setup command - Configure Jest environment
 */
/**
 * Handle /install command - Execute npm install with LLM-powered auto-healing
 */
export async function handleInstallRequest(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    installCommand?: string,
    maxRetries: number = 3
): Promise<vscode.ChatResult> {
    const startTime = Date.now();
    telemetryService.trackCommandExecution('install');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new WorkspaceNotFoundError();
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const setupService = new ProjectSetupService();
    const setupStatus = await setupService.checkProjectSetup(workspaceRoot);

    // If no command provided, get it from setupService
    let currentCommand = installCommand || setupStatus.installCommand;

    if (!currentCommand) {
        stream.markdown('✅ **No hay dependencias que instalar**\n\n');
        stream.markdown('Todas las dependencias Jest ya están instaladas.\n');
        return { metadata: { command: 'install' } };
    }

    stream.markdown('## 📦 Instalando Dependencias Jest\n\n');
    stream.markdown(`**Comando inicial:**\n\`\`\`bash\n${currentCommand}\n\`\`\`\n\n`);

    const llmProvider = LLMProviderFactory.createProvider();
    let lastError = '';
    let attempt = 0;

    // 🔄 Auto-healing retry loop
    while (attempt < maxRetries) {
        attempt++;
        
        if (attempt > 1) {
            stream.markdown(`\n---\n\n### 🔄 Intento ${attempt}/${maxRetries}\n\n`);
            stream.markdown(`\`\`\`bash\n${currentCommand}\n\`\`\`\n\n`);
        }

        // Execute npm install with real-time output streaming
        const result = await executeNpmInstall(currentCommand, workspaceRoot, stream, token);

        if (result.success) {
            const duration = Date.now() - startTime;
            stream.markdown(`\n✅ **Instalación completada exitosamente** (${(duration / 1000).toFixed(1)}s)\n\n`);
            if (attempt > 1) {
                stream.markdown(`💡 Resuelto en el intento ${attempt} mediante auto-healing con IA.\n\n`);
            }
            stream.markdown('Siguiente paso: Usa `@test-agent /generate-all` para generar tests.\n');
            return { metadata: { command: 'install', attempts: attempt } };
        }

        // Installation failed - save error for potential manual suggestions later
        lastError = result.error;

        stream.markdown(`\n❌ **Instalación fallida**\n\n`);
        
        // Show error preview
        const errorPreview = result.error.substring(0, 800);
        stream.markdown(`\`\`\`\n${errorPreview}${result.error.length > 800 ? '\n... (truncado)' : ''}\n\`\`\`\n\n`);
        
        // If we have more retries left, use LLM to auto-heal
        if (attempt < maxRetries) {
            stream.markdown('🧠 **Analizando error con IA y ajustando versiones...**\n\n');
            stream.progress(`Healing attempt ${attempt}/${maxRetries}...`);

            try {
                const pkgContext = await getPackageJsonContext(workspaceRoot);
                const errorSummary = extractNpmErrorSummary(result.error);
                
                const healingPrompt = `Task: Fix npm dependency installation error by adjusting package versions.

Current package.json:
${pkgContext}

Failed command:
${currentCommand}

Error summary:
${errorSummary}

Instructions:
1. Analyze the error (ETARGET, ERESOLVE, peer deps, etc.)
2. Suggest a DIFFERENT command with adjusted versions or flags
3. Be specific - provide exact version numbers that are compatible

Format:
ANALISIS: [brief explanation of the issue]
COMANDO: npm install --save-dev [adjusted-packages]`;

                const llmResult = await llmProvider.generateTest({
                    sourceCode: healingPrompt,
                    fileName: 'npm-healing-analysis.txt',
                    systemPrompt: 'You are an expert npm dependency resolver. Analyze installation errors and provide alternative commands with compatible versions.'
                });

                // Check if LLM refused
                if (llmResult.code.toLowerCase().includes("sorry") && llmResult.code.toLowerCase().includes("can't assist")) {
                    stream.markdown('⚠️ **El LLM rechazó la solicitud** - abortando auto-healing.\n\n');
                    break; // Exit retry loop
                }

                // Extract analysis and suggested command
                const analysis = extractSection(llmResult.code, 'ANALISIS');
                let suggestedCommand = extractSection(llmResult.code, 'COMANDO');
                
                // Fallback: try to extract npm command from full response
                if (!suggestedCommand) {
                    const npmMatch = llmResult.code.match(/npm\s+install[^\n]+/);
                    if (npmMatch) {
                        suggestedCommand = npmMatch[0];
                    }
                }
                
                if (analysis) {
                    stream.markdown(`**Diagnóstico IA:** ${analysis}\n\n`);
                }

                if (suggestedCommand) {
                    const cleanCommand = suggestedCommand.replace(/```[\w]*\n?|```/g, '').trim();
                    
                    // Verify the command is actually different (avoid infinite loops)
                    if (cleanCommand === currentCommand) {
                        stream.markdown('⚠️ **El LLM sugirió el mismo comando** - no hay mejora posible.\n\n');
                        break; // Exit retry loop
                    }
                    
                    // Update command for next iteration
                    currentCommand = cleanCommand;
                    stream.markdown(`💡 **Nuevo comando detectado** - reintentando automáticamente...\n\n`);
                    
                    // Small delay to avoid rate limits
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue; // Retry with new command
                } else {
                    stream.markdown('⚠️ **El LLM no pudo generar un comando alternativo**\n\n');
                    break; // Exit retry loop
                }

            } catch (llmError) {
                logger.error('LLM healing failed', llmError);
                stream.markdown(`⚠️ **Error en auto-healing:** ${llmError instanceof Error ? llmError.message : 'Unknown'}\n\n`);
                break; // Exit retry loop on LLM errors
            }
        }
    }

    // All retries exhausted or LLM couldn't help - show manual suggestions
    stream.markdown(`\n---\n\n### ⚠️ Auto-healing agotado\n\n`);
    stream.markdown(`No se pudo resolver automáticamente después de ${attempt} intento(s).\n\n`);
    suggestManualFix(stream, lastError, currentCommand);

    return { 
        metadata: { command: 'install', attempts: attempt },
        errorDetails: { message: 'npm install failed after retries' } 
    };
}

/**
 * Execute npm install with real-time output streaming
 */
async function executeNpmInstall(
    command: string,
    cwd: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<{ success: boolean; output: string; error: string }> {
    return new Promise((resolve) => {
        const parts = command.split(' ');
        const cmd = parts[0];
        const args = parts.slice(1);

        let output = '';
        let errorOutput = '';

        stream.progress(`Ejecutando: ${command}`);

        const child = spawn(cmd, args, {
            cwd,
            shell: true,
            env: { ...process.env, FORCE_COLOR: '0' }
        });

        child.stdout?.on('data', (data) => {
            const text = data.toString();
            output += text;
            // Stream progress lines
            const lines = text.split('\n').filter((l: string) => l.trim());
            for (const line of lines) {
                if (line.includes('added') || line.includes('updated') || line.includes('removed')) {
                    stream.progress(line.substring(0, 100));
                }
            }
        });

        child.stderr?.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            // npm writes warnings to stderr even on success
        });

        child.on('error', (error) => {
            logger.error('npm install process error', error);
            resolve({ success: false, output, error: `Process error: ${error.message}` });
        });

        child.on('close', (code) => {
            logger.info(`npm install exited with code ${code}`);
            if (code === 0) {
                resolve({ success: true, output, error: errorOutput });
            } else {
                resolve({ success: false, output, error: errorOutput || output });
            }
        });

        token.onCancellationRequested(() => {
            child.kill();
            resolve({ success: false, output, error: 'Cancelled by user' });
        });
    });
}

/**
 * Get package.json context for LLM analysis
 */
async function getPackageJsonContext(workspaceRoot: string): Promise<string> {
    try {
        const packageJsonPath = path.join(workspaceRoot, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return 'package.json not found';
        }
        const content = fs.readFileSync(packageJsonPath, 'utf-8');
        const pkg = JSON.parse(content);
        return JSON.stringify({
            name: pkg.name,
            version: pkg.version,
            dependencies: pkg.dependencies || {},
            devDependencies: pkg.devDependencies || {},
            engines: pkg.engines || {}
        }, null, 2);
    } catch (error) {
        return `Error reading package.json: ${error}`;
    }
}

/**
 * Extract a section from LLM response (e.g., "ANALISIS: ...")
 */
function extractSection(text: string, sectionName: string): string | null {
    const regex = new RegExp(`${sectionName}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`, 'i');
    const match = text.match(regex);
    return match ? match[1].trim() : null;
}

/**
 * Extract key information from npm error for LLM analysis
 */
function extractNpmErrorSummary(errorText: string): string {
    const lines = errorText.split('\n');
    const relevantLines: string[] = [];
    
    // Extract key error lines (ETARGET, ERESOLVE, peer dependency conflicts, etc.)
    for (const line of lines) {
        if (line.includes('npm error') || 
            line.includes('ERESOLVE') ||
            line.includes('ETARGET') ||
            line.includes('peer dep') ||
            line.includes('notarget') ||
            line.includes('Could not resolve')) {
            relevantLines.push(line);
        }
        if (relevantLines.length >= 15) break; // Limit to first 15 key lines
    }
    
    return relevantLines.length > 0 ? relevantLines.join('\n') : errorText.substring(0, 1000);
}

/**
 * Show manual fix suggestions when LLM can't help
 */
function suggestManualFix(stream: vscode.ChatResponseStream, error: string, originalCommand: string): void {
    stream.markdown('💡 **Sugerencias para resolver manualmente:**\n\n');
    
    // Analyze error type and give specific advice
    if (error.includes('ETARGET') || error.includes('notarget')) {
        stream.markdown('**Error ETARGET/notarget:** No se encontró la versión especificada.\n\n');
        stream.markdown('Causas comunes:\n');
        stream.markdown('- Las versiones exactas especificadas ya no existen en npm\n');
        stream.markdown('- El registro npm está temporalmente inaccesible\n');
        stream.markdown('- El rango de versión es demasiado restrictivo\n\n');
        stream.markdown('Soluciones:\n');
        stream.markdown('1. **Usa versiones más flexibles:** Cambia rangos estrictos como `@28.0.8` por `@^28.0.0`\n');
        stream.markdown('2. **Verifica versiones disponibles:** `npm view <package> versions`\n');
        stream.markdown('3. **Prueba con latest:** `npm install --save-dev <package>@latest`\n');
        stream.markdown('4. **Instala sin especificar versión:** deja que npm elija la compatible\n\n');
    } else if (error.includes('ERESOLVE') || error.includes('peer dep')) {
        stream.markdown('**Error ERESOLVE/peer dependency:** Conflicto de versiones entre paquetes.\n\n');
        stream.markdown('Soluciones:\n');
        stream.markdown('1. Usa `--force` en lugar de `--legacy-peer-deps`\n');
        stream.markdown('2. Revisa qué versión de React/TypeScript tienes instalada con `npm list react typescript`\n');
        stream.markdown('3. Actualiza React primero si es muy antigua: `npm update react react-dom`\n');
        stream.markdown('4. Instala dependencias de testing que coincidan con tu versión de React\n\n');
    } else {
        stream.markdown('Soluciones generales:\n');
        stream.markdown('- Revisa el error completo arriba para identificar el paquete problemático\n');
        stream.markdown('- Intenta instalar los paquetes uno por uno para aislar el conflicto\n');
        stream.markdown('- Verifica compatibilidad en [npmjs.com](https://npmjs.com)\n');
        stream.markdown('- Limpia cache de npm: `npm cache clean --force`\n\n');
    }
    
    // Suggest modifications to the ORIGINAL command (not hardcoded alternatives)
    stream.markdown('**Comandos alternativos basados en tu comando original:**\n\n');
    
    // Option 1: Try with --force instead of --legacy-peer-deps
    if (originalCommand.includes('--legacy-peer-deps') && !originalCommand.includes('--force')) {
        const forceCommand = originalCommand.replace('--legacy-peer-deps', '--force');
        stream.markdown('**Opción 1:** Usar `--force` en lugar de `--legacy-peer-deps`:\n');
        stream.markdown(`\`\`\`bash\n${forceCommand}\n\`\`\`\n\n`);
    }
    
    // Option 2: Install without version specifiers (let npm resolve)
    stream.markdown('**Opción 2:** Dejar que npm elija versiones compatibles automáticamente:\n');
    stream.markdown('```bash\nnpm install --save-dev --legacy-peer-deps jest @types/jest ts-jest @testing-library/react @testing-library/jest-dom\n```\n');
    stream.markdown('*(npm elegirá las versiones más recientes compatibles con tus dependencias)*\n\n');
    
    // Option 3: Manual steps
    stream.markdown('**Opción 3:** Instalar paquetes esenciales uno a uno:\n');
    stream.markdown('```bash\n# Instala jest primero\nnpm install --save-dev --legacy-peer-deps jest\n\n# Luego los paquetes de TypeScript\nnpm install --save-dev --legacy-peer-deps @types/jest ts-jest\n\n# Finalmente testing-library\nnpm install --save-dev --legacy-peer-deps @testing-library/react @testing-library/jest-dom\n```\n\n');
    
    stream.markdown('💡 **Tip:** Si todo falla, considera actualizar las dependencias principales primero (`npm update`) antes de instalar Jest.\n\n');
}

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
        stream.markdown(`Por favor, abre la carpeta de tu proyecto.\n\n`);
        stream.markdown(`💡 **Sugerencia:** \`File > Open Folder\` y selecciona tu proyecto.\n`);
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
        stream.markdown(`Puedes usar \`@test-agent /generate\` para generar tests.\n`);
        return { metadata: { command: 'setup' } };
    }

    // Perform setup (create config files, generate install command)
    stream.markdown(`\n🔧 **Creando archivos de configuración...**\n\n`);
    stream.progress('Creando archivos Jest...');

    const setupResult = await setupService.setupProject(workspaceRoot);

    if (!setupResult.success) {
        stream.markdown(`\n❌ **Error al crear archivos de configuración**\n\n`);
        stream.markdown(`Por favor, revisa el Output Channel "Test Agent" para más detalles.\n`);
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
            command: 'vscode.chat.open',
            arguments: [{ query: '@test-agent /install' }],
            title: '▶️ Instalar con asistencia IA'
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
    stream.markdown(`**Siguiente paso:** Usa \`@test-agent /generate\` para generar tests automáticamente.\n`);

    const setupDuration = Date.now() - setupStartTime;
    telemetryService.trackSetup(setupResult.success, setupDuration);

    logger.info('Setup completed successfully via chat command');

    return { metadata: { command: 'setup' } };
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-HEALING SYSTEM (LLM-First Jest Environment Validation)
// ═══════════════════════════════════════════════════════════════════════════

const MAX_HEALING_ATTEMPTS = 10; // Increased from 3 - persistent healing

/**
 * Check if the project's Jest config uses jsdom test environment
 */
async function projectUsesJsdom(workspaceRoot: string): Promise<boolean> {
    try {
        // Check jest.config.js / jest.config.ts / jest.config.mjs
        for (const configFile of ['jest.config.js', 'jest.config.ts', 'jest.config.mjs']) {
            const configPath = path.join(workspaceRoot, configFile);
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf-8');
                if (content.includes('jsdom')) {
                    return true;
                }
            }
        }
        // Check package.json jest config section
        const packageJsonPath = path.join(workspaceRoot, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            if (pkg.jest?.testEnvironment === 'jsdom') {
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Get installed Jest-related packages with versions for LLM context
 */
async function getInstalledJestPackages(workspaceRoot: string): Promise<Record<string, string>> {
    try {
        const packageJsonPath = path.join(workspaceRoot, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return {};
        }
        
        const content = fs.readFileSync(packageJsonPath, 'utf-8');
        const pkg = JSON.parse(content);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        
        // Filter Jest-related packages
        const jestPackages: Record<string, string> = {};
        const jestKeywords = ['jest', '@testing-library', 'ts-jest', 'react-test-renderer'];
        
        for (const [name, version] of Object.entries(allDeps)) {
            if (jestKeywords.some(keyword => name.includes(keyword))) {
                jestPackages[name] = version as string;
            }
        }
        
        return jestPackages;
    } catch (error) {
        logger.warn('Failed to read installed Jest packages', error);
        return {};
    }
}

/**
 * Pre-check: Detect common jsdom issues without calling LLM (fast path)
 * Returns { hasIssue: boolean, diagnosis: string, fix: string }
 */
async function detectJsdomIssue(workspaceRoot: string): Promise<{
    hasIssue: boolean;
    diagnosis: string;
    fix: string;
}> {
    try {
        const jestPackages = await getInstalledJestPackages(workspaceRoot);
        
        // Check if jest-environment-jsdom is missing
        if (!jestPackages['jest-environment-jsdom']) {
            return {
                hasIssue: true,
                diagnosis: 'jest-environment-jsdom package is not installed. This is REQUIRED for Jest 27+ when using testEnvironment: "jsdom".',
                fix: 'npm install --save-dev jest-environment-jsdom --legacy-peer-deps'
            };
        }
        
        // Check for version mismatch (Jest 29 with jsdom 25, etc.)
        const jestVersion = jestPackages['jest'];
        const jsdomVersion = jestPackages['jest-environment-jsdom'];
        
        if (jestVersion && jsdomVersion) {
            const jestMajor = parseInt(jestVersion.replace(/[^\d]/g, '').charAt(0), 10);
            const jsdomMajor = parseInt(jsdomVersion.replace(/[^\d]/g, '').charAt(0), 10);
            
            if (jestMajor !== jsdomMajor && jestMajor >= 27) {
                return {
                    hasIssue: true,
                    diagnosis: `Version mismatch detected: Jest ${jestVersion} with jest-environment-jsdom ${jsdomVersion}. Major versions MUST match for Jest 27+.`,
                    fix: `npm install --save-dev jest-environment-jsdom@^${jestMajor}.0.0 --legacy-peer-deps`
                };
            }
        }
        
        return { hasIssue: false, diagnosis: '', fix: '' };
    } catch (error) {
        logger.warn('detectJsdomIssue pre-check failed', error);
        return { hasIssue: false, diagnosis: '', fix: '' };
    }
}

/**
 * Execute a minimal Jest smoke test to validate environment
 * Returns { success: boolean, error: string }
 */
async function executeJestSmokeTest(
    workspaceRoot: string,
    token: vscode.CancellationToken
): Promise<{ success: boolean; error: string }> {
    return new Promise((resolve) => {
        // Create temporary test file in workspace root (avoids issues with spaces in paths under node_modules)
        const tempTestFile = path.join(workspaceRoot, '.test-agent-smoke.test.js');
        
        try {
            // Write minimal smoke test — environment-agnostic
            const smokeTestContent = `
// Temporary smoke test generated by test-agent
describe('Jest Environment Validation', () => {
  it('should execute basic assertions', () => {
    expect(1 + 1).toBe(2);
    expect(true).toBeTruthy();
  });
});
`;
            fs.writeFileSync(tempTestFile, smokeTestContent, 'utf-8');
            
            // Execute Jest on this single test using the simple file name pattern
            // This avoids issues with spaces in workspace paths
            const jestCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
            
            const child = spawn(jestCommand, ['jest', '.test-agent-smoke.test.js', '--no-coverage'], {
                cwd: workspaceRoot,
                shell: true
            });
            
            let output = '';
            let errorOutput = '';
            
            child.stdout?.on('data', (data) => {
                output += data.toString();
            });
            
            child.stderr?.on('data', (data) => {
                errorOutput += data.toString();
            });
            
            child.on('close', (code) => {
                // Cleanup temp file
                try {
                    if (fs.existsSync(tempTestFile)) {
                        fs.unlinkSync(tempTestFile);
                    }
                } catch (cleanupError) {
                    logger.warn('Failed to cleanup smoke test file', cleanupError);
                }
                
                if (code === 0) {
                    resolve({ success: true, error: '' });
                } else {
                    resolve({ success: false, error: errorOutput || output });
                }
            });
            
            child.on('error', (error) => {
                resolve({ success: false, error: `Process error: ${error.message}` });
            });
            
            token.onCancellationRequested(() => {
                child.kill();
                resolve({ success: false, error: 'Cancelled by user' });
            });
        } catch (error) {
            resolve({ success: false, error: `Failed to create smoke test: ${error}` });
        }
    });
}

/**
 * Validate Jest environment with auto-healing loop
 * This is the main entry point for LLM-first validation and repair
 */
async function validateJestEnvironmentAndHeal(
    workspaceRoot: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    canAutoHeal: boolean = true
): Promise<boolean> {
    stream.progress('🔍 Validating Jest environment with smoke test...');
    
    let attempt = 0;
    let lastDiagnosis = '';
    
    while (attempt < MAX_HEALING_ATTEMPTS) {
        attempt++;
        
        if (attempt > 1) {
            stream.markdown(`\n---\n\n### 🔄 Healing Attempt ${attempt}/${MAX_HEALING_ATTEMPTS}\n\n`);
        }
        
        // 1️⃣ PRE-CHECK: Fast detection of common jsdom issues (only if project uses jsdom)
        const usesJsdom = await projectUsesJsdom(workspaceRoot);
        const jsdomIssue = usesJsdom ? await detectJsdomIssue(workspaceRoot) : { hasIssue: false, diagnosis: '', fix: '' };
        
        if (jsdomIssue.hasIssue && canAutoHeal) {
            stream.markdown(`⚡ **Pre-check detected known issue:**\n\n`);
            stream.markdown(`${jsdomIssue.diagnosis}\n\n`);
            stream.markdown(`🔧 **Auto-fixing...**\n\n`);
            stream.markdown(`\`\`\`bash\n${jsdomIssue.fix}\n\`\`\`\n\n`);
            
            // Auto-execute fix
            const fixResult = await executeNpmInstall(jsdomIssue.fix, workspaceRoot, stream, token);
            
            if (!fixResult.success) {
                stream.markdown(`❌ **Auto-fix failed:** ${fixResult.error.substring(0, 300)}\n\n`);
                // Continue to LLM diagnosis
            } else {
                stream.markdown(`✅ **Fixed successfully**\n\n`);
                // Continue to validation
            }
        }
        
        // 2️⃣ SMOKE TEST: Validate environment with minimal test
        stream.progress(`Running smoke test (attempt ${attempt})...`);
        const testResult = await executeJestSmokeTest(workspaceRoot, token);
        
        if (testResult.success) {
            if (attempt === 1) {
                stream.markdown(`✅ **Jest environment validated successfully**\n\n`);
            } else {
                stream.markdown(`\n✅ **Jest environment healed successfully** (attempt ${attempt})\n\n`);
            }
            return true;
        }
        
        // 3️⃣ FAILED: Analyze error and attempt repair
        stream.markdown(`\n⚠️ **Smoke test failed**\n\n`);
        
        const errorPreview = testResult.error.substring(0, 600);
        stream.markdown(`\`\`\`\n${errorPreview}${testResult.error.length > 600 ? '\n...(truncated)' : ''}\n\`\`\`\n\n`);
        
        if (!canAutoHeal) {
            stream.markdown(`❌ **Auto-healing is disabled. Cannot proceed.**\n\n`);
            return false;
        }
        
        // Check if we're making progress (diagnosis changed)
        if (attempt > 3 && testResult.error === lastDiagnosis) {
            stream.markdown(`⚠️ **Error persists unchanged after ${attempt} attempts.**\n\n`);
            stream.markdown(`This may require manual intervention.\n\n`);
            return false;
        }
        
        lastDiagnosis = testResult.error;
        
        // 4️⃣ LLM DIAGNOSIS: Ask AI for solution
        stream.markdown(`🧠 **Analyzing error with AI...**\n\n`);
        stream.progress('Consulting LLM for diagnosis...');
        
        try {
            const llmProvider = LLMProviderFactory.createProvider();
            const installedPackages = await getInstalledJestPackages(workspaceRoot);
            const packageJsonPath = path.join(workspaceRoot, 'package.json');
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            
            // Use analyzeAndFixError instead of diagnoseInstallError
            const diagnosis = await llmProvider.analyzeAndFixError(testResult.error, {
                packageJson,
                errorType: 'execution',
                jestConfig: 'testEnvironment: jsdom'
            });
            
            stream.markdown(`**AI Diagnosis:**\n\n${diagnosis.diagnosis}\n\n`);
            
            // Build command from packages or commands suggested by LLM
            let recommendedCommand = '';
            if (diagnosis.commands && diagnosis.commands.length > 0) {
                recommendedCommand = diagnosis.commands[0];
            } else if (diagnosis.packages && diagnosis.packages.length > 0) {
                recommendedCommand = `install --save-dev ${diagnosis.packages.join(' ')} --legacy-peer-deps`;
            }
            
            if (recommendedCommand) {
                stream.markdown(`**Recommended fix:**\n\n\`\`\`bash\nnpm ${recommendedCommand}\n\`\`\`\n\n`);
                stream.markdown(`🔧 **Executing fix automatically...**\n\n`);
                
                // Auto-execute LLM's recommended command
                const healResult = await executeNpmInstall(
                    recommendedCommand,
                    workspaceRoot,
                    stream,
                    token
                );
                
                if (!healResult.success) {
                    stream.markdown(`❌ **Fix failed:** ${healResult.error.substring(0, 300)}\n\n`);
                    // Loop will retry with new diagnosis
                } else {
                    stream.markdown(`✅ **Fix executed successfully, re-validating...**\n\n`);
                    // Loop will re-validate
                }
            } else {
                stream.markdown(`⚠️ **LLM could not provide automatic fix**\n\n`);
                if (diagnosis.configChanges) {
                    stream.markdown(`**Suggested config changes:**\n\n\`\`\`json\n${JSON.stringify(diagnosis.configChanges, null, 2)}\n\`\`\`\n\n`);
                }
                stream.markdown(`Manual intervention may be required.\n\n`);
                return false;
            }
        } catch (llmError) {
            logger.error('LLM diagnosis failed', llmError);
            stream.markdown(`❌ **AI diagnosis failed:** ${llmError}\n\n`);
            
            if (attempt >= MAX_HEALING_ATTEMPTS - 2) {
                stream.markdown(`⚠️ **Maximum healing attempts approaching. Stopping.**\n\n`);
                return false;
            }
        }
    }
    
    // Exhausted all attempts
    stream.markdown(`\n❌ **Maximum healing attempts (${MAX_HEALING_ATTEMPTS}) reached**\n\n`);
    stream.markdown(`The Jest environment could not be automatically configured.\n\n`);
    stream.markdown(`**Please review errors above and consider:**\n`);
    stream.markdown(`1. Manually installing missing packages\n`);
    stream.markdown(`2. Checking jest.config.js configuration\n`);
    stream.markdown(`3. Verifying Node.js/npm versions compatibility\n\n`);
    
    return false;
}

/**
 * Helper: Check and setup Jest environment if needed
 * Returns true if environment is ready, false if user cancelled
 */
async function ensureJestEnvironment(
    workspaceRoot: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
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
        stream.markdown(`\n⚠️ **Entorno Jest no está listo**\n\n`);
        stream.markdown(`- Jest instalado: ${setupStatus.hasJest ? '✅' : '❌'}\n`);
        stream.markdown(`- Dependencias faltantes: **${setupStatus.missingDependencies.length}**\n\n`);

        if (setupStatus.missingDependencies.length > 0) {
            stream.markdown(`### 📦 Dependencias Faltantes\n\n`);
            setupStatus.missingDependencies.forEach(dep => {
                stream.markdown(`  - \`${dep}\`\n`);
            });
            stream.markdown(`\n`);
        }

        stream.markdown(`### 🔧 Instalando automáticamente...\n\n`);
        
        // Auto-install instead of just showing error
        const installResult = await handleInstallRequest(stream, token, setupStatus.installCommand);
        
        if (installResult.errorDetails) {
            stream.markdown(`\n⚠️ **La instalación automática falló**\n\n`);
            stream.markdown(`No puedo continuar sin las dependencias Jest instaladas.\n`);
            return false;
        }
        
        stream.markdown(`\n✅ **Dependencias instaladas correctamente**\n\n`);
        
        // 🔍 VALIDATE: Run smoke test and auto-heal if necessary
        stream.markdown(`\n### 🔬 Validación del Entorno Jest\n\n`);
        const validated = await validateJestEnvironmentAndHeal(workspaceRoot, stream, token, true);
        
        if (!validated) {
            stream.markdown(`\n❌ **El entorno Jest no pudo ser validado**\n\n`);
            stream.markdown(`Por favor revisa los errores anteriores y considera realizar ajustes manuales.\n\n`);
            return false;
        }
        
        return true;
    } else {
        stream.markdown(`✅ Entorno Jest listo\n\n`);
        
        // Even if dependencies are installed, validate the environment
        stream.markdown(`\n### 🔬 Validación Final\n\n`);
        const validated = await validateJestEnvironmentAndHeal(workspaceRoot, stream, token, true);
        
        return validated;
    }
}

/**
 * Handle generation for a single file.
 * Uses LLMOrchestrator when available, falls back to legacy TestAgent.
 */
export async function handleGenerateSingleRequest(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    stateService: StateService,
    orchestrator?: LLMOrchestrator
): Promise<vscode.ChatResult> {
    // Get the currently open file
    const activeEditor = vscode.window.activeTextEditor;
    
    if (!activeEditor) {
        stream.markdown('⚠️ Por favor, abre un archivo fuente para generar tests.\n\n');
        stream.markdown('**Uso:** Abre un componente (ej: `MiComponente.tsx`, `service.ts`, `utils.js`) e invoca `@test-agent generate`\n\n');
        stream.markdown('**O usa:** `@test-agent /generate-all` para generar tests de todos los archivos del workspace\n');
        logger.warn('No active editor found');
        return { metadata: { command: '' } };
    }

    const sourceFilePath = activeEditor.document.uri.fsPath;
    const fileName = path.basename(sourceFilePath);

    logger.debug('Processing file', { fileName, filePath: sourceFilePath });

    // Verify it's a supported source file
    const supportedExtensions = ['.ts', '.tsx', '.js', '.jsx'];
    if (!supportedExtensions.some(ext => fileName.endsWith(ext))) {
        stream.markdown('⚠️ Esta extensión genera tests para archivos TypeScript (.ts/.tsx) y JavaScript (.js/.jsx).\n\n');
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
    const envReady = await ensureJestEnvironment(workspaceRoot, stream, token);
    if (!envReady) {
        return { metadata: { command: 'generate' } };
    }

    // Show what we're doing
    stream.markdown(`## 🚀 Generando Tests para \`${fileName}\`\n\n`);
    stream.markdown(`Usando workflow agentico con capacidades de auto-reparación...\n\n`);

    try {
        let testFilePath: string;

        if (orchestrator) {
            // New tool-based orchestrator path
            logger.info('Using LLMOrchestrator for test generation');
            testFilePath = await orchestrator.executeGenerateAndHeal(
                sourceFilePath,
                workspaceRoot,
                stream,
                'balanced'
            );
        } else {
            // Legacy TestAgent fallback
            logger.info('Using legacy TestAgent for test generation');
            const agent = new TestAgent(undefined, stateService);
            testFilePath = await agent.generateAndHealTest(
                sourceFilePath,
                workspaceRoot,
                stream
            );
        }

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
    targetPath?: string,
    orchestrator?: LLMOrchestrator
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
    
    const envReady = await ensureJestEnvironment(firstProjectRoot, stream, token);
    if (!envReady) {
        return { metadata: { command: 'generate-all' } };
    }

    // 🧠 LLM-FIRST: Plan batch generation strategy
    let batchPlan: BatchGenerationPlan | undefined = undefined;
    try {
        stream.progress('Planning batch generation strategy with LLM...');
        const llmProvider = LLMProviderFactory.createProvider();
        
        // Build project structure summary
        const projectStructure = {
            totalFiles: filesWithoutTests.length,
            projectRoot: firstProjectRoot,
            fileTypes: {} as Record<string, number>
        };
        
        // Count file types
        for (const file of filesWithoutTests) {
            const ext = path.extname(file.fsPath);
            projectStructure.fileTypes[ext] = (projectStructure.fileTypes[ext] || 0) + 1;
        }
        
        // Build dependency map (simplified)
        const dependencies: Record<string, string[]> = {};
        for (const file of filesWithoutTests.slice(0, 20)) { // Sample first 20
            const fileName = path.basename(file.fsPath);
            dependencies[fileName] = []; // Simplified: would need actual dependency analysis
        }
        
        batchPlan = await llmProvider.planBatchGeneration({
            allFiles: filesWithoutTests.map(f => path.relative(firstProjectRoot, f.fsPath)),
            projectStructure,
            existingTests: [], // Already filtered out
            dependencies
        });
        
        // Show plan to user
        stream.markdown(`\n🧠 **Batch Generation Plan (by LLM):**\n\n`);
        for (const group of batchPlan.groups.slice(0, 3)) { // Show top 3 groups
            stream.markdown(`**${group.name}** (Priority ${group.priority}): ${group.files.length} files\n`);
            stream.markdown(`  _${group.reason}_\n\n`);
        }
        stream.markdown(`**Estimated time:** ${batchPlan.estimatedTime}\n`);
        stream.markdown(`**Recommended concurrency:** ${batchPlan.recommendedConcurrency}\n\n`);
        
        logger.info('Batch generation plan created', {
            groups: batchPlan.groups.length,
            estimatedTime: batchPlan.estimatedTime
        });
    } catch (error) {
        logger.warn('Failed to plan batch generation, using default order', error);
        stream.markdown(`⚠️ Could not plan batch strategy (LLM error), processing files in default order\n\n`);
    }

    // Ask for confirmation to proceed
    stream.markdown(`⚠️ Esto generará tests para ${filesWithoutTests.length} archivos. Puede tomar varios minutos.\n\n`);

    let successCount = 0;
    let failCount = 0;
    let currentFile = 0;

    // Reorder files based on LLM plan
    let orderedFiles = filesWithoutTests;
    if (batchPlan) {
        const fileMap = new Map(filesWithoutTests.map(f => [path.relative(firstProjectRoot, f.fsPath), f]));
        const newOrder: vscode.Uri[] = [];
        
        // Add files in group priority order
        for (const group of batchPlan.groups.sort((a: any, b: any) => a.priority - b.priority)) {
            for (const relPath of group.files) {
                const file = fileMap.get(relPath);
                if (file) {
                    newOrder.push(file);
                    fileMap.delete(relPath);
                }
            }
        }
        
        // Add any remaining files not in plan
        for (const file of fileMap.values()) {
            newOrder.push(file);
        }
        
        orderedFiles = newOrder;
        logger.info(`Files reordered according to LLM plan: ${orderedFiles.length} files`);
    }

    // Process each project with ordered files
    for (const [projectRoot, files] of projectMap.entries()) {
        stream.markdown(`### Proyecto: \`${path.basename(projectRoot)}\`\n\n`);
        
        const agent = orchestrator ? undefined : new TestAgent(undefined, stateService);

        // Use orderedFiles for this project
        const projectFiles = orderedFiles.filter(f => {
            const folder = vscode.workspace.getWorkspaceFolder(f);
            return folder?.uri.fsPath === projectRoot;
        });

        for (const file of projectFiles) {
            if (token.isCancellationRequested) {
                stream.markdown('\n⚠️ Generación cancelada por el usuario\n');
                break;
            }

            currentFile++;
            const fileName = path.basename(file.fsPath);
            
            stream.progress(`[${currentFile}/${filesWithoutTests.length}] ${fileName}...`);
            stream.markdown(`\n#### [${currentFile}/${filesWithoutTests.length}] \`${fileName}\`\n`);

            try {
                if (orchestrator) {
                    await orchestrator.executeGenerateAndHeal(
                        file.fsPath,
                        projectRoot,
                        stream,
                        'balanced'
                    );
                } else {
                    await agent!.generateAndHealTest(
                        file.fsPath,
                        projectRoot,
                        stream
                    );
                }
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

    // ─── Coverage-driven iteration ───────────────────────────────────
    const coverageService = new CoverageService();
    const coverageThreshold = 80;
    const maxCoverageIterations = 2; // extra passes after initial batch

    stream.markdown(`\n---\n\n## 📊 Coverage Analysis\n\n`);
    stream.progress('Running coverage analysis...');

    let coverageReport: CoverageReport | undefined;
    try {
        coverageReport = await coverageService.runCoverage(firstProjectRoot, coverageThreshold);
        stream.markdown(coverageService.formatReportAsMarkdown(coverageReport));
    } catch (error) {
        logger.error('Coverage analysis failed', error);
        stream.markdown('⚠️ Coverage analysis failed — skipping coverage-driven iteration.\n\n');
    }

    // Coverage-driven heal loop: generate tests for files still below threshold
    if (coverageReport && !coverageReport.meetsThreshold) {
        for (let iteration = 1; iteration <= maxCoverageIterations; iteration++) {
            if (token.isCancellationRequested) {
                stream.markdown('\n⚠️ Coverage iteration cancelled by user\n');
                break;
            }

            const filesNeedingCoverage = coverageService.getFilesNeedingCoverage(coverageReport!);
            if (filesNeedingCoverage.length === 0) { break; }

            stream.markdown(`\n### 🔄 Coverage Iteration ${iteration}/${maxCoverageIterations}\n\n`);
            stream.markdown(`Targeting **${filesNeedingCoverage.length}** files below ${coverageThreshold}%\n\n`);

            const iterAgent = orchestrator ? undefined : new TestAgent(undefined, stateService);
            let iterSuccess = 0;
            let iterFail = 0;

            // Process up to 10 highest-ROI files per iteration
            const filesToProcess = filesNeedingCoverage.slice(0, 10);
            for (const filePath of filesToProcess) {
                if (token.isCancellationRequested) { break; }

                const fileName = path.basename(filePath);
                stream.progress(`[coverage iter ${iteration}] ${fileName}...`);

                try {
                    // Determine project root for this file
                    const fileUri = vscode.Uri.file(filePath);
                    const fileFolder = vscode.workspace.getWorkspaceFolder(fileUri);
                    const projectRoot = fileFolder?.uri.fsPath || firstProjectRoot;

                    if (orchestrator) {
                        await orchestrator.executeGenerateAndHeal(filePath, projectRoot, stream, 'balanced');
                    } else {
                        await iterAgent!.generateAndHealTest(filePath, projectRoot, stream, 'balanced');
                    }
                    iterSuccess++;
                    successCount++;
                } catch (error) {
                    iterFail++;
                    failCount++;
                    const errorMsg = error instanceof Error ? error.message : 'Error';
                    stream.markdown(`❌ \`${fileName}\`: ${errorMsg}\n`);
                    logger.error(`Coverage iteration: failed for ${fileName}`, error);
                }

                // Rate-limit pause between files
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            stream.markdown(`\n✅ Iteration ${iteration}: ${iterSuccess} generated, ${iterFail} failed\n\n`);

            // Re-run coverage after this iteration
            stream.progress('Re-running coverage analysis...');
            const previousReport = coverageReport;
            try {
                coverageReport = await coverageService.runCoverage(firstProjectRoot, coverageThreshold);
                stream.markdown(coverageService.compareCoverage(previousReport!, coverageReport));

                if (coverageReport.meetsThreshold) {
                    stream.markdown(`\n🎉 **Coverage target ≥${coverageThreshold}% reached!**\n\n`);
                    break;
                }
            } catch (error) {
                logger.error('Coverage re-analysis failed', error);
                stream.markdown('⚠️ Coverage re-analysis failed — stopping iteration.\n');
                break;
            }
        }

        // Final coverage dashboard
        if (coverageReport) {
            stream.markdown(`\n---\n\n`);
            stream.markdown(coverageService.formatReportAsMarkdown(coverageReport));
        }
    }

    // Summary
    stream.markdown(`\n---\n\n## 📊 Resumen Final\n\n`);
    stream.markdown(`- ✅ Generados exitosamente: **${successCount}** tests\n`);
    stream.markdown(`- ❌ Fallidos: **${failCount}** tests\n`);
    stream.markdown(`- 📝 Total procesados: **${currentFile}** archivos (initial batch)\n`);
    if (coverageReport) {
        stream.markdown(`- 📈 Coverage final: **${coverageReport.global.statements.toFixed(1)}%** statements\n`);
    }
    stream.markdown(`\n`);

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

// ─────────────────────────────────────────────────────────────────────
// /generate-quality — Golden policy quality pipeline (any project)
// ─────────────────────────────────────────────────────────────────────

/**
 * Handle /generate-quality command — runs the quality pipeline.
 *
 * Works on any JS/TS project. Detects stack, config, and mocks dynamically.
 *
 * This orchestrates:
 * 1. Repo inspection (detect stack, config, mocks, helpers)
 * 2. Test plan (P0/P1/P2 priority ordering)
 * 3. Prompt assembly (policy + stack + tiers + templates)
 * 4. Per-file generation → repair loop → quality gates
 * 5. Coverage report (execution-capable mode only)
 */
export async function handleGenerateQualityRequest(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    targetPath?: string,
    config?: Partial<import('./orchestrator/QualityPipeline').PipelineConfig>
): Promise<vscode.ChatResult> {
    telemetryService.trackCommandExecution('generate-quality');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new WorkspaceNotFoundError();
    }

    // Resolve repo root: explicit path > first workspace
    const repoRoot = targetPath || workspaceFolders[0].uri.fsPath;

    stream.markdown('## 🧪 Quality Test Pipeline\n\n');
    stream.markdown(`**Repo root:** \`${repoRoot}\`\n\n`);

    // Lazy-import to avoid circular deps at module level
    const { QualityPipeline } = await import('./orchestrator/QualityPipeline');
    const llmProvider = LLMProviderFactory.createProvider();
    const pipeline = new QualityPipeline(llmProvider);

    try {
        const result = await pipeline.execute(repoRoot, stream, token, config);

        // ── Final summary ────────────────────────────────
        stream.markdown('\n---\n\n## 📋 Resumen Final\n\n');
        stream.markdown(`| Métrica | Valor |\n|---------|-------|\n`);
        stream.markdown(`| Modo | ${result.mode} |\n`);
        stream.markdown(`| Tests creados | ${result.testsCreated.length} |\n`);
        stream.markdown(`| Tests reparados | ${result.testsRepaired.length} |\n`);
        stream.markdown(`| Tests eliminados | ${result.testsDeleted.length} |\n`);
        stream.markdown(`| Pasando | ${result.testsPassing} |\n`);
        stream.markdown(`| Fallando | ${result.testsFailing} |\n`);
        if (result.coverageAfter !== null) {
            stream.markdown(`| Cobertura | ${result.coverageAfter.toFixed(1)}% |\n`);
        }
        stream.markdown(`| Tiempo total | ${(result.elapsed / 1000).toFixed(1)}s |\n`);
        if (result.aborted) {
            stream.markdown(`| ⚠️ Abortado | ${result.abortReason} |\n`);
        }
        stream.markdown('\n');

        return { metadata: { command: 'generate-quality', result } };
    } catch (error) {
        logger.error('Quality pipeline failed', error);
        const msg = error instanceof Error ? error.message : String(error);
        stream.markdown(`\n❌ **Pipeline failed:** ${msg}\n`);
        return { errorDetails: { message: msg } };
    }
}

/**
 * Deep Mode - Single File/Targeted Quality Pipeline
 */
export async function handleGenerateDeepRequest(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    targetPath?: string
): Promise<vscode.ChatResult> {
    stream.markdown('## 🧠 Deep Generation Mode\n');
    stream.markdown('Activando arquitectura adversaria: Actor + Crítico + Documentador de aprendizaje.\n\n');
    
    return handleGenerateQualityRequest(stream, token, targetPath, {
        deepMode: true,
        autoLearning: true,
        maxFilesPerRun: 3 // Small batch / targeted
    });
}

/**
 * Deep Mode - Batch Quality Pipeline
 */
export async function handleGenerateAllDeepRequest(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    targetPath?: string
): Promise<vscode.ChatResult> {
    stream.markdown('## 🧠 Batch Deep Generation Mode\n');
    stream.markdown('Ejecutando pipeline de calidad en profundidad para todo el proyecto.\n\n');
    
    return handleGenerateQualityRequest(stream, token, targetPath, {
        deepMode: true,
        autoLearning: true,
        maxFilesPerRun: 20 // Large batch
    });
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
        stream.markdown('- Intenta aumentar `test-agent.maxHealingAttempts` en la configuración\n');
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
    stream.markdown('💡 **Consejo:** Revisa el canal de salida "Test Agent" para más detalles.\n');
    stream.markdown('💡 Usa `View > Output` y selecciona "Test Agent" del desplegable.\n');
    
    // Suggest opening the output channel
    stream.button({
        command: 'workbench.action.output.show',
        title: 'Show Output Channel'
    });

    return { errorDetails: { message: errorMessage } };
}