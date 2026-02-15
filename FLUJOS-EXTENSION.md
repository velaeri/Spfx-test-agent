# Flujos de Ejecución de SPFX Test Agent

> **⚠️ NOTA IMPORTANTE SOBRE LLM**: Todas las llamadas a LLM en este documento son **REALES**, no simuladas. 
> La extensión utiliza la API `vscode.lm` para comunicarse con modelos reales (GPT-4, GPT-4o, etc.) a través de GitHub Copilot.
> - Cada llamada a `llmProvider.generateTest()`, `llmProvider.fixTest()`, `llmProvider.planBatchGeneration()`, etc., 
>   resulta en una llamada HTTP real al modelo LLM seleccionado
> - Las respuestas son procesadas en tiempo real (streaming) desde el modelo
> - Los costos y rate limits del LLM aplican según la suscripción de Copilot del usuario

## Índice
1. [Arquitectura General](#arquitectura-general)
2. [Activación de la Extensión](#activación-de-la-extensión)
3. [Comandos Registrados](#comandos-registrados)
4. [Flujo del Chat Handler Principal](#flujo-del-chat-handler-principal)
5. [Comando /setup](#comando-setup)
6. [Comando /install](#comando-install)
7. [Comando /generate](#comando-generate)
8. [Comando /generate-all](#comando-generate-all)
9. [Agente de Pruebas (TestAgent)](#agente-de-pruebas-testagent)
10. [Servicios Auxiliares](#servicios-auxiliares)
11. [Llamadas Reales al LLM](#llamadas-reales-al-llm)

---

## Arquitectura General

```
extensión VSCode
    ↓
extension.ts (punto de entrada)
    ↓
┌─────────────────────────────────────┐
│ activate()                          │
│   • inicializa servicios globales   │
│   • registra chat participant       │
│   • registra comandos VSCode        │
│   • configura observadores          │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ ChatHandlers.ts                     │
│   • handleChatRequest()             │
│   • handleSetupRequest()            │
│   • handleInstallRequest()          │
│   • handleGenerateSingleRequest()   │
│   • handleGenerateAllRequest()      │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ TestAgent.ts                        │
│   • generateAndHealTest()           │
│   • bucle auto-reparación           │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ Servicios & Utilidades              │
│   • LLMProvider (IA)                │
│   • TestRunner (Jest)               │
│   • ConfigService                   │
│   • ProjectSetupService             │
└─────────────────────────────────────┘
```

---

## Activación de la Extensión

**Archivo:** `extension.ts`
**Función:** `activate(context: vscode.ExtensionContext)`

### Flujo de Activación

```metalenguaje
CUANDO extensión_se_activa:
    1. INSTANCIAR singleton Logger
    2. CREAR StateService(context)
    3. OBTENER configuración desde ConfigService
    4. CONFIGURAR nivel de log desde config
    
    5. REGISTRAR participant de chat:
       - ID: 'spfx-tester'
       - Handler: handleChatRequest
       - Icono: icon.png
       - AGREGAR a context.subscriptions
    
    6. REGISTRAR comandos VSCode:
       6.1. 'spfx-test-agent.setup'
            → handleSetupCommand()
       6.2. 'spfx-test-agent.checkSetup'
            → handleCheckSetupCommand()
       6.3. 'spfx-test-agent.installWithCommand'
            → abre chat con /install <comando>
       
       PARA CADA comando:
           AGREGAR a context.subscriptions
    
    7. OBSERVAR cambios en configuración:
       ConfigService.onDidChangeConfiguration((nuevaConfig) => {
           Logger.setLogLevel(nuevaConfig.logLevel)
           Logger.info('Configuración actualizada', nuevaConfig)
       })
    
    8. LOG: 'Extension activation complete'
FIN CUANDO
```

### Comandos Directos VSCode (no chat)

#### `spfx-test-agent.setup`
```metalenguaje
FUNCIÓN handleSetupCommand():
    workspace ← obtener primer workspace folder
    SI NO workspace:
        LANZAR WorkspaceNotFoundError
    
    workspaceRoot ← workspace.uri.fsPath
    setupService ← NUEVO ProjectSetupService()
    
    INTENTAR:
        setupService.setupProject(workspaceRoot, { autoInstall: true })
    CAPTURAR error:
        Logger.error('Setup command failed', error)
        vscode.window.showErrorMessage(`Setup failed: ${error.message}`)
FIN FUNCIÓN
```

#### `spfx-test-agent.checkSetup`
```metalenguaje
FUNCIÓN handleCheckSetupCommand():
    workspace ← obtener primer workspace folder
    SI NO workspace:
        LANZAR WorkspaceNotFoundError
    
    workspaceRoot ← workspace.uri.fsPath
    setupService ← NUEVO ProjectSetupService()
    
    INTENTAR:
        setupService.showSetupStatus(workspaceRoot)
    CAPTURAR error:
        Logger.error('Check setup command failed', error)
        vscode.window.showErrorMessage(`Check failed: ${error.message}`)
FIN FUNCIÓN
```

#### `spfx-test-agent.installWithCommand`
```metalenguaje
FUNCIÓN installWithCommand(command: string):
    vscode.commands.executeCommand('vscode.chat.open', {
        query: `@spfx-tester /install ${command}`
    })
FIN FUNCIÓN
```

---

## Flujo del Chat Handler Principal

**Archivo:** `extension.ts`
**Función:** `handleChatRequest(request, context, stream, token)`

### Metalenguaje del Router Principal

```metalenguaje
FUNCIÓN handleChatRequest(request, context, stream, token):
    Logger.info('Chat request received', {
        prompt: request.prompt,
        command: request.command,
        referencesCount: request.references?.length
    })
    
    // 1. LOG de referencias para debugging
    SI request.references EXISTE Y length > 0:
        PARA CADA referencia EN request.references:
            Logger.info(`Reference ${índice}:`, {
                type: typeof referencia.value,
                isUri: referencia.value instancia de vscode.Uri,
                value: (si Uri → fsPath SINO toString)
            })
    
    // 2. Verificar cancelación
    SI token.isCancellationRequested:
        Logger.warn('Request cancelled by user')
        RETORNAR { errorDetails: { message: 'Request cancelled' } }
    
    INTENTAR:
        // 3. Identificar path objetivo (prioridad: referencias > prompt)
        targetPath ← extractPathFromReferences(request.references)
        SI NO targetPath:
            targetPath ← extractPathFromPrompt(request.prompt)
        
        Logger.info('Identified target path', { targetPath })
        
        // 4. RUTEO según comando
        SI request.command === 'setup':
            RETORNAR handleSetupRequest(stream, token)
        
        SI request.command === 'install':
            commandFromPrompt ← request.prompt.trim()
            RETORNAR handleInstallRequest(stream, token, commandFromPrompt || undefined)
        
        SI request.command === 'generate-all':
            RETORNAR handleGenerateAllRequest(stream, token, stateService, targetPath)
        
        // 5. Por defecto: generación single-file
        RETORNAR handleGenerateSingleRequest(stream, token, stateService)
        
    CAPTURAR error:
        RETORNAR handleError(error, stream)
FIN FUNCIÓN
```

### Funciones Auxiliares de Extracción

#### `extractPathFromReferences`
```metalenguaje
FUNCIÓN extractPathFromReferences(references):
    SI NOT references O length === 0:
        RETORNAR undefined
    
    PARA CADA ref EN references:
        SI ref.value ES instancia de vscode.Uri:
            RETORNAR ref.value.fsPath
    
    RETORNAR undefined
FIN FUNCIÓN
```

#### `extractPathFromPrompt`
```metalenguaje
FUNCIÓN extractPathFromPrompt(prompt):
    SI NOT prompt:
        RETORNAR undefined
    
    // 1. Intentar rutas entre comillas (maneja espacios)
    quotedPath ← prompt.match(/"([^"]+)"|'([^']+)'/)
    SI quotedPath:
        RETORNAR quotedPath[1] || quotedPath[2]
    
    // 2. Rutas Windows (C:\path\to\folder)
    windowsPath ← prompt.match(/[A-Za-z]:[\\\/](?:[^"<>|*?]+)/)
    SI windowsPath:
        p ← windowsPath[0].trim()
        SI fs.existsSync(p):
            RETORNAR p
        ELSE:
            // Fallback a regex más estricta
            strictWindowsPath ← prompt.match(/[A-Za-z]:[\\\/](?:[^\s"'<>|*?]+[\\\/]?)+/)
            SI strictWindowsPath:
                RETORNAR strictWindowsPath[0]
    
    // 3. Rutas Unix (/path/to/folder)
    unixPath ← prompt.match(/\/(?:[^\s"'<>|*?]+\/?)*)/)
    SI unixPath Y unixPath[0].length > 1:
        RETORNAR unixPath[0]
    
    // 4. Rutas relativas (contienen / o \)
    relativePath ← prompt.match(/(?:[.\w-]+[\\\/])+[.\w-]*/)
    SI relativePath:
        RETORNAR relativePath[0]
    
    RETORNAR undefined
FIN FUNCIÓN
```

---

## Comando /setup

**Archivo:** `ChatHandlers.ts`
**Función:** `handleSetupRequest(stream, token)`

### Flujo Completo

```metalenguaje
FUNCIÓN handleSetupRequest(stream, token):
    setupStartTime ← Date.now()
    telemetryService.trackCommandExecution('setup')
    
    // ═══════════════════════════════════════════════════════
    // FASE 1: Validación de Workspace
    // ═══════════════════════════════════════════════════════
    workspaceFolders ← vscode.workspace.workspaceFolders
    SI NO workspaceFolders O length === 0:
        LANZAR WorkspaceNotFoundError()
    
    stream.markdown('## 🔧 Configurando Entorno Jest\n\n')
    stream.progress('Buscando proyectos Node.js...')
    
    // ═══════════════════════════════════════════════════════
    // FASE 2: Descubrimiento de Proyectos
    // ═══════════════════════════════════════════════════════
    setupService ← NUEVO ProjectSetupService()
    projects ← []
    
    PARA CADA folder EN workspaceFolders:
        packageJsonPath ← path.join(folder.uri.fsPath, 'package.json')
        
        SI fs.existsSync(packageJsonPath):
            status ← AWAIT setupService.checkProjectSetup(folder.uri.fsPath)
            packageJson ← JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
            
            projects.push({
                path: folder.uri.fsPath,
                name: packageJson.name || path.basename(folder.uri.fsPath),
                hasJest: status.hasJest
            })
    
    SI projects.length === 0:
        stream.markdown('❌ **No se encontró ningún proyecto Node.js**\n\n')
        stream.markdown('💡 **Sugerencia:** `File > Open Folder`\n')
        RETORNAR { errorDetails: { message: 'No package.json found' } }
    
    // ═══════════════════════════════════════════════════════
    // FASE 3: Selección de Proyecto
    // ═══════════════════════════════════════════════════════
    SI projects.length > 1:
        stream.markdown(`📁 **Encontrados ${projects.length} proyectos:**\n\n`)
        PARA CADA proyecto CON índice:
            stream.markdown(`${índice+1}. \`${proyecto.name}\` ${proyecto.hasJest ? '✅ Jest' : '❌ Sin Jest'}\n`)
        
        workspaceRoot ← projects[0].path
        stream.markdown(`🎯 Configurando: **${projects[0].name}**\n\n`)
    ELSE:
        workspaceRoot ← projects[0].path
        stream.markdown(`📁 Proyecto: **${projects[0].name}**\n\n`)
    
    // ═══════════════════════════════════════════════════════
    // FASE 4: Verificación de Estado Actual
    // ═══════════════════════════════════════════════════════
    stream.progress('Verificando estado actual...')
    setupStatus ← AWAIT setupService.checkProjectSetup(workspaceRoot)
    
    stream.markdown('### 📊 Estado Actual\n\n')
    stream.markdown(`- Package.json: ${setupStatus.hasPackageJson ? '✅' : '❌'}\n`)
    stream.markdown(`- Jest instalado: ${setupStatus.hasJest ? '✅' : '❌'}\n`)
    stream.markdown(`- Jest config: ${setupStatus.hasJestConfig ? '✅' : '⚠️ (se creará)'}\n`)
    stream.markdown(`- Jest setup: ${setupStatus.hasJestSetup ? '✅' : '⚠️ (se creará)'}\n`)
    stream.markdown(`- Dependencias faltantes: **${setupStatus.missingDependencies.length}**\n\n`)
    
    SI setupStatus.missingDependencies.length > 0:
        stream.markdown('### 📦 Dependencias a Instalar\n\n')
        PARA CADA dep EN setupStatus.missingDependencies:
            stream.markdown(`  - \`${dep}\`\n`)
    
    // ═══════════════════════════════════════════════════════
    // FASE 5: Verificación de Completitud
    // ═══════════════════════════════════════════════════════
    SI setupStatus.hasJest Y 
       setupStatus.missingDependencies.length === 0 Y
       setupStatus.hasJestConfig Y
       setupStatus.hasJestSetup:
        
        stream.markdown('✅ **¡El entorno Jest ya está completamente configurado!**\n\n')
        RETORNAR { metadata: { command: 'setup' } }
    
    // ═══════════════════════════════════════════════════════
    // FASE 6: Creación de Archivos de Configuración
    // ═══════════════════════════════════════════════════════
    stream.markdown('\n🔧 **Creando archivos de configuración...**\n\n')
    stream.progress('Creando archivos Jest...')
    
    setupResult ← AWAIT setupService.setupProject(workspaceRoot)
    
    SI NO setupResult.success:
        stream.markdown('\n❌ **Error al crear archivos de configuración**\n\n')
        RETORNAR { errorDetails: { message: 'Setup failed' } }
    
    stream.markdown('\n✅ **Archivos de configuración creados correctamente**\n\n')
    
    // ═══════════════════════════════════════════════════════
    // FASE 7: Instrucciones de Instalación
    // ═══════════════════════════════════════════════════════
    SI setupResult.installCommand:
        stream.markdown('### 📦 Instalación de Dependencias\n\n')
        stream.markdown(`⚠️ **Faltan ${setupStatus.missingDependencies.length} dependencias Jest**\n\n`)
        stream.markdown('Por favor, ejecuta el siguiente comando en el terminal:\n\n')
        stream.markdown(`\`\`\`bash\n${setupResult.installCommand}\n\`\`\`\n\n`)
        
        stream.button({
            command: 'vscode.chat.open',
            arguments: [{ query: '@spfx-tester /install' }],
            title: '▶️ Instalar con asistencia IA'
        })
        
        stream.markdown('💡 **Nota:** Este comando usa `--legacy-peer-deps`\n\n')
    ELSE:
        stream.markdown('### 🎉 Configuración Completada\n\n')
        stream.markdown('✅ Todas las dependencias ya están instaladas\n')
    
    stream.markdown('### 📁 Archivos Creados\n\n')
    stream.markdown('- `jest.config.js` - Configuración de Jest\n')
    stream.markdown('- `jest.setup.js` - Inicialización de testing-library\n')
    stream.markdown('- `__mocks__/fileMock.js` - Mock para archivos estáticos\n\n')
    
    setupDuration ← Date.now() - setupStartTime
    telemetryService.trackSetup(setupResult.success, setupDuration)
    
    Logger.info('Setup completed successfully via chat command')
    
    RETORNAR { metadata: { command: 'setup' } }
FIN FUNCIÓN
```

---

## Comando /install

**Archivo:** `ChatHandlers.ts`
**Función:** `handleInstallRequest(stream, token, installCommand?, maxRetries = 3)`

### Flujo Completo con Auto-Healing

```metalenguaje
FUNCIÓN handleInstallRequest(stream, token, installCommand?, maxRetries = 3):
    startTime ← Date.now()
    telemetryService.trackCommandExecution('install')
    
    // ═══════════════════════════════════════════════════════
    // FASE 1: Validación y Preparación
    // ═══════════════════════════════════════════════════════
    workspaceFolders ← vscode.workspace.workspaceFolders
    SI NO workspaceFolders O length === 0:
        LANZAR WorkspaceNotFoundError()
    
    workspaceRoot ← workspaceFolders[0].uri.fsPath
    setupService ← NUEVO ProjectSetupService()
    setupStatus ← AWAIT setupService.checkProjectSetup(workspaceRoot)
    
    currentCommand ← installCommand || setupStatus.installCommand
    
    SI NO currentCommand:
        stream.markdown('✅ **No hay dependencias que instalar**\n\n')
        RETORNAR { metadata: { command: 'install' } }
    
    stream.markdown('## 📦 Instalando Dependencias Jest\n\n')
    stream.markdown(`**Comando inicial:**\n\`\`\`bash\n${currentCommand}\n\`\`\`\n\n`)
    
    llmProvider ← LLMProviderFactory.createProvider()
    lastError ← ''
    attempt ← 0
    
    // ═══════════════════════════════════════════════════════
    // FASE 2: Bucle de Auto-Healing con LLM
    // ═══════════════════════════════════════════════════════
    MIENTRAS attempt < maxRetries:
        attempt++
        
        SI attempt > 1:
            stream.markdown(`\n---\n\n### 🔄 Intento ${attempt}/${maxRetries}\n\n`)
            stream.markdown(`\`\`\`bash\n${currentCommand}\n\`\`\`\n\n`)
        
        // ───────────────────────────────────────────────────
        // SUB-FASE 2.1: Ejecutar npm install
        // ───────────────────────────────────────────────────
        result ← AWAIT executeNpmInstall(currentCommand, workspaceRoot, stream, token)
        
        SI result.success:
            duration ← Date.now() - startTime
            stream.markdown(`\n✅ **Instalación completada exitosamente** (${duration/1000}s)\n\n`)
            
            SI attempt > 1:
                stream.markdown(`💡 Resuelto en el intento ${attempt} mediante auto-healing con IA\n\n`)
            
            stream.markdown('Siguiente paso: Usa `@spfx-tester /generate-all`\n')
            RETORNAR { metadata: { command: 'install', attempts: attempt } }
        
        // ───────────────────────────────────────────────────
        // SUB-FASE 2.2: Instalación Falló - Analizar Error
        // ───────────────────────────────────────────────────
        lastError ← result.error
        
        stream.markdown('\n❌ **Instalación fallida**\n\n')
        
        errorPreview ← result.error.substring(0, 800)
        stream.markdown(`\`\`\`\n${errorPreview}${result.error.length > 800 ? '...(truncado)' : ''}\n\`\`\`\n\n`)
        
        // ───────────────────────────────────────────────────
        // SUB-FASE 2.3: Usar LLM para Auto-Healing
        // ───────────────────────────────────────────────────
        SI attempt < maxRetries:
            stream.markdown('🧠 **Analizando error con IA...**\n\n')
            stream.progress(`Healing attempt ${attempt}/${maxRetries}...`)
            
            INTENTAR:
                pkgContext ← AWAIT getPackageJsonContext(workspaceRoot)
                errorSummary ← extractNpmErrorSummary(result.error)
                
                healingPrompt ← `
                    Task: Fix npm dependency installation error
                    
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
                    COMANDO: npm install --save-dev [adjusted-packages]
                `
                
                systemPrompt ← 'You are an expert npm dependency resolver...'
                
                llmResult ← AWAIT llmProvider.generateTest({
                    sourceCode: healingPrompt,
                    fileName: 'npm-healing-analysis.txt',
                    systemPrompt: systemPrompt
                })
                
                // Verificar si LLM rechazó la solicitud
                SI llmResult.code.toLowerCase().includes("sorry") Y 
                   llmResult.code.toLowerCase().includes("can't assist"):
                    stream.markdown('⚠️ **El LLM rechazó la solicitud** - abortando auto-healing\n\n')
                    ROMPER bucle
                
                // Extraer análisis y comando sugerido
                analysis ← extractSection(llmResult.code, 'ANALISIS')
                suggestedCommand ← extractSection(llmResult.code, 'COMANDO')
                
                // Fallback: extraer comando npm del response completo
                SI NO suggestedCommand:
                    npmMatch ← llmResult.code.match(/npm\s+install[^\n]+/)
                    SI npmMatch:
                        suggestedCommand ← npmMatch[0]
                
                SI analysis:
                    stream.markdown(`**Diagnóstico IA:** ${analysis}\n\n`)
                
                SI suggestedCommand:
                    cleanCommand ← suggestedCommand.replace(/```[\w]*\n?|```/g, '').trim()
                    
                    // Verificar que el comando sea diferente (evitar bucle infinito)
                    SI cleanCommand === currentCommand:
                        stream.markdown('⚠️ **El LLM sugirió el mismo comando** - no hay mejora\n\n')
                        ROMPER bucle
                    
                    // Actualizar comando para próxima iteración
                    currentCommand ← cleanCommand
                    stream.markdown('💡 **Nuevo comando detectado** - reintentando...\n\n')
                    
                    // Pequeño delay para evitar rate limits
                    AWAIT sleep(1000)
                    CONTINUAR bucle
                ELSE:
                    stream.markdown('⚠️ **El LLM no pudo generar un comando alternativo**\n\n')
                    ROMPER bucle
                
            CAPTURAR llmError:
                Logger.error('LLM healing failed', llmError)
                stream.markdown(`⚠️ **Error en auto-healing:** ${llmError.message}\n\n`)
                ROMPER bucle
    
    // ═══════════════════════════════════════════════════════
    // FASE 3: Reintentos Agotados - Sugerencias Manuales
    // ═══════════════════════════════════════════════════════
    stream.markdown('\n---\n\n### ⚠️ Auto-healing agotado\n\n')
    stream.markdown(`No se pudo resolver automáticamente después de ${attempt} intento(s)\n\n`)
    suggestManualFix(stream, lastError, currentCommand)
    
    RETORNAR {
        metadata: { command: 'install', attempts: attempt },
        errorDetails: { message: 'npm install failed after retries' }
    }
FIN FUNCIÓN
```

### Funciones Auxiliares de /install

#### `executeNpmInstall`
```metalenguaje
FUNCIÓN executeNpmInstall(command, cwd, stream, token):
    RETORNAR NUEVA Promise((resolve) => {
        parts ← command.split(' ')
        cmd ← parts[0]
        args ← parts.slice(1)
        
        output ← ''
        errorOutput ← ''
        
        stream.progress(`Ejecutando: ${command}`)
        
        child ← spawn(cmd, args, {
            cwd: cwd,
            shell: true,
            env: { ...process.env, FORCE_COLOR: '0' }
        })
        
        child.stdout.on('data', (data) => {
            text ← data.toString()
            output += text
            
            // Stream de progreso en tiempo real
            lines ← text.split('\n').filter(l => l.trim())
            PARA CADA line EN lines:
                SI line.includes('added') O line.includes('updated') O line.includes('removed'):
                    stream.progress(line.substring(0, 100))
        })
        
        child.stderr.on('data', (data) => {
            errorOutput += data.toString()
        })
        
        child.on('error', (error) => {
            Logger.error('npm install process error', error)
            resolve({ success: false, output, error: `Process error: ${error.message}` })
        })
        
        child.on('close', (code) => {
            Logger.info(`npm install exited with code ${code}`)
            
            SI code === 0:
                resolve({ success: true, output, error: errorOutput })
            ELSE:
                resolve({ success: false, output, error: errorOutput || output })
        })
        
        token.onCancellationRequested(() => {
            child.kill()
            resolve({ success: false, output, error: 'Cancelled by user' })
        })
    })
FIN FUNCIÓN
```

#### `extractNpmErrorSummary`
```metalenguaje
FUNCIÓN extractNpmErrorSummary(errorText):
    lines ← errorText.split('\n')
    relevantLines ← []
    
    PARA CADA line EN lines:
        SI line.includes('npm error') O
           line.includes('ERESOLVE') O
           line.includes('ETARGET') O
           line.includes('peer dep') O
           line.includes('notarget') O
           line.includes('Could not resolve'):
            
            relevantLines.push(line)
        
        SI relevantLines.length >= 15:
            ROMPER
    
    SI relevantLines.length > 0:
        RETORNAR relevantLines.join('\n')
    ELSE:
        RETORNAR errorText.substring(0, 1000)
FIN FUNCIÓN
```

#### `suggestManualFix`
```metalenguaje
FUNCIÓN suggestManualFix(stream, error, originalCommand):
    stream.markdown('💡 **Sugerencias para resolver manualmente:**\n\n')
    
    // Análisis específico por tipo de error
    SI error.includes('ETARGET') O error.includes('notarget'):
        stream.markdown('**Error ETARGET/notarget:** No se encontró la versión\n\n')
        stream.markdown('Causas comunes:\n')
        stream.markdown('- Las versiones exactas no existen en npm\n')
        stream.markdown('- El registro npm está inaccesible\n')
        stream.markdown('- El rango de versión es muy restrictivo\n\n')
        stream.markdown('Soluciones:\n')
        stream.markdown('1. Usa versiones flexibles: `@^28.0.0` en vez de `@28.0.8`\n')
        stream.markdown('2. Verifica versiones: `npm view <package> versions`\n')
        stream.markdown('3. Prueba con latest: `npm install --save-dev <package>@latest`\n\n')
    
    ELSE SI error.includes('ERESOLVE') O error.includes('peer dep'):
        stream.markdown('**Error ERESOLVE/peer dependency:** Conflicto de versiones\n\n')
        stream.markdown('Soluciones:\n')
        stream.markdown('1. Usa `--force` en lugar de `--legacy-peer-deps`\n')
        stream.markdown('2. Revisa versiones: `npm list react typescript`\n')
        stream.markdown('3. Actualiza React: `npm update react react-dom`\n\n')
    
    ELSE:
        stream.markdown('Soluciones generales:\n')
        stream.markdown('- Revisa el error completo arriba\n')
        stream.markdown('- Instala paquetes uno por uno\n')
        stream.markdown('- Verifica compatibilidad en npmjs.com\n')
        stream.markdown('- Limpia cache: `npm cache clean --force`\n\n')
    
    stream.markdown('**Comandos alternativos:**\n\n')
    
    // Opción 1: --force en lugar de --legacy-peer-deps
    SI originalCommand.includes('--legacy-peer-deps') Y NO originalCommand.includes('--force'):
        forceCommand ← originalCommand.replace('--legacy-peer-deps', '--force')
        stream.markdown('**Opción 1:** Usar `--force`:\n')
        stream.markdown(`\`\`\`bash\n${forceCommand}\n\`\`\`\n\n`)
    
    // Opción 2: Sin especificadores de versión
    stream.markdown('**Opción 2:** Dejar que npm elija versiones:\n')
    stream.markdown('```bash\nnpm install --save-dev --legacy-peer-deps jest @types/jest ts-jest @testing-library/react\n```\n\n')
    
    // Opción 3: Instalación paso a paso
    stream.markdown('**Opción 3:** Instalar paquetes uno a uno:\n')
    stream.markdown('```bash\nnpm install --save-dev --legacy-peer-deps jest\nnpm install --save-dev --legacy-peer-deps @types/jest ts-jest\nnpm install --save-dev --legacy-peer-deps @testing-library/react\n```\n\n')
FIN FUNCIÓN
```

---

## Comando /generate

**Archivo:** `ChatHandlers.ts`
**Función:** `handleGenerateSingleRequest(stream, token, stateService)`

### Flujo Completo

```metalenguaje
FUNCIÓN handleGenerateSingleRequest(stream, token, stateService):
    // ═══════════════════════════════════════════════════════
    // FASE 1: Obtener Archivo Activo
    // ═══════════════════════════════════════════════════════
    activeEditor ← vscode.window.activeTextEditor
    
    SI NO activeEditor:
        stream.markdown('⚠️ Por favor, abre un archivo TypeScript/TSX\n\n')
        stream.markdown('**Uso:** Abre un componente SPFx e invoca `@spfx-tester generate`\n\n')
        Logger.warn('No active editor found')
        RETORNAR { metadata: { command: '' } }
    
    sourceFilePath ← activeEditor.document.uri.fsPath
    fileName ← path.basename(sourceFilePath)
    
    Logger.debug('Processing file', { fileName, filePath: sourceFilePath })
    
    // ═══════════════════════════════════════════════════════
    // FASE 2: Validación de Tipo de Archivo
    // ═══════════════════════════════════════════════════════
    SI NO fileName.endsWith('.ts') Y NO fileName.endsWith('.tsx'):
        stream.markdown('⚠️ Esta extensión solo genera tests para archivos TypeScript\n\n')
        Logger.warn('Invalid file type', { fileName })
        RETORNAR { metadata: { command: '' } }
    
    // Verificar que no sea ya un test file
    SI fileName.includes('.test.') O fileName.includes('.spec.'):
        stream.markdown('⚠️ Este ya es un archivo de test\n\n')
        Logger.warn('Attempted to generate test for test file', { fileName })
        RETORNAR { metadata: { command: '' } }
    
    // ═══════════════════════════════════════════════════════
    // FASE 3: Obtener Workspace Root
    // ═══════════════════════════════════════════════════════
    workspaceFolder ← vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
    SI NO workspaceFolder:
        LANZAR WorkspaceNotFoundError()
    
    workspaceRoot ← workspaceFolder.uri.fsPath
    Logger.info('Workspace identified', { workspaceRoot })
    
    // ═══════════════════════════════════════════════════════
    // FASE 4: Verificar y Configurar Entorno Jest
    // ═══════════════════════════════════════════════════════
    envReady ← AWAIT ensureJestEnvironment(workspaceRoot, stream, token)
    SI NO envReady:
        RETORNAR { metadata: { command: 'generate' } }
    
    // ═══════════════════════════════════════════════════════
    // FASE 5: Generar y Curar Test
    // ═══════════════════════════════════════════════════════
    stream.markdown(`## 🚀 Generando Tests para \`${fileName}\`\n\n`)
    stream.markdown('Usando workflow agentico con auto-reparación...\n\n')
    
    agent ← NUEVO TestAgent(undefined, stateService)
    
    INTENTAR:
        testFilePath ← AWAIT agent.generateAndHealTest(
            sourceFilePath,
            workspaceRoot,
            stream
        )
        
        // ───────────────────────────────────────────────────
        // SUB-FASE 5.1: Abrir Test Generado
        // ───────────────────────────────────────────────────
        testFileUri ← vscode.Uri.file(testFilePath)
        doc ← AWAIT vscode.workspace.openTextDocument(testFileUri)
        AWAIT vscode.window.showTextDocument(doc, { preview: false })
        
        stream.markdown(`\n📝 Archivo de test abierto: \`${path.basename(testFilePath)}\`\n`)
        
        Logger.info('Test generation completed successfully', {
            sourceFile: fileName,
            testFile: path.basename(testFilePath)
        })
        
        RETORNAR { metadata: { command: 'generate' } }
        
    CAPTURAR error:
        RETORNAR handleError(error, stream, fileName)
FIN FUNCIÓN
```

### Función Auxiliar: `ensureJestEnvironment`

```metalenguaje
FUNCIÓN ensureJestEnvironment(workspaceRoot, stream, token):
    stream.progress('Verificando entorno Jest...')
    setupService ← NUEVO ProjectSetupService()
    setupStatus ← AWAIT setupService.checkProjectSetup(workspaceRoot)
    
    SI NO setupStatus.hasPackageJson:
        stream.markdown('❌ **No se encontró package.json**\n\n')
        RETORNAR false
    
    // ═══════════════════════════════════════════════════════
    // SUB-FASE 1: Verificar si Setup es Necesario
    // ═══════════════════════════════════════════════════════
    SI NO setupStatus.hasJest O setupStatus.missingDependencies.length > 0:
        stream.markdown('\n⚠️ **Entorno Jest no está listo**\n\n')
        stream.markdown(`- Jest instalado: ${setupStatus.hasJest ? '✅' : '❌'}\n`)
        stream.markdown(`- Dependencias faltantes: **${setupStatus.missingDependencies.length}**\n\n`)
        
        SI setupStatus.missingDependencies.length > 0:
            stream.markdown('### 📦 Dependencias Faltantes\n\n')
            PARA CADA dep EN setupStatus.missingDependencies:
                stream.markdown(`  - \`${dep}\`\n`)
        
        stream.markdown('### 🔧 Instalando automáticamente...\n\n')
        
        // ───────────────────────────────────────────────────
        // SUB-FASE 2: Auto-Instalación
        // ───────────────────────────────────────────────────
        installResult ← AWAIT handleInstallRequest(stream, token, setupStatus.installCommand)
        
        SI installResult.errorDetails:
            stream.markdown('\n⚠️ **La instalación automática falló**\n\n')
            RETORNAR false
        
        stream.markdown('\n✅ **Dependencias instaladas correctamente**\n\n')
        
        // ───────────────────────────────────────────────────
        // SUB-FASE 3: Validación con Smoke Test
        // ───────────────────────────────────────────────────
        stream.markdown('\n### 🔬 Validación del Entorno Jest\n\n')
        validated ← AWAIT validateJestEnvironmentAndHeal(workspaceRoot, stream, token, true)
        
        SI NO validated:
            stream.markdown('\n❌ **El entorno Jest no pudo ser validado**\n\n')
            RETORNAR false
        
        RETORNAR true
    
    ELSE:
        stream.markdown('✅ Entorno Jest listo\n\n')
        
        // Validar incluso si las dependencias están instaladas
        stream.markdown('\n### 🔬 Validación Final\n\n')
        validated ← AWAIT validateJestEnvironmentAndHeal(workspaceRoot, stream, token, true)
        
        RETORNAR validated
FIN FUNCIÓN
```

### Función de Validación: `validateJestEnvironmentAndHeal`

```metalenguaje
FUNCIÓN validateJestEnvironmentAndHeal(workspaceRoot, stream, token, canAutoHeal = true):
    stream.progress('🔍 Validando Jest environment con smoke test...')
    
    attempt ← 0
    lastDiagnosis ← ''
    
    // ═══════════════════════════════════════════════════════
    // BUCLE de Auto-Healing (hasta 10 intentos)
    // ═══════════════════════════════════════════════════════
    MIENTRAS attempt < MAX_HEALING_ATTEMPTS:  // 10
        attempt++
        
        SI attempt > 1:
            stream.markdown(`\n---\n\n### 🔄 Healing Attempt ${attempt}/${MAX_HEALING_ATTEMPTS}\n\n`)
        
        // ───────────────────────────────────────────────────
        // SUB-FASE 1: Pre-check Rápido (sin LLM)
        // ───────────────────────────────────────────────────
        jsdomIssue ← AWAIT detectJsdomIssue(workspaceRoot)
        
        SI jsdomIssue.hasIssue Y canAutoHeal:
            stream.markdown('⚡ **Pre-check detected known issue:**\n\n')
            stream.markdown(`${jsdomIssue.diagnosis}\n\n`)
            stream.markdown('🔧 **Auto-fixing...**\n\n')
            stream.markdown(`\`\`\`bash\n${jsdomIssue.fix}\n\`\`\`\n\n`)
            
            fixResult ← AWAIT executeNpmInstall(jsdomIssue.fix, workspaceRoot, stream, token)
            
            SI NO fixResult.success:
                stream.markdown(`❌ **Auto-fix failed:** ${fixResult.error.substring(0, 300)}\n\n`)
            ELSE:
                stream.markdown('✅ **Fixed successfully**\n\n')
        
        // ───────────────────────────────────────────────────
        // SUB-FASE 2: Smoke Test
        // ───────────────────────────────────────────────────
        stream.progress(`Running smoke test (attempt ${attempt})...`)
        testResult ← AWAIT executeJestSmokeTest(workspaceRoot, token)
        
        SI testResult.success:
            SI attempt === 1:
                stream.markdown('✅ **Jest environment validated successfully**\n\n')
            ELSE:
                stream.markdown(`\n✅ **Jest environment healed** (attempt ${attempt})\n\n`)
            
            RETORNAR true
        
        // ───────────────────────────────────────────────────
        // SUB-FASE 3: Test Falló - Analizar Error
        // ───────────────────────────────────────────────────
        stream.markdown('\n⚠️ **Smoke test failed**\n\n')
        
        errorPreview ← testResult.error.substring(0, 600)
        stream.markdown(`\`\`\`\n${errorPreview}${testResult.error.length > 600 ? '...(truncated)' : ''}\n\`\`\`\n\n`)
        
        SI NO canAutoHeal:
            stream.markdown('❌ **Auto-healing is disabled**\n\n')
            RETORNAR false
        
        // Verificar progreso (diagnóstico cambió)
        SI attempt > 3 Y testResult.error === lastDiagnosis:
            stream.markdown(`⚠️ **Error persists unchanged after ${attempt} attempts**\n\n`)
            RETORNAR false
        
        lastDiagnosis ← testResult.error
        
        // ───────────────────────────────────────────────────
        // SUB-FASE 4: Diagnóstico LLM
        // ───────────────────────────────────────────────────
        stream.markdown('🧠 **Analyzing error with AI...**\n\n')
        stream.progress('Consulting LLM for diagnosis...')
        
        INTENTAR:
            llmProvider ← LLMProviderFactory.createProvider()
            installedPackages ← AWAIT getInstalledJestPackages(workspaceRoot)
            packageJsonPath ← path.join(workspaceRoot, 'package.json')
            packageJson ← JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
            
            diagnosis ← AWAIT llmProvider.analyzeAndFixError(testResult.error, {
                packageJson: packageJson,
                errorType: 'execution',
                jestConfig: 'testEnvironment: jsdom'
            })
            
            stream.markdown(`**AI Diagnosis:**\n\n${diagnosis.diagnosis}\n\n`)
            
            // Construir comando recomendado
            recommendedCommand ← ''
            SI diagnosis.commands Y diagnosis.commands.length > 0:
                recommendedCommand ← diagnosis.commands[0]
            ELSE SI diagnosis.packages Y diagnosis.packages.length > 0:
                recommendedCommand ← `install --save-dev ${diagnosis.packages.join(' ')} --legacy-peer-deps`
            
            SI recommendedCommand:
                stream.markdown(`**Recommended fix:**\n\n\`\`\`bash\nnpm ${recommendedCommand}\n\`\`\`\n\n`)
                stream.markdown('🔧 **Executing fix automatically...**\n\n')
                
                healResult ← AWAIT executeNpmInstall(recommendedCommand, workspaceRoot, stream, token)
                
                SI NO healResult.success:
                    stream.markdown(`❌ **Fix failed:** ${healResult.error.substring(0, 300)}\n\n`)
                ELSE:
                    stream.markdown('✅ **Fix executed successfully, re-validating...**\n\n')
            ELSE:
                stream.markdown('⚠️ **LLM could not provide automatic fix**\n\n')
                
                SI diagnosis.configChanges:
                    stream.markdown(`**Suggested config changes:**\n\n\`\`\`json\n${JSON.stringify(diagnosis.configChanges, null, 2)}\n\`\`\`\n\n`)
                
                RETORNAR false
        
        CAPTURAR llmError:
            Logger.error('LLM diagnosis failed', llmError)
            stream.markdown(`❌ **AI diagnosis failed:** ${llmError}\n\n`)
            
            SI attempt >= MAX_HEALING_ATTEMPTS - 2:
                stream.markdown('⚠️ **Maximum healing attempts approaching. Stopping.**\n\n')
                RETORNAR false
    
    // ═══════════════════════════════════════════════════════
    // Reintentos Agotados
    // ═══════════════════════════════════════════════════════
    stream.markdown(`\n❌ **Maximum healing attempts (${MAX_HEALING_ATTEMPTS}) reached**\n\n`)
    stream.markdown('The Jest environment could not be automatically configured.\n\n')
    stream.markdown('**Please review errors above and consider:**\n')
    stream.markdown('1. Manually installing missing packages\n')
    stream.markdown('2. Checking jest.config.js configuration\n')
    stream.markdown('3. Verifying Node.js/npm versions compatibility\n\n')
    
    RETORNAR false
FIN FUNCIÓN
```

---

## Comando /generate-all

**Archivo:** `ChatHandlers.ts`
**Función:** `handleGenerateAllRequest(stream, token, stateService, targetPath?)`

### Flujo Completo con Planificación LLM y Coverage

```metalenguaje
FUNCIÓN handleGenerateAllRequest(stream, token, stateService, targetPath?):
    batchStartTime ← Date.now()
    telemetryService.trackCommandExecution('generate-all')
    
    // ═══════════════════════════════════════════════════════
    // FASE 1: Validación y Escaneo de Workspace
    // ═══════════════════════════════════════════════════════
    workspaceFolders ← vscode.workspace.workspaceFolders
    
    SI NO workspaceFolders O length === 0:
        LANZAR WorkspaceNotFoundError()
    
    stream.markdown('## 🚀 Generando Tests para Todo el Workspace\n\n')
    stream.progress('Escaneando archivos fuente...')
    
    allFiles ← []
    
    PARA CADA folder EN workspaceFolders:
        files ← AWAIT FileScanner.findSourceFiles(folder)
        allFiles ← allFiles.concat(files)
    
    Logger.info(`Found ${allFiles.length} source files in workspace`)
    
    // Filtrar archivos que ya tienen tests
    filesWithoutTests ← FileScanner.filterFilesWithoutTests(allFiles)
    
    Logger.info(`${filesWithoutTests.length} files need tests`)
    
    SI filesWithoutTests.length === 0:
        stream.markdown('✅ ¡Todos los archivos ya tienen tests!\n\n')
        RETORNAR { metadata: { command: 'generate-all' } }
    
    stream.markdown(`Encontrados **${allFiles.length}** archivos fuente\n`)
    stream.markdown(`**${filesWithoutTests.length}** archivos necesitan tests\n\n`)
    
    // Agrupar archivos por proyecto
    projectMap ← FileScanner.groupFilesByProject(filesWithoutTests)
    
    stream.markdown(`📁 Encontrados **${projectMap.size}** proyecto(s)\n\n`)
    
    // ═══════════════════════════════════════════════════════
    // FASE 2: Verificar Entorno Jest (UNA VEZ)
    // ═══════════════════════════════════════════════════════
    firstProjectRoot ← projectMap.keys().next().value
    
    SI NO firstProjectRoot:
        stream.markdown('⚠️ No se encontró ningún proyecto válido\n')
        RETORNAR { metadata: { command: 'generate-all' } }
    
    envReady ← AWAIT ensureJestEnvironment(firstProjectRoot, stream, token)
    SI NO envReady:
        RETORNAR { metadata: { command: 'generate-all' } }
    
    // ═══════════════════════════════════════════════════════
    // FASE 3: Planificación de Batch con LLM (LLAMADA REAL)
    // ═══════════════════════════════════════════════════════
    // ⚡ ESTA ES UNA LLAMADA REAL AL LLM - NO SIMULADA
    // El LLM analiza todos los archivos y devuelve un plan de priorización inteligente
    batchPlan ← undefined
    
    INTENTAR:
        stream.progress('Planning batch generation strategy with LLM...')
        llmProvider ← LLMProviderFactory.createProvider()
        
        // Construir estructura de proyecto
        projectStructure ← {
            totalFiles: filesWithoutTests.length,
            projectRoot: firstProjectRoot,
            fileTypes: {}
        }
        
        // Contar tipos de archivo
        PARA CADA file EN filesWithoutTests:
            ext ← path.extname(file.fsPath)
            projectStructure.fileTypes[ext] ← (projectStructure.fileTypes[ext] || 0) + 1
        
        // Map de dependencias (simplificado)
        dependencies ← {}
        PARA CADA file EN filesWithoutTests.slice(0, 20):  // Muestra de los primeros 20
            fileName ← path.basename(file.fsPath)
            dependencies[fileName] ← []
        
        // ⚡ LLAMADA REAL AL LLM: vscode.lm.selectChatModels() + model.sendRequest()
        // Envía: lista de archivos, estructura del proyecto, dependencias
        // Recibe: plan de grupos priorizados con razones del LLM
        batchPlan ← AWAIT llmProvider.planBatchGeneration({
            allFiles: filesWithoutTests.map(f => path.relative(firstProjectRoot, f.fsPath)),
            projectStructure: projectStructure,
            existingTests: [],
            dependencies: dependencies
        })
        
        // Mostrar plan al usuario
        stream.markdown('\n🧠 **Batch Generation Plan (by LLM):**\n\n')
        PARA CADA group EN batchPlan.groups.slice(0, 3):  // Top 3 grupos
            stream.markdown(`**${group.name}** (Priority ${group.priority}): ${group.files.length} files\n`)
            stream.markdown(`  _${group.reason}_\n\n`)
        
        stream.markdown(`**Estimated time:** ${batchPlan.estimatedTime}\n`)
        stream.markdown(`**Recommended concurrency:** ${batchPlan.recommendedConcurrency}\n\n`)
        
        Logger.info('Batch generation plan created', {
            groups: batchPlan.groups.length,
            estimatedTime: batchPlan.estimatedTime
        })
    
    CAPTURAR error:
        Logger.warn('Failed to plan batch generation, using default order', error)
        stream.markdown('⚠️ Could not plan batch strategy (LLM error)\n\n')
    
    stream.markdown(`⚠️ Esto generará tests para ${filesWithoutTests.length} archivos. Puede tomar varios minutos.\n\n`)
    
    successCount ← 0
    failCount ← 0
    currentFile ← 0
    
    // ═══════════════════════════════════════════════════════
    // FASE 4: Reordenar Archivos según Plan LLM
    // ═══════════════════════════════════════════════════════
    orderedFiles ← filesWithoutTests
    
    SI batchPlan:
        fileMap ← NUEVO Map(filesWithoutTests.map(f => [path.relative(firstProjectRoot, f.fsPath), f]))
        newOrder ← []
        
        // Agregar archivos en orden de prioridad de grupos
        PARA CADA group EN batchPlan.groups.sort((a, b) => a.priority - b.priority):
            PARA CADA relPath EN group.files:
                file ← fileMap.get(relPath)
                SI file:
                    newOrder.push(file)
                    fileMap.delete(relPath)
        
        // Agregar archivos restantes no incluidos en el plan
        PARA CADA file EN fileMap.values():
            newOrder.push(file)
        
        orderedFiles ← newOrder
        Logger.info(`Files reordered according to LLM plan: ${orderedFiles.length} files`)
    
    // ═══════════════════════════════════════════════════════
    // FASE 5: Procesamiento de Archivos por Proyecto
    // ═══════════════════════════════════════════════════════
    PARA CADA [projectRoot, files] EN projectMap.entries():
        stream.markdown(`### Proyecto: \`${path.basename(projectRoot)}\`\n\n`)
        
        agent ← NUEVO TestAgent(undefined, stateService)
        
        // Usar orderedFiles para este proyecto
        projectFiles ← orderedFiles.filter(f => {
            folder ← vscode.workspace.getWorkspaceFolder(f)
            RETORNAR folder?.uri.fsPath === projectRoot
        })
        
        PARA CADA file EN projectFiles:
            SI token.isCancellationRequested:
                stream.markdown('\n⚠️ Generación cancelada por el usuario\n')
                ROMPER
            
            currentFile++
            fileName ← path.basename(file.fsPath)
            
            stream.progress(`[${currentFile}/${filesWithoutTests.length}] ${fileName}...`)
            stream.markdown(`\n#### [${currentFile}/${filesWithoutTests.length}] \`${fileName}\`\n`)
            
            INTENTAR:
                AWAIT agent.generateAndHealTest(file.fsPath, projectRoot, stream)
                successCount++
                stream.markdown('✅ Éxito\n')
            
            CAPTURAR error:
                failCount++
                errorMsg ← error instanceof Error ? error.message : 'Error desconocido'
                stream.markdown(`❌ Falló: ${errorMsg}\n`)
                Logger.error(`Failed to generate test for ${fileName}`, error)
                CONTINUAR  // Continuar con siguiente archivo
            
            // Delay para evitar rate limiting
            SI currentFile < filesWithoutTests.length:
                stream.progress('Esperando para evitar límites de API...')
                AWAIT sleep(2000)  // 2 segundos
    
    // ═══════════════════════════════════════════════════════
    // FASE 6: Análisis de Coverage
    // ═══════════════════════════════════════════════════════
    coverageService ← NUEVO CoverageService()
    coverageThreshold ← 80
    maxCoverageIterations ← 2
    
    stream.markdown('\n---\n\n## 📊 Coverage Analysis\n\n')
    stream.progress('Running coverage analysis...')
    
    coverageReport ← undefined
    
    INTENTAR:
        coverageReport ← AWAIT coverageService.runCoverage(firstProjectRoot, coverageThreshold)
        stream.markdown(coverageService.formatReportAsMarkdown(coverageReport))
    
    CAPTURAR error:
        Logger.error('Coverage analysis failed', error)
        stream.markdown('⚠️ Coverage analysis failed — skipping coverage-driven iteration\n\n')
    
    // ═══════════════════════════════════════════════════════
    // FASE 7: Iteración Guiada por Coverage
    // ═══════════════════════════════════════════════════════
    SI coverageReport Y NO coverageReport.meetsThreshold:
        
        PARA iteration ← 1 HASTA maxCoverageIterations:
            SI token.isCancellationRequested:
                stream.markdown('\n⚠️ Coverage iteration cancelled by user\n')
                ROMPER
            
            filesNeedingCoverage ← coverageService.getFilesNeedingCoverage(coverageReport)
            
            SI filesNeedingCoverage.length === 0:
                ROMPER
            
            stream.markdown(`\n### 🔄 Coverage Iteration ${iteration}/${maxCoverageIterations}\n\n`)
            stream.markdown(`Targeting **${filesNeedingCoverage.length}** files below ${coverageThreshold}%\n\n`)
            
            iterAgent ← NUEVO TestAgent(undefined, stateService)
            iterSuccess ← 0
            iterFail ← 0
            
            // Procesar hasta 10 archivos por iteración
            filesToProcess ← filesNeedingCoverage.slice(0, 10)
            
            PARA CADA filePath EN filesToProcess:
                SI token.isCancellationRequested:
                    ROMPER
                
                fileName ← path.basename(filePath)
                stream.progress(`[coverage iter ${iteration}] ${fileName}...`)
                
                INTENTAR:
                    fileUri ← vscode.Uri.file(filePath)
                    fileFolder ← vscode.workspace.getWorkspaceFolder(fileUri)
                    projectRoot ← fileFolder?.uri.fsPath || firstProjectRoot
                    
                    AWAIT iterAgent.generateAndHealTest(filePath, projectRoot, stream, 'balanced')
                    iterSuccess++
                    successCount++
                
                CAPTURAR error:
                    iterFail++
                    failCount++
                    errorMsg ← error instanceof Error ? error.message : 'Error'
                    stream.markdown(`❌ \`${fileName}\`: ${errorMsg}\n`)
                    Logger.error(`Coverage iteration: failed for ${fileName}`, error)
                
                AWAIT sleep(2000)  // Rate-limit pause
            
            stream.markdown(`\n✅ Iteration ${iteration}: ${iterSuccess} generated, ${iterFail} failed\n\n`)
            
            // ───────────────────────────────────────────────────
            // Re-ejecutar coverage después de esta iteración
            // ───────────────────────────────────────────────────
            stream.progress('Re-running coverage analysis...')
            previousReport ← coverageReport
            
            INTENTAR:
                coverageReport ← AWAIT coverageService.runCoverage(firstProjectRoot, coverageThreshold)
                stream.markdown(coverageService.compareCoverage(previousReport, coverageReport))
                
                SI coverageReport.meetsThreshold:
                    stream.markdown(`\n🎉 **Coverage target ≥${coverageThreshold}% reached!**\n\n`)
                    ROMPER
            
            CAPTURAR error:
                Logger.error('Coverage re-analysis failed', error)
                stream.markdown('⚠️ Coverage re-analysis failed — stopping iteration\n')
                ROMPER
        
        // Dashboard final de coverage
        SI coverageReport:
            stream.markdown('\n---\n\n')
            stream.markdown(coverageService.formatReportAsMarkdown(coverageReport))
    
    // ═══════════════════════════════════════════════════════
    // FASE 8: Resumen Final
    // ═══════════════════════════════════════════════════════
    stream.markdown('\n---\n\n## 📊 Resumen Final\n\n')
    stream.markdown(`- ✅ Generados exitosamente: **${successCount}** tests\n`)
    stream.markdown(`- ❌ Fallidos: **${failCount}** tests\n`)
    stream.markdown(`- 📝 Total procesados: **${currentFile}** archivos (initial batch)\n`)
    
    SI coverageReport:
        stream.markdown(`- 📈 Coverage final: **${coverageReport.global.statements.toFixed(1)}%** statements\n`)
    
    stream.markdown('\n')
    
    batchDuration ← Date.now() - batchStartTime
    telemetryService.trackBatchGeneration(currentFile, successCount, failCount, batchDuration)
    
    Logger.info('Batch test generation completed', {
        total: currentFile,
        success: successCount,
        failed: failCount
    })
    
    RETORNAR { metadata: { command: 'generate-all' } }
FIN FUNCIÓN
```

---

## Agente de Pruebas (TestAgent)

**Archivo:** `agent/TestAgent.ts`
**Clase:** `TestAgent`
**Método Principal:** `generateAndHealTest(sourceFilePath, workspaceRoot, stream, mode)`

### Arquitectura del Agente

```
TestAgent
    ├── Constructor
    │   ├── testRunner: TestRunner
    │   ├── llmProvider: ILLMProvider
    │   ├── logger: Logger
    │   ├── stateService: StateService
    │   ├── setupService: ProjectSetupService
    │   ├── telemetryService: TelemetryService
    │   ├── contextCollector: SourceContextCollector
    │   └── stackDiscovery: StackDiscoveryService
    │
    ├── generateAndHealTest() [Método Principal]
    │   ├── Validación de archivo
    │   ├── Recolección de contexto
    │   ├── Descubrimiento de stack
    │   ├── Planificación de estrategia (LLM)
    │   ├── Generación inicial de test (LLM)
    │   ├── Ejecución de test (Jest)
    │   └── Bucle de auto-reparación (LLM + Jest)
    │
    └── Métodos Auxiliares
        ├── validateSourceFile()
        ├── getTestFilePath()
        ├── buildProjectAnalysis()
        ├── findExistingTestPatterns()
        └── sleep()
```

### Flujo Completo de `generateAndHealTest`

```metalenguaje
MÉTODO generateAndHealTest(sourceFilePath, workspaceRoot, stream, mode = 'balanced'):
    config ← ConfigService.getConfig()
    
    // ═══════════════════════════════════════════════════════
    // FASE 0: Determinar Parámetros según Modo
    // ═══════════════════════════════════════════════════════
    effectiveMaxAttempts ← config.maxHealingAttempts
    shouldExecuteTests ← true
    
    SEGÚN mode:
        CASO 'fast':
            effectiveMaxAttempts ← 0
            shouldExecuteTests ← false
        
        CASO 'balanced':
            effectiveMaxAttempts ← 1
        
        CASO 'thorough':
            effectiveMaxAttempts ← 3
    
    startTime ← Date.now()
    errorPatterns ← []
    
    telemetryService.trackCommandExecution('generate')
    
    // ═══════════════════════════════════════════════════════
    // FASE 1: Validación de Archivo Fuente
    // ═══════════════════════════════════════════════════════
    this.validateSourceFile(sourceFilePath, workspaceRoot)
    
    // Verificar que Jest está disponible
    jestAvailable ← AWAIT this.testRunner.isJestAvailable(workspaceRoot, config.jestCommand)
    SI NO jestAvailable:
        LANZAR JestNotFoundError(workspaceRoot)
    
    // Leer archivo fuente
    sourceCode ← fs.readFileSync(sourceFilePath, 'utf-8')
    sourceFileName ← path.basename(sourceFilePath)
    
    Logger.info('Starting test generation', {
        sourceFile: sourceFileName,
        workspace: workspaceRoot
    })
    
    stream.progress('Collecting source context...')
    
    // ═══════════════════════════════════════════════════════
    // FASE 2: Recolección de Contexto de Dependencias
    // ═══════════════════════════════════════════════════════
    dependencyContext ← undefined
    
    INTENTAR:
        fullContext ← AWAIT this.contextCollector.collectContext(sourceFilePath, workspaceRoot)
        dependencyContext ← this.contextCollector.formatForPrompt(fullContext)
        
        SI dependencyContext:
            Logger.info('Dependency context collected', {
                dependencies: fullContext.dependencies.size,
                spfxPatterns: fullContext.spfxPatterns.length
            })
    
    CAPTURAR error:
        Logger.warn('Failed to collect dependency context, proceeding without it', error)
    
    // ═══════════════════════════════════════════════════════
    // FASE 3: Descubrimiento de Stack del Proyecto
    // ═══════════════════════════════════════════════════════
    systemPrompt ← undefined
    
    INTENTAR:
        SI NO this.detectedStack:
            stream.progress('Discovering project stack...')
            this.detectedStack ← AWAIT this.stackDiscovery.discover(workspaceRoot)
            
            Logger.info('Stack discovered', {
                framework: this.detectedStack.framework,
                language: this.detectedStack.language,
                testRunner: this.detectedStack.testRunner,
                confidence: this.detectedStack.confidence
            })
            
            summary ← this.stackDiscovery.formatStackSummary(this.detectedStack)
            stream.markdown(`📦 **Detected stack:** ${summary}\n\n`)
        
        systemPrompt ← PROMPTS.buildSystemPrompt(this.detectedStack)
    
    CAPTURAR error:
        Logger.warn('Stack discovery failed, using default prompts', error)
    
    // Determinar path del test file
    testFilePath ← this.getTestFilePath(sourceFilePath, config.testFilePattern)
    
    Logger.info(`Test file will be created at: ${testFilePath}`)
    
    // ═══════════════════════════════════════════════════════
    // FASE 4: Planificación de Estrategia de Test (LLM-FIRST)
    // ═══════════════════════════════════════════════════════
    // ⚡ LLAMADA REAL AL LLM #1: Planificar estrategia de test
    testStrategy ← undefined
    
    INTENTAR:
        stream.progress('Analyzing source code and planning test strategy...')
        projectAnalysis ← AWAIT this.buildProjectAnalysis(workspaceRoot)
        
        // ⚡ LLAMADA REAL: Envía código fuente completo + análisis del proyecto
        // El LLM decide: approach, mocking strategy, mocks needed, potential issues
        testStrategy ← AWAIT this.llmProvider.planTestStrategy({
            sourceCode: sourceCode,
            fileName: sourceFileName,
            projectAnalysis: projectAnalysis,
            existingTestPatterns: AWAIT this.findExistingTestPatterns(workspaceRoot)
        })
        
        // Mostrar estrategia al usuario
        stream.markdown('\n🧠 **Test Strategy Planned by LLM:**\n\n')
        stream.markdown(`- **Approach:** ${testStrategy.approach}\n`)
        stream.markdown(`- **Mocking:** ${testStrategy.mockingStrategy}\n`)
        
        SI testStrategy.mocksNeeded.length > 0:
            mocksPreview ← testStrategy.mocksNeeded.slice(0, 3).join(', ')
            SI testStrategy.mocksNeeded.length > 3:
                mocksPreview += '...'
            stream.markdown(`- **Mocks needed:** ${mocksPreview}\n`)
        
        SI testStrategy.potentialIssues.length > 0:
            stream.markdown(`- **Potential issues:** ${testStrategy.potentialIssues[0]}\n`)
        
        stream.markdown(`- **Est. iterations:** ${testStrategy.estimatedIterations}\n\n`)
        
        Logger.info('Test strategy planned', {
            approach: testStrategy.approach,
            mockingStrategy: testStrategy.mockingStrategy,
            mocksCount: testStrategy.mocksNeeded.length
        })
    
    CAPTURAR error:
        Logger.warn('Failed to plan test strategy, proceeding without it', error)
        stream.markdown('⚠️ Could not plan strategy (LLM error), proceeding with default\n\n')
    
    stream.progress('Generating initial test...')
    
    // ═══════════════════════════════════════════════════════
    // FASE 5: Generación Inicial de Test (LLM)
    // ═══════════════════════════════════════════════════════
    // ⚡ LLAMADA REAL AL LLM #2: Generar código del test
    // Envía: sourceCode completo + dependencyContext + systemPrompt + testStrategy
    // Recibe: Código completo del test generado por el LLM
    result ← AWAIT this.llmProvider.generateTest({
        sourceCode: sourceCode,
        fileName: sourceFileName,
        dependencyContext: dependencyContext,
        systemPrompt: systemPrompt,
        attempt: 1,
        maxAttempts: config.maxHealingAttempts
    })
    
    fs.writeFileSync(testFilePath, result.code, 'utf-8')
    Logger.info('Initial test file generated', { model: result.model, mode: mode })
    
    stream.markdown(`✅ Generated test file: \`${path.relative(workspaceRoot, testFilePath)}\`\n\n`)
    
    // ═══════════════════════════════════════════════════════
    // FASE 6: Modo FAST - Saltar Ejecución
    // ═══════════════════════════════════════════════════════
    SI NO shouldExecuteTests:
        stream.markdown('⚡ **Modo FAST**: Test generado sin ejecutar\n\n')
        stream.markdown(`💡 Revisa el test manualmente o ejecútalo con: \`npm test ${path.basename(testFilePath)}\`\n`)
        
        duration ← Date.now() - startTime
        telemetryService.trackTestGeneration(true, 1, duration)
        
        RETORNAR testFilePath
    
    stream.progress('Running test...')
    
    // ═══════════════════════════════════════════════════════
    // FASE 7: Ejecución Inicial de Test
    // ═══════════════════════════════════════════════════════
    testResult ← AWAIT this.testRunner.runTest(testFilePath, workspaceRoot, config.jestCommand)
    
    // ═══════════════════════════════════════════════════════
    // FASE 8: Bucle de Auto-Reparación
    // ═══════════════════════════════════════════════════════
    attempt ← 1
    rateLimitRetries ← 0
    
    MIENTRAS NO testResult.success Y attempt < effectiveMaxAttempts:
        attempt++
        
        stream.markdown(`⚠️ Test failed on attempt ${attempt - 1}. Analyzing errors...\n\n`)
        
        // ───────────────────────────────────────────────────
        // SUB-FASE 8.1: Limpiar Output de Jest
        // ───────────────────────────────────────────────────
        cleanedError ← JestLogParser.cleanJestOutput(testResult.output)
        
        // CRÍTICO: Si el error limpiado está vacío, usar output raw
        errorToSend ← (cleanedError Y cleanedError.length > 50)
                      ? cleanedError
                      : testResult.output.substring(0, 3000)
        
        Logger.info(`Test failed (attempt ${attempt}), error length: ${testResult.output.length} chars, cleaned: ${cleanedError.length} chars`)
        
        errorPatterns.push(errorToSend.substring(0, 200))
        summary ← JestLogParser.extractTestSummary(testResult.output)
        
        telemetryService.trackHealingAttempt(attempt, 'JestTestFailure')
        
        stream.markdown(`**Error Summary:** ${summary.failed} failed, ${summary.passed} passed\n\n`)
        stream.progress(`Healing test (attempt ${attempt}/${effectiveMaxAttempts})...`)
        
        // Esperar brevemente (backoff exponencial)
        AWAIT this.sleep(config.initialBackoffMs * attempt)
        
        INTENTAR:
            // ───────────────────────────────────────────────
            // SUB-FASE 8.2: Leer Test Actual
            // ───────────────────────────────────────────────
            currentTestCode ← fs.existsSync(testFilePath)
                              ? fs.readFileSync(testFilePath, 'utf-8')
                              : ''
            
            // ⚡ LLAMADA REAL AL LLM #3-N: Reparar test fallido
            // Envía: sourceCode + currentTestCode + errorContext (error de Jest)
            // Recibe: Test corregido por el LLM con los errores solucionados
            // ───────────────────────────────────────────────
            // SUB-FASE 8.3: Pedir al LLM que Repare el Test
            // ───────────────────────────────────────────────
            result ← AWAIT this.llmProvider.fixTest({
                sourceCode: sourceCode,
                fileName: sourceFileName,
                currentTestCode: currentTestCode,
                errorContext: errorToSend,
                dependencyContext: dependencyContext,
                systemPrompt: systemPrompt,
                attempt: attempt,
                maxAttempts: config.maxHealingAttempts
            })
            
            fs.writeFileSync(testFilePath, result.code, 'utf-8')
            Logger.info(`Test file updated (attempt ${attempt})`, { model: result.model })
            
            stream.markdown(`🔄 Updated test file (attempt ${attempt})\n\n`)
            stream.progress('Running test again...')
            
            // ───────────────────────────────────────────────
            // SUB-FASE 8.4: Ejecutar Test Nuevamente
            // ───────────────────────────────────────────────
            testResult ← AWAIT this.testRunner.runTest(testFilePath, workspaceRoot, config.jestCommand)
            rateLimitRetries ← 0  // Reset contador de rate limit
        
        CAPTURAR error:
            SI error instanceof RateLimitError:
                rateLimitRetries++
                
                SI rateLimitRetries >= config.maxRateLimitRetries:
                    Logger.error('Max rate limit retries exceeded')
                    LANZAR error
                
                stream.markdown(`⏸️ Rate limit encountered (retry ${rateLimitRetries}/${config.maxRateLimitRetries}). Waiting...\n\n`)
                AWAIT this.sleep(5000 * rateLimitRetries)  // Backoff exponencial
                attempt--  // No contar como intento real
                CONTINUAR
            
            Logger.error('Error during test healing', error)
            LANZAR error
    
    // ═══════════════════════════════════════════════════════
    // FASE 9: Guardar en Historial
    // ═══════════════════════════════════════════════════════
    SI this.stateService:
        history ← {
            sourceFile: sourceFilePath,
            testFile: testFilePath,
            timestamp: NUEVA Date(),
            attempts: attempt,
            success: testResult.success,
            errorPatterns: errorPatterns,
            model: result.model || 'unknown'
        }
        
        AWAIT this.stateService.addTestGeneration(history)
        Logger.debug('Test generation saved to history')
    
    // ═══════════════════════════════════════════════════════
    // FASE 10: Resultados Finales
    // ═══════════════════════════════════════════════════════
    duration ← Date.now() - startTime
    
    telemetryService.trackTestGeneration(testResult.success, attempt, duration)
    
    SI testResult.success:
        stream.markdown(`✅ **Test passed successfully!** (${(duration / 1000).toFixed(1)}s)\n\n`)
        summary ← JestLogParser.extractTestSummary(testResult.output)
        stream.markdown(`**Final Results:** ${summary.passed} passed, ${summary.total} total\n\n`)
        Logger.info('Test generation succeeded', { attempts: attempt, duration: duration })
    
    ELSE:
        stream.markdown(`❌ **Test still failing after ${config.maxHealingAttempts} attempts.** (${(duration / 1000).toFixed(1)}s)\n\n`)
        stream.markdown('Consider reviewing the generated test manually.\n\n')
        
        cleanedError ← JestLogParser.cleanJestOutput(testResult.output)
        errorToShow ← (cleanedError Y cleanedError.length > 20)
                      ? cleanedError
                      : testResult.output.substring(0, 2000)
        
        stream.markdown('```\n' + errorToShow + '\n```\n\n')
        
        Logger.warn('Test generation failed', {
            attempts: attempt,
            duration: duration,
            outputLength: testResult.output.length,
            cleanedLength: cleanedError.length
        })
        
        telemetryService.trackError('TestGenerationError', 'generation')
        
        LANZAR NUEVO TestGenerationError(
            'Test still failing after maximum attempts',
            attempt,
            config.maxHealingAttempts,
            testResult.output
        )
    
    RETORNAR testFilePath
FIN MÉTODO
```

### Métodos Auxiliares de TestAgent

#### `validateSourceFile`
```metalenguaje
MÉTODO validateSourceFile(sourceFilePath, workspaceRoot):
    normalizedPath ← path.normalize(sourceFilePath)
    normalizedWorkspace ← path.normalize(workspaceRoot)
    
    // Verificar que el archivo está dentro del workspace
    SI NO normalizedPath.startsWith(normalizedWorkspace):
        LANZAR NUEVO FileValidationError(
            'Source file must be within workspace',
            sourceFilePath
        )
    
    // Verificar que el archivo existe
    SI NO fs.existsSync(normalizedPath):
        LANZAR NUEVO FileValidationError(
            'Source file does not exist',
            sourceFilePath
        )
    
    Logger.debug('Source file validated', { sourceFilePath })
FIN MÉTODO
```

#### `getTestFilePath`
```metalenguaje
MÉTODO getTestFilePath(sourceFilePath, pattern):
    dir ← path.dirname(sourceFilePath)
    ext ← path.extname(sourceFilePath)
    baseName ← path.basename(sourceFilePath, ext)
    
    // Parsear pattern: ${fileName}.test.${ext}
    // Pattern por defecto crea MyComponent.test.tsx de MyComponent.tsx
    testFileName ← pattern
        .replace('${fileName}', baseName)
        .replace('${ext}', ext.substring(1))  // Remover el punto
    
    // Asegurar extensión correcta
    hasTestExtension ← testFileName.match(/\.test\.(ts|tsx)$|\.spec\.(ts|tsx)$/)
    SI NO hasTestExtension:
        testFileName += ext
    
    testFilePath ← path.join(dir, testFileName)
    
    Logger.debug('Test file path determined', {
        sourceFile: sourceFilePath,
        testFile: testFilePath,
        pattern: pattern
    })
    
    RETORNAR testFilePath
FIN MÉTODO
```

#### `buildProjectAnalysis`
```metalenguaje
MÉTODO buildProjectAnalysis(projectRoot):
    packageJsonPath ← path.join(projectRoot, 'package.json')
    tsConfigPath ← path.join(projectRoot, 'tsconfig.json')
    
    packageJson ← {}
    tsConfig ← undefined
    existingJestConfig ← undefined
    
    // Leer package.json
    SI fs.existsSync(packageJsonPath):
        packageJson ← JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
    
    // Leer tsconfig.json
    SI fs.existsSync(tsConfigPath):
        tsConfig ← JSON.parse(fs.readFileSync(tsConfigPath, 'utf-8'))
    
    // Leer configuración Jest existente
    configFiles ← ['jest.config.js', 'jest.config.ts', 'jest.config.json']
    PARA CADA file EN configFiles:
        configPath ← path.join(projectRoot, file)
        SI fs.existsSync(configPath):
            existingJestConfig ← fs.readFileSync(configPath, 'utf-8')
            ROMPER
    
    // Buscar archivos de test existentes
    existingTests ← []
    srcDir ← path.join(projectRoot, 'src')
    SI fs.existsSync(srcDir):
        this.findTestFiles(srcDir, existingTests)
    
    RETORNAR {
        packageJson: packageJson,
        tsConfig: tsConfig,
        existingJestConfig: existingJestConfig,
        existingTests: existingTests.map(f => path.basename(f)),
        dependencies: packageJson.dependencies || {},
        devDependencies: packageJson.devDependencies || {},
        framework: this.detectFramework(packageJson),
        reactVersion: packageJson.dependencies?.react || packageJson.devDependencies?.react,
        nodeVersion: packageJson.engines?.node
    }
FIN MÉTODO
```

#### `findTestFiles`
```metalenguaje
MÉTODO findTestFiles(dir, results):
    SI results.length >= 10:  // Límite de 10 ejemplos
        RETORNAR
    
    INTENTAR:
        entries ← fs.readdirSync(dir, { withFileTypes: true })
        
        PARA CADA entry EN entries:
            SI results.length >= 10:
                ROMPER
            
            fullPath ← path.join(dir, entry.name)
            
            SI entry.isDirectory() Y entry.name !== 'node_modules':
                this.findTestFiles(fullPath, results)
            
            ELSE SI entry.name.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/):
                results.push(fullPath)
    
    CAPTURAR error:
        // Ignorar errores de lectura
FIN MÉTODO
```

#### `detectFramework`
```metalenguaje
MÉTODO detectFramework(packageJson):
    deps ← { ...packageJson.dependencies, ...packageJson.devDependencies }
    
    SI deps['@microsoft/sp-core-library']:
        RETORNAR 'spfx'
    SI deps['@angular/core']:
        RETORNAR 'angular'
    SI deps['next']:
        RETORNAR 'next'
    SI deps['react']:
        RETORNAR 'react'
    SI deps['vue']:
        RETORNAR 'vue'
    SI deps['@types/vscode']:
        RETORNAR 'vscode-extension'
    
    RETORNAR 'unknown'
FIN MÉTODO
```

#### `findExistingTestPatterns`
```metalenguaje
MÉTODO findExistingTestPatterns(projectRoot):
    patterns ← []
    srcDir ← path.join(projectRoot, 'src')
    
    SI NO fs.existsSync(srcDir):
        RETORNAR patterns
    
    testFiles ← []
    this.findTestFiles(srcDir, testFiles)
    
    // Extraer patrones de los primeros 3 test files
    PARA CADA testFile EN testFiles.slice(0, 3):
        INTENTAR:
            content ← fs.readFileSync(testFile, 'utf-8')
            
            // Extraer bloques describe
            describeBlocks ← content.match(/describe\(['"](.*?)['"]/g)
            itBlocks ← content.match(/it\(['"](.*?)['"]/g)
            
            SI describeBlocks Y describeBlocks.length > 0:
                patterns.push(describeBlocks[0])
            
            SI itBlocks Y itBlocks.length > 0:
                patterns.push(itBlocks[0])
            
            // Verificar patrones de setup comunes
            SI content.includes('beforeEach'):
                patterns.push('Uses beforeEach setup')
            
            SI content.includes('jest.mock'):
                patterns.push('Uses jest.mock for dependencies')
        
        CAPTURAR error:
            // Ignorar errores de lectura
    
    RETORNAR patterns.slice(0, 5)  // Máximo 5 patrones
FIN MÉTODO
```

---

## Servicios Auxiliares

### ProjectSetupService

**Archivo:** `services/ProjectSetupService.ts`

#### `checkProjectSetup`
```metalenguaje
MÉTODO checkProjectSetup(projectRoot):
    status ← {
        hasPackageJson: false,
        hasJest: false,
        hasJestConfig: false,
        hasJestSetup: false,
        missingDependencies: [],
        errors: [],
        warnings: []
    }
    
    // Verificar package.json
    packageJsonPath ← path.join(projectRoot, 'package.json')
    SI NO fs.existsSync(packageJsonPath):
        status.errors.push('No package.json found in project root')
        RETORNAR status
    
    status.hasPackageJson ← true
    
    // Leer package.json
    INTENTAR:
        content ← fs.readFileSync(packageJsonPath, 'utf-8')
        packageJson ← JSON.parse(content)
    CAPTURAR error:
        status.errors.push(`Failed to parse package.json: ${error}`)
        RETORNAR status
    
    // Verificar dependencias Jest
    allDeps ← {
        ...packageJson.dependencies || {},
        ...packageJson.devDependencies || {}
    }
    
    Logger.debug('All dependencies found in package.json', {
        total: Object.keys(allDeps).length
    })
    
    status.hasJest ← AWAIT this.dependencyService.checkJestAvailability(projectRoot)
    
    // Obtener dependencias compatibles recomendadas por LLM
    compatibleDeps ← AWAIT this.dependencyService.getCompatibleDependencies(projectRoot)
    
    Logger.debug('LLM-recommended dependencies', {
        packages: Object.keys(compatibleDeps),
        count: Object.keys(compatibleDeps).length
    })
    
    // Verificar dependencias faltantes
    PARA CADA [pkg, version] EN Object.entries(compatibleDeps):
        SI NO allDeps[pkg]:
            Logger.debug(`Missing dependency: ${pkg}`)
            status.missingDependencies.push(pkg)
        ELSE:
            Logger.debug(`Dependency found: ${pkg} = ${allDeps[pkg]}`)
    
    // Generar comando npm install si hay dependencias faltantes
    SI status.missingDependencies.length > 0:
        packageVersions ← status.missingDependencies.map(pkg => {
            version ← compatibleDeps[pkg]
            RETORNAR `${pkg}@${version}`
        })
        status.installCommand ← `npm install --save-dev --legacy-peer-deps ${packageVersions.join(' ')}`
    ELSE:
        Logger.info('✅ All required Jest dependencies are installed')
    
    // Verificar jest.config.js
    status.hasJestConfig ← this.configService.hasJestConfig(projectRoot)
    
    // Verificar jest.setup.js
    jestSetupPath ← path.join(projectRoot, 'jest.setup.js')
    status.hasJestSetup ← fs.existsSync(jestSetupPath)
    
    // Agregar advertencias
    SI NO status.hasJestConfig:
        status.warnings.push('No jest.config.js found - using default configuration')
    
    SI NO status.hasJestSetup:
        status.warnings.push('No jest.setup.js found - testing-library/jest-dom may not work')
    
    RETORNAR status
FIN MÉTODO
```

### LLMProviderFactory

**Archivo:** `factories/LLMProviderFactory.ts`

```metalenguaje
CLASE LLMProviderFactory:
    
    MÉTODO ESTÁTICO createProvider():
        config ← ConfigService.getConfig()
        provider ← undefined
        
        // Verificar si Azure OpenAI está configurado
        hasAzureConfig ← config.azureOpenAI?.endpoint Y
                         config.azureOpenAI?.apiKey Y
                         config.azureOpenAI?.deploymentName
        
        SI hasAzureConfig:
            Logger.info('Using Azure OpenAI Provider')
            provider ← NUEVO AzureOpenAIProvider()
        ELSE:
            Logger.info(`Using Copilot Provider (${config.llmVendor} - ${config.llmFamily})`)
            provider ← NUEVO CopilotProvider(config.llmVendor, config.llmFamily)
        
        RETORNAR provider
    
FIN CLASE
```

### TestRunner

**Archivo:** `utils/TestRunner.ts`

#### `runTest`
```metalenguaje
MÉTODO runTest(testFilePath, workspaceRoot, jestCommand = 'npx jest'):
    // Validar y sanitizar paths
    normalizedTestPath ← path.normalize(testFilePath)
    normalizedWorkspaceRoot ← path.normalize(workspaceRoot)
    
    // ═══════════════════════════════════════════════════════
    // FASE 1: Verificación de Seguridad
    // ═══════════════════════════════════════════════════════
    SI NO normalizedTestPath.startsWith(normalizedWorkspaceRoot):
        error ← NUEVO SecurityError(
            `Test file must be within workspace. File: ${normalizedTestPath}, Workspace: ${normalizedWorkspaceRoot}`
        )
        Logger.error('Security violation detected', error)
        LANZAR error
    
    // Encontrar project root (closest package.json)
    projectRoot ← FileScanner.findProjectRoot(normalizedTestPath) || normalizedWorkspaceRoot
    
    Logger.debug('Project root detected', {
        testFile: normalizedTestPath,
        projectRoot: projectRoot,
        workspaceRoot: normalizedWorkspaceRoot
    })
    
    // ═══════════════════════════════════════════════════════
    // FASE 2: Asegurar ts-jest Instalado
    // ═══════════════════════════════════════════════════════
    SI NO this.configService.isTsJestInstalled(projectRoot):
        Logger.warn('ts-jest NOT found in node_modules — auto-installing...')
        pkgService ← NUEVO PackageInstallationService()
        
        depService ← NUEVO DependencyDetectionService()
        jestVer ← depService.getExistingJestVersion(projectRoot)
        tsJestVer ← (jestVer Y jestVer.major === 28) ? '^28.0.8' : '^29.1.1'
        typesVer ← (jestVer Y jestVer.major === 28) ? '^28.1.0' : '^29.5.11'
        
        AWAIT pkgService.installPackages(projectRoot, [
            `ts-jest@${tsJestVer}`,
            `@types/jest@${typesVer}`,
            'identity-obj-proxy@^3.0.0'
        ])
        
        SI NO this.configService.isTsJestInstalled(projectRoot):
            Logger.error('ts-jest installation failed — tests will likely fail')
        ELSE:
            Logger.info('ts-jest auto-installed successfully')
    
    // ═══════════════════════════════════════════════════════
    // FASE 3: Asegurar Configuración ts-jest
    // ═══════════════════════════════════════════════════════
    AWAIT this.configService.ensureValidJestConfig(projectRoot)
    
    hasValidConfig ← this.configService.hasJestConfig(projectRoot) Y
                     this.configService.validateExistingConfig(projectRoot)
    
    Logger.debug('Jest config validation', {
        projectRoot: projectRoot,
        hasValidConfig: hasValidConfig,
        tsJestInstalled: this.configService.isTsJestInstalled(projectRoot)
    })
    
    // ═══════════════════════════════════════════════════════
    // FASE 4: Preparar Comando Jest
    // ═══════════════════════════════════════════════════════
    commandParts ← jestCommand.split(' ')
    command ← commandParts[0]
    baseArgs ← commandParts.slice(1)
    
    // Construir patrón de test path (escapado para regex)
    testPathForwardSlashes ← normalizedTestPath.replace(/\\/g, '/')
    testPathPattern ← testPathForwardSlashes
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // Escapar caracteres especiales regex
        + '$'  // Anclar al final
    
    args ← [
        ...baseArgs,
        '--testPathPattern',
        testPathPattern,
        '--no-coverage',
        '--verbose',
        '--colors'
    ]
    
    // Si no hay config válido en disco, usar inline config
    SI NO hasValidConfig:
        inlineArgs ← this.configService.getInlineConfigArgs()
        args.push(...inlineArgs)
        Logger.warn('Using inline ts-jest config as fallback')
    
    Logger.info(`Running Jest: ${command} ${args.join(' ')}`, {
        testFile: normalizedTestPath,
        projectRoot: projectRoot
    })
    
    // ═══════════════════════════════════════════════════════
    // FASE 5: Ejecutar Jest
    // ═══════════════════════════════════════════════════════
    RETORNAR NUEVA Promise((resolve) => {
        output ← ''
        
        child ← spawn(command, args, {
            cwd: projectRoot,
            shell: true,
            env: { ...process.env, FORCE_COLOR: '1' }
        })
        
        child.stdout?.on('data', (data) => {
            output += data.toString()
        })
        
        child.stderr?.on('data', (data) => {
            output += data.toString()
        })
        
        child.on('close', (code) => {
            Logger.info(`Jest exited with code ${code}`)
            resolve({
                success: code === 0,
                output: output
            })
        })
        
        child.on('error', (error) => {
            Logger.error('Jest process error', error)
            resolve({
                success: false,
                output: `Process error: ${error.message}\n${output}`
            })
        })
    })
FIN MÉTODO
```

---

## Diagrama de Flujo General

```
Usuario invoca extensión
         ↓
    extension.ts
    activate()
         ↓
   ┌─────┴─────┐
   │           │
Chat Commands  Comandos VSCode
   │           │
   │           └→ spfx-test-agent.setup
   │              spfx-test-agent.checkSetup
   │              spfx-test-agent.installWithCommand
   │
   ├── handleChatRequest()
   │        ↓
   │   Identificar comando
   │        ↓
   │   ┌────┴────┬────────┬─────────┐
   │   │         │        │         │
   │ /setup  /install  /generate  /generate-all
   │   │         │        │         │
   │   ↓         ↓        ↓         ↓
   │   │         │        │         │
   │   │         │        │    FileScanner
   │   │         │        │    .findSourceFiles()
   │   │         │        │         ↓
   │   │         │  ensureJest-    Planificación LLM
   │   │         │  Environment()   (batchPlan)
   │   │         │        │         ↓
   │   │         │        └─────────┤
   │   │         │                  │
   │   │         └──────────────────┤
   │   │                            │
   │   └────────────────────────────┤
   │                                │
   └────────────────────────────────┤
                                    ↓
                              TestAgent
                          .generateAndHealTest()
                                    ↓
                            ┌───────┴───────┐
                            │               │
                    LLMProvider        TestRunner
                    .generateTest()    .runTest()
                    .fixTest()              ↓
                            │           Jest spawned
                            │               ↓
                            │           Success?
                            │           ↓   ↓
                            │          No  Yes
                            │           │   │
                            └───────────┤   │
                                 Loop   │   │
                              (healing) │   │
                                        ↓   ↓
                                    RESULTADO FINAL
                                        ↓
                                  StateService
                              .addTestGeneration()
                                        ↓
                                  Telemetría
```

---

## Resumen de Componentes Clave

### 1. **extension.ts**
- **Responsabilidad**: Punto de entrada, registro de comandos y chat participant
- **Métodos clave**:
  - `activate()`: Inicialización de extensión
  - `handleChatRequest()`: Router principal de comandos de chat
  - `extractPathFromReferences()`: Extrae paths de referencias adjuntas
  - `extractPathFromPrompt()`: Extrae paths del texto del prompt

### 2. **ChatHandlers.ts**
- **Responsabilidad**: Implementación de handlers para cada comando
- **Métodos clave**:
  - `handleSetupRequest()`: Configura entorno Jest
  - `handleInstallRequest()`: Instala dependencias con auto-healing LLM
  - `handleGenerateSingleRequest()`: Genera test para archivo activo
  - `handleGenerateAllRequest()`: Genera tests para todos los archivos
  - `ensureJestEnvironment()`: Valida y configura Jest
  - `validateJestEnvironmentAndHeal()`: Smoke test con auto-healing
  - `handleError()`: Manejo centralizado de errores

### 3. **TestAgent.ts**
- **Responsabilidad**: Agente agentico de generación y auto-reparación de tests
- **Métodos clave**:
  - `generateAndHealTest()`: Método principal del workflow agentico
  - `validateSourceFile()`: Validación de seguridad
  - `getTestFilePath()`: Determina path del test file
  - `buildProjectAnalysis()`: Análisis del proyecto para LLM
  - `findExistingTestPatterns()`: Extrae patrones de tests existentes

### 4. **LLMProviderFactory.ts**
- **Responsabilidad**: Factory para crear instancias de proveedores LLM
- **Métodos clave**:
  - `createProvider()`: Crea CopilotProvider o AzureOpenAIProvider

### 5. **TestRunner.ts**
- **Responsabilidad**: Ejecución segura de tests Jest
- **Métodos clave**:
  - `runTest()`: Ejecuta Jest con validaciones de seguridad y ts-jest
  - `isJestAvailable()`: Verifica disponibilidad de Jest

### 6. **ProjectSetupService.ts**
- **Responsabilidad**: Configuración y validación del entorno Jest
- **Métodos clave**:
  - `checkProjectSetup()`: Verifica estado del proyecto
  - `setupProject()`: Crea archivos de configuración Jest

### 7. **FileScanner.ts**
- **Responsabilidad**: Escaneo y agrupación de archivos fuente
- **Métodos clave**:
  - `findSourceFiles()`: Encuentra archivos .ts/.tsx
  - `filterFilesWithoutTests()`: Filtra archivos sin tests
  - `groupFilesByProject()`: Agrupa por proyecto

---

Este documento proporciona una comprensión completa de todos los flujos de ejecución de la extensión SPFX Test Agent, desde la activación hasta la generación y auto-reparación de tests, incluyendo todas las bifurcaciones y procesos auxiliares.

---

## Llamadas Reales al LLM

### ¿Cómo se Comunica la Extensión con el LLM?

La extensión utiliza la **API Language Model de VS Code** (`vscode.lm`) para comunicarse con modelos LLM reales:

```metalenguaje
FUNCIÓN sendRequest(systemPrompt, userPrompt):
    // ═══════════════════════════════════════════════════════
    // PASO 1: Seleccionar Modelo LLM (con fallbacks)
    // ═══════════════════════════════════════════════════════
    models ← []
    
    // Intentar con familia específica (si está configurada)
    SI this.family:
        Logger.info(`Requesting models with family: ${this.family}`)
        models ← AWAIT vscode.lm.selectChatModels({
            vendor: this.vendor,      // 'copilot' por defecto
            family: this.family       // 'gpt-4o', 'gpt-4', etc.
        })
    
    // Fallback 1: Intentar GPT-4o si no hay modelos
    SI models.length === 0:
        Logger.info('Trying GPT-4o as primary model...')
        models ← AWAIT vscode.lm.selectChatModels({
            vendor: this.vendor,
            family: 'gpt-4o'
        })
    
    // Fallback 2: Intentar cualquier GPT-4
    SI models.length === 0:
        Logger.info('Trying any GPT-4 model...')
        models ← AWAIT vscode.lm.selectChatModels({
            vendor: this.vendor,
            family: 'gpt-4'
        })
    
    // Fallback 3: Cualquier modelo disponible (filtrando problemáticos)
    SI models.length === 0:
        Logger.info('Trying any available model...')
        allModels ← AWAIT vscode.lm.selectChatModels({ vendor: this.vendor })
        
        // Filtrar modelos incompatibles (ej: Claude Opus sin API)
        models ← allModels.filter(model => !model.id.includes('claude-opus'))
    
    SI models.length === 0:
        LANZAR LLMNotAvailableError(this.vendor, this.family)
    
    model ← models[0]
    Logger.info(`Using model: ${model.id} (${model.name})`)
    
    // ═══════════════════════════════════════════════════════
    // PASO 2: Crear Mensajes para el LLM
    // ═══════════════════════════════════════════════════════
    messages ← [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(userPrompt)
    ]
    
    // ═══════════════════════════════════════════════════════
    // PASO 3: Enviar Petición REAL al LLM (con timeout)
    // ═══════════════════════════════════════════════════════
    cancellationTokenSource ← NUEVO vscode.CancellationTokenSource()
    timeoutHandle ← setTimeout(() => {
        cancellationTokenSource.cancel()
    }, this.timeoutMs)  // Default: 120000ms (2 minutos)
    
    INTENTAR:
        // ⚡ LLAMADA HTTP REAL AL MODELO LLM
        // Esta línea hace una petición real a la API de GitHub Copilot
        // que a su vez llama a OpenAI GPT-4/GPT-4o u otro modelo
        response ← AWAIT model.sendRequest(messages, {}, cancellationTokenSource.token)
        
        // Recoger respuesta en streaming (chunks de texto)
        code ← ''
        PARA CADA chunk EN AWAIT response.text:
            code += chunk  // Texto llega en fragmentos (streaming)
        
        clearTimeout(timeoutHandle)
        
        // Extraer código de markdown si está presente
        code ← this.extractCodeFromMarkdown(code)
        
        Logger.debug('LLM response received', { codeLength: code.length })
        
        RETORNAR {
            code: code,
            model: model.id,
            tokensUsed: response.tokensUsed  // Puede no estar disponible
        }
    
    CAPTURAR error:
        clearTimeout(timeoutHandle)
        
        SI error.message.includes('rate limit') O error.code === 'ERR_RATE_LIMIT':
            LANZAR NUEVO RateLimitError(error.message, 60000)
        
        Logger.error('LLM request failed', error)
        LANZAR error
FIN FUNCIÓN
```

### Flujo Completo de una Llamada LLM

```
Usuario invoca comando @spfx-tester /generate-all
         ↓
handleGenerateAllRequest()
         ↓
llmProvider.planBatchGeneration(context)
         ↓
CopilotProvider.sendRequest(systemPrompt, userPrompt)
         ↓
vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' })
         ↓
    ┌───────────────────────┐
    │  VS Code API          │
    │  (vscode.lm)          │
    └───────────────────────┘
         ↓
    ┌───────────────────────┐
    │  GitHub Copilot API   │
    │  (Autenticación)      │
    └───────────────────────┘
         ↓
    ┌───────────────────────┐
    │  OpenAI API           │
    │  GPT-4o / GPT-4       │ ⚡ LLAMADA REAL HTTP
    │  (Procesamiento)      │
    └───────────────────────┘
         ↓
    Streaming Response
    (chunks de texto)
         ↓
    Respuesta completa
         ↓
Procesamiento local (parse JSON, extract code, etc.)
         ↓
    Retorno al flujo
```

### Llamadas LLM en Cada Comando

#### Comando `/setup`
- ❌ **No hace llamadas al LLM directamente**
- Solo crea archivos de configuración estáticos

#### Comando `/install` 
- ✅ **1 llamada al LLM por intento de healing** (máximo 3 intentos)
- **Propósito**: Analizar error de npm y sugerir comando alternativo
- **Prompt enviado**: Error de npm + package.json + comando fallido
- **Respuesta esperada**: Análisis del error + comando corregido

#### Comando `/generate` (archivo único)
- ✅ **Mínimo 3 llamadas al LLM**:
  1. **`planTestStrategy()`**: Analizar código fuente y planificar estrategia de test
  2. **`generateTest()`**: Generar código inicial del test
  3. **`fixTest()` x N**: Reparar test si falla (1-3 veces según configuración)

#### Comando `/generate-all` (batch)
- ✅ **1 + (3 × N archivos) llamadas al LLM**:
  1. **`planBatchGeneration()`**: Priorizar los N archivos (1 llamada)
  2. **Por cada archivo**:
     - `planTestStrategy()`: Planificación (1 llamada)
     - `generateTest()`: Generación inicial (1 llamada)
     - `fixTest()`: Healing (0-3 llamadas si falla)
  
  **Ejemplo**: Para 10 archivos con 1 healing promedio cada uno:
  - 1 (planificación batch) + 10 × (1 plan + 1 generación + 1 healing) = **31 llamadas al LLM**

### Contexto Enviado al LLM

#### Para `planBatchGeneration`:
```json
{
  "allFiles": [
    "src/components/Header.tsx",
    "src/components/Footer.tsx",
    "src/services/ApiService.ts",
    ...
  ],
  "projectStructure": {
    "totalFiles": 25,
    "fileTypes": {
      ".tsx": 15,
      ".ts": 10
    }
  },
  "existingTests": [],
  "dependencies": {
    "Header.tsx": ["Button", "Icon"],
    "ApiService.ts": ["axios"]
  }
}
```

#### Para `generateTest`:
```typescript
{
  "sourceCode": "import React from 'react'...",  // Código completo del componente
  "fileName": "Header.tsx",
  "dependencyContext": "// Dependency: Button.tsx\n...",  // Contexto de dependencias
  "systemPrompt": "You are an expert in React + SPFx testing...",  // Prompts dinámicos según stack
  "attempt": 1,
  "maxAttempts": 3
}
```

#### Para `fixTest`:
```typescript
{
  "sourceCode": "import React from 'react'...",  // Código original
  "fileName": "Header.tsx",
  "currentTestCode": "describe('Header', () => {...})",  // Test que falló
  "errorContext": "TypeError: Cannot read property 'map' of undefined...",  // Error de Jest
  "dependencyContext": "...",
  "attempt": 2,
  "maxAttempts": 3
}
```

### Costos y Rate Limits

- **Costos**: Según la suscripción de GitHub Copilot del usuario
  - Copilot Individual: Incluido en suscripción mensual ($10/mes)
  - Copilot Business: Incluido en suscripción empresarial ($19/usuario/mes)
  - Las llamadas cuentan contra la cuota del usuario

- **Rate Limits**: 
  - GitHub Copilot tiene límites de requests por minuto
  - La extensión implementa:
    - **Exponential backoff**: Espera creciente entre reintentos
    - **Delays entre archivos**: 2 segundos en batch generation
    - **Máximo de reintentos**: 5 para rate limits, 3 para healing

- **Timeouts**:
  - Timeout por request: 120 segundos (2 minutos)
  - Si el LLM no responde, se cancela la petición

### Alternativas: Azure OpenAI

Si se configura Azure OpenAI en lugar de Copilot:

```json
// settings.json
{
  "spfx-tester.llmProvider": "azure-openai",
  "spfx-tester.azureOpenAI.endpoint": "https://your-resource.openai.azure.com/",
  "spfx-tester.azureOpenAI.apiKey": "your-api-key",
  "spfx-tester.azureOpenAI.deploymentName": "gpt-4o"
}
```

Las llamadas van directo a Azure OpenAI sin pasar por GitHub Copilot:
- Facturación separada (por tokens consumidos)
- Rate limits configurables en Azure
- Misma interfaz de código, diferente proveedor

---

**Conclusión**: Todas las llamadas al LLM son **100% reales y funcionales**, no hay simulación ni datos hardcodeados. Cada génération de test, healing, y planificación implica comunicación real con modelos GPT-4/GPT-4o a través de la API de GitHub Copilot o Azure OpenAI.
