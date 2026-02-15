# Flujos de Ejecución de Test Agent

> **Versión:** 0.7.0 — Arquitectura LLM-First con Tool Calling  
> **Fecha:** Febrero 2026

> **⚠️ NOTA SOBRE LLM:** Todas las llamadas a LLM son **reales**. La extensión usa la API `vscode.lm` para comunicarse con modelos (GPT-4, GPT-4o, etc.) a través de GitHub Copilot. Las respuestas se procesan en streaming. Los costos y rate limits aplican según la suscripción de Copilot del usuario.

---

## Índice
1. [Arquitectura General](#arquitectura-general)
2. [Activación de la Extensión](#activación-de-la-extensión)
3. [Sistema de Tools](#sistema-de-tools)
4. [LLMOrchestrator — Loop Agéntico](#llmorchestrator--loop-agéntico)
5. [Flujo del Chat Handler Principal](#flujo-del-chat-handler-principal)
6. [Comando /setup](#comando-setup)
7. [Comando /install](#comando-install)
8. [Comando /generate](#comando-generate)
9. [Comando /generate-all](#comando-generate-all)
10. [Detección Inteligente de Dependencias (3 capas)](#detección-inteligente-de-dependencias-3-capas)
11. [Servicios Auxiliares](#servicios-auxiliares)
12. [Llamadas Reales al LLM](#llamadas-reales-al-llm)

---

## Arquitectura General

```
Usuario ──► @test-agent /comando
                │
                ▼
┌──────────────────────────────────────────┐
│ extension.ts (punto de entrada)          │
│   • Inicializa LLMProvider               │
│   • Crea ToolRegistry (8 tools)          │
│   • Crea LLMOrchestrator                 │
│   • Registra chat participant            │
│   • Registra comandos VS Code            │
└──────────────┬───────────────────────────┘
               ▼
┌──────────────────────────────────────────┐
│ ChatHandlers.ts (enrutador de comandos)  │
│   • handleSetupRequest()                 │
│   • handleInstallRequest()               │
│   • handleGenerateSingleRequest()        │
│   • handleGenerateAllRequest()           │
│   • handleError()                        │
└──────────────┬───────────────────────────┘
               ▼
┌──────────────────────────────────────────┐
│ LLMOrchestrator (loop agéntico)          │
│   • execute()           → libre          │
│   • executeGenerateAndHeal() → dirigido  │
│                                          │
│   LLM decide qué tools llamar           │
│   ┌────────────────────────────────┐     │
│   │ ToolRegistry (8 tools)         │     │
│   │ ┌────────────┐ ┌────────────┐  │     │
│   │ │Deterministas│ │Inteligentes│  │     │
│   │ │ 6 tools    │ │ 2 tools    │  │     │
│   │ └────────────┘ └────────────┘  │     │
│   └────────────────────────────────┘     │
└──────────────────────────────────────────┘
```

---

## Activación de la Extensión

**Archivo:** `extension.ts`  
**Función:** `activate(context: vscode.ExtensionContext)`

```
CUANDO extensión se activa:
    1. INSTANCIAR singleton Logger
    2. CREAR StateService(context)
    3. OBTENER configuración desde ConfigService
    4. CONFIGURAR nivel de log

    5. SELECCIONAR proveedor LLM:
       SI config tiene azureOpenAI.endpoint + apiKey + deploymentName:
           provider = new AzureOpenAIProvider()
       SINO:
           provider = new CopilotProvider(vendor, family)

    6. CREAR sistema de tools:
       toolRegistry = OrchestratorFactory.createToolRegistry(provider)
         → Registra 6 tools deterministas + 2 inteligentes
       orchestrator = new LLMOrchestrator(toolRegistry, provider)

    7. REGISTRAR participant de chat:
       - ID: 'test-agent'
       - Handler: handleChatRequest
       - Icono: icon.png

    8. REGISTRAR comandos VS Code:
       - 'test-agent.setup'              → handleSetupCommand()
       - 'test-agent.checkSetup'         → handleCheckSetupCommand()
       - 'test-agent.installWithCommand'  → abre chat con /install

    9. OBSERVAR cambios de configuración:
       ConfigService.onDidChangeConfiguration → actualizar logLevel
```

---

## Sistema de Tools

### BaseTool (clase abstracta)

Todos los tools heredan de `BaseTool` y definen:

```typescript
abstract get name(): string;           // Nombre único (e.g., 'read_file')
abstract get description(): string;    // Descripción para el prompt del LLM
abstract get parameters(): ToolParameter[];  // Params con tipo y descripción
abstract get returns(): string;        // Descripción del retorno
abstract execute(params, context): Promise<ToolResult>;
```

Métodos heredados:
- `getDefinition()` — Ensambla `ToolDefinition` para el system prompt
- `validateParams()` — Valida parámetros requeridos
- `success(data)` / `error(message)` — Helpers para respuestas estandarizadas

### ToolRegistry

Almacena y gestiona todos los tools registrados:

```typescript
class ToolRegistry {
    register(tool: BaseTool): void;
    registerAll(tools: BaseTool[]): void;
    getTool(name: string): BaseTool | undefined;
    execute(name: string, params, context): Promise<ToolResult>;
    getDefinitions(): ToolDefinition[];
    getToolNames(): string[];
    buildToolsPrompt(): string;   // Genera descripción de tools para LLM
    parseToolCalls(text): ToolCall[];  // Extrae tool calls del output del LLM
}
```

### Tools Deterministas (sin LLM)

| Tool | Nombre | Parámetros | Función |
|---|---|---|---|
| `ListSourceFilesTool` | `list_source_files` | `directory` | Busca archivos `.ts/.tsx/.js/.jsx` en el workspace |
| `ReadFileTool` | `read_file` | `filePath` | Lee contenido de un archivo |
| `WriteFileTool` | `write_file` | `filePath`, `content` | Escribe archivo a disco |
| `RunTestTool` | `run_test` | `testFilePath`, `workspaceRoot` | Ejecuta Jest sobre un archivo de test |
| `AnalyzeProjectTool` | `analyze_project` | `workspaceRoot` | Ejecuta `StackDiscoveryService.discover()` |
| `CollectContextTool` | `collect_context` | `sourceFilePath`, `workspaceRoot` | Recopila imports, tipos y contexto de dependencias |

### Tools Inteligentes (usan LLM internamente)

| Tool | Nombre | Parámetros | Función |
|---|---|---|---|
| `GenerateTestTool` | `generate_test` | `sourceFilePath`, `sourceCode`, `context` | Genera test usando LLM con contexto completo |
| `FixTestTool` | `fix_test` | `testCode`, `errorOutput`, `sourceCode` | Corrige test fallido usando LLM con output de error |

---

## LLMOrchestrator — Loop Agéntico

**Archivo:** `orchestrator/LLMOrchestrator.ts`

### Modo libre: `execute()`

El LLM tiene autonomía total para elegir qué tools llamar y en qué orden:

```
execute(userRequest, context, stream):
    1. CONSTRUIR system prompt con:
       - Definiciones de todos los tools (nombre, descripción, parámetros)
       - Instrucciones de formato (JSON en code blocks)
       - Regla de terminación ("responde DONE cuando termines")

    2. INICIAR conversation history = [system, user(request)]

    3. LOOP (max 10 iteraciones):
       a. ENVIAR historial completo al LLM
       b. RECIBIR respuesta del LLM (streaming)

       c. SI respuesta contiene "DONE":
            → Extraer resultado final
            → RETORNAR

       d. SI respuesta contiene tool calls (JSON):
            → PARSEAR tool calls [{tool, parameters}]
            → PARA CADA tool call:
                 resultado = toolRegistry.execute(tool, params, context)
                 AGREGAR {role: "tool", result} al historial

       e. SI no hay tool calls ni DONE:
            → AGREGAR respuesta como {role: "assistant"}
            → Continuar loop

    4. SI max iteraciones alcanzadas:
       → RETORNAR último resultado disponible
```

### Modo dirigido: `executeGenerateAndHeal()`

Workflow predefinido para generación + auto-reparación:

```
executeGenerateAndHeal(sourceFilePath, workspaceRoot, stream, token):
    1. COLLECT CONTEXT:
       → CollectContextTool.execute({sourceFilePath, workspaceRoot})
       → Obtener imports, tipos, interfaces del archivo fuente

    2. READ SOURCE:
       → ReadFileTool.execute({filePath: sourceFilePath})

    3. GENERATE TEST:
       → GenerateTestTool.execute({sourceFilePath, sourceCode, context})

    4. WRITE TEST:
       → WriteFileTool.execute({filePath: testPath, content: testCode})

    5. RUN TEST:
       → RunTestTool.execute({testFilePath: testPath, workspaceRoot})

    6. SI test falla Y intentos < maxHealingAttempts:
       → FixTestTool.execute({testCode, errorOutput, sourceCode})
       → ESCRIBIR test corregido
       → VOLVER al paso 5

    7. RETORNAR ruta del test generado
```

---

## Flujo del Chat Handler Principal

**Archivo:** `ChatHandlers.ts`

```
handleChatRequest(request, context, stream, token):
    1. EXTRAER targetPath:
       - Desde referencias adjuntas (#file) en el request
       - O desde el texto del prompt (si contiene ruta)

    2. ENRUTAR por request.command:
       CASO 'setup':
           → handleSetupRequest(stream, token)
       CASO 'install':
           → handleInstallRequest(stream, token, installCommand?)
       CASO 'generate-all':
           → handleGenerateAllRequest(stream, token, stateService, targetPath, orchestrator)
       CASO default (sin comando / 'generate'):
           → handleGenerateSingleRequest(stream, token, stateService, orchestrator)

    3. CATCH errores:
       → handleError(error, stream)
```

---

## Comando /setup

**Handler:** `handleSetupRequest(stream, token)`

```
1. VERIFICAR workspace abierto

2. BUSCAR proyectos con package.json en todos los workspace folders

3. SI no hay proyectos:
   → Mostrar error + sugerencia "File > Open Folder"

4. SI múltiples proyectos:
   → Listar proyectos encontrados con estado Jest

5. SELECCIONAR proyecto (primero por defecto)

6. VERIFICAR estado de Jest (ProjectSetupService.checkProjectSetup):
   → ¿Tiene jest instalado?
   → ¿Tiene jest.config?
   → ¿Tiene scripts de test?

7. SI Jest ya configurado:
   → Mostrar estado actual
   → Sugerir mejoras si procede

8. SI faltan componentes:
   → ProjectSetupService.setupProject(workspaceRoot):
     a. Instalar dependencias (LLM detecta cuáles)
     b. Generar jest.config.js (LLM personaliza según proyecto)
     c. Actualizar package.json scripts
     d. Crear mocks necesarios

9. EJECUTAR smoke test (environment-agnostic):
   → expect(1+1).toBe(2)
   → SI proyecto usa jsdom: verificar también entorno jsdom

10. MOSTRAR resumen al usuario
```

---

## Comando /install

**Handler:** `handleInstallRequest(stream, token, installCommand?, maxRetries=3)`

Incluye un **loop de auto-reparación** donde el LLM diagnostica errores de instalación:

```
1. VERIFICAR workspace

2. VERIFICAR estado de Jest

3. SI no hay comando explícito:
   → Detectar dependencias faltantes via DependencyDetectionService
   → Construir comando npm install

4. EJECUTAR comando de instalación (spawn npm)

5. SI instalación falla:
   → CAPTURAR error output completo

   LOOP de auto-healing (max 3 intentos):
     a. LLM analiza error npm (analyzeAndFixError)
     b. LLM sugiere comando alternativo
     c. Mostrar diagnóstico al usuario
     d. Ofrecer botón para reintentar con comando sugerido
     e. SI usuario acepta → ejecutar nuevo comando
     f. SI falla de nuevo → repetir análisis

6. SI todas las tentativas fallan:
   → Mostrar error detallado con sugerencias manuales

7. EJECUTAR smoke test para validar
```

---

## Comando /generate

**Handler:** `handleGenerateSingleRequest(stream, token, stateService, orchestrator?)`

```
1. VERIFICAR editor activo:
   → SI no hay archivo abierto: mostrar instrucciones de uso

2. VALIDAR archivo:
   → Extensión soportada (.ts, .tsx, .js, .jsx)
   → No es un archivo de test (.test., .spec.)

3. OBTENER workspace root

4. VERIFICAR entorno Jest (ensureJestEnvironment):
   → SI Jest no está configurado: ejecutar flow de /setup

5. MOSTRAR encabezado: "Generando Tests para {fileName}"

6. SI orchestrator disponible:
   → orchestrator.executeGenerateAndHeal(sourceFilePath, workspaceRoot, stream, token)
   → El orchestrator maneja todo el ciclo: contexto → generar → escribir → ejecutar → reparar

7. SI NO hay orchestrator (fallback):
   → Crear TestAgent con LLMProviderFactory
   → TestAgent.generateAndHealTest(sourceFilePath, workspaceRoot, stream, token)
   → TestAgent maneja el ciclo clásico

8. MOSTRAR resultado:
   → ✅ Test generado exitosamente con ruta del archivo
   → O ⚠️ Test generado pero con fallos después de N intentos

9. REGISTRAR telemetría y abrir archivo de test en editor
```

---

## Comando /generate-all

**Handler:** `handleGenerateAllRequest(stream, token, stateService, targetPath?, orchestrator?)`

```
1. VERIFICAR workspace

2. ESCANEAR archivos fuente:
   → FileScanner.findSourceFiles() para cada workspace folder
   → .ts, .tsx, .js, .jsx (excluyendo node_modules, dist, etc.)

3. FILTRAR archivos sin tests:
   → FileScanner.filterFilesWithoutTests()

4. SI todos tienen tests:
   → Mostrar "✅ ¡Todos los archivos ya tienen tests!"

5. AGRUPAR por proyecto:
   → FileScanner.groupFilesByProject()

6. VERIFICAR entorno Jest del primer proyecto

7. 🧠 PLANIFICACIÓN LLM (planBatchGeneration):
   → LLM analiza lista de archivos, estructura del proyecto, tipos de archivo
   → LLM retorna BatchGenerationPlan:
     - Grupos priorizados (servicios core → componentes → utilidades)
     - Razón de cada grupo
     - Tiempo estimado
     - Concurrencia recomendada
   → Mostrar plan al usuario (top 3 grupos)

8. REORDENAR archivos según plan del LLM

9. PROCESAR archivos secuencialmente:
   PARA CADA archivo:
     a. Verificar cancelación (token)
     b. Mostrar progreso (N/total)
     c. SI orchestrator disponible:
          → orchestrator.executeGenerateAndHeal(file, root, stream, token)
        SI NO:
          → TestAgent.generateAndHealTest(file, root, stream, token)
     d. Rate limit: esperar entre archivos
     e. Registrar éxito/fallo

10. MOSTRAR resumen batch:
    → ✅ N tests generados exitosamente
    → ⚠️ N tests con fallos
    → Tiempo total
```

---

## Detección Inteligente de Dependencias (3 capas)

**Servicio:** `DependencyDetectionService`

El sistema de detección de dependencias usa 3 capas de inteligencia:

```
getCompatibleDependencies(projectRoot):
    ┌─────────────────────────────────────────┐
    │ Capa 1: StackDiscoveryService           │
    │ (determinista)                          │
    │                                         │
    │ → Lee package.json, tsconfig.json       │
    │ → Detecta: framework, uiLibrary,        │
    │   testRunner, packageManager,            │
    │   moduleSystem, reactVersion, etc.       │
    │ → Resultado: ProjectStack               │
    └─────────────────┬───────────────────────┘
                      ▼
    ┌─────────────────────────────────────────┐
    │ Capa 2: LLM con contexto enriquecido   │
    │                                         │
    │ → Se inyecta _stackAnalysis en el       │
    │   packageJson enviado al LLM            │
    │ → LLM recibe framework detectado,       │
    │   UI library, etc. como contexto        │
    │ → LLM sugiere dependencias compatibles  │
    │ → 3 reintentos con feedback si falla    │
    └─────────────────┬───────────────────────┘
                      ▼
    ┌─────────────────────────────────────────┐
    │ Capa 3: filterByStack() (guardrail)     │
    │ (determinista)                          │
    │                                         │
    │ → Filtro post-LLM que elimina:          │
    │   - Paquetes React si no hay React      │
    │   - Paquetes browser si no hay DOM      │
    │   - Paquetes de framework incorrecto    │
    │ → Asegura que solo se instalan          │
    │   paquetes relevantes al stack real     │
    └─────────────────────────────────────────┘

    Fallback final: solo jest, @types/jest, ts-jest
```

### StackDiscoveryService

Detecta de forma determinista:

| Campo | Valores posibles |
|---|---|
| `framework` | `spfx`, `react`, `angular`, `vue`, `node`, `vscode-extension`, `next`, `express`, `unknown` |
| `language` | `typescript`, `javascript` |
| `uiLibrary` | `react`, `angular`, `vue`, `svelte`, `none` |
| `componentLibrary` | `@fluentui/react`, `@mui/material`, `antd`, `none`, etc. |
| `testRunner` | `jest`, `vitest`, `mocha`, `jasmine`, `none` |
| `packageManager` | `npm`, `yarn`, `pnpm` |
| `moduleSystem` | `commonjs`, `esm`, `mixed` |

Infiere todo desde: `package.json`, archivos de configuración, lockfiles, y estructura de directorios.

---

## Servicios Auxiliares

### Logger
Singleton con niveles configurables (debug, info, warn, error). Output channel: "Test Agent".

### ConfigService
Lee la configuración de VS Code (`test-agent.*`). Emite eventos `onDidChangeConfiguration`.

### StateService
Persiste estado entre sesiones usando `vscode.ExtensionContext.globalState`.

### TelemetryService
Telemetría anónima opcional. Registra ejecuciones de comandos, tiempos, éxitos/fallos.

### CacheService
Cache de respuestas LLM. Reduce llamadas repetidas para el mismo input.

### QueueService
Gestiona cola de generación batch. Controla concurrencia y rate limiting.

### CoverageService
Parsea reportes de cobertura de Jest. Usado para iterar sobre archivos con baja cobertura.

### DependencyGraphService
Construye grafos de importación/dependencia. Usado para priorización batch.

### PackageInstallationService
Ejecuta comandos `npm install` / `yarn add` / `pnpm add` con captura de output.

### JestConfigurationService
Genera `jest.config.js` personalizado. Usa LLM para adaptar configuración al proyecto.

### ProjectSetupService
Orquesta el flow completo de `/setup`: instalación + configuración + smoke test.

---

## Llamadas Reales al LLM

Todas las interacciones con el LLM son llamadas reales a través de la API `vscode.lm`:

### Vía LLMOrchestrator (tool calling)
| Operación | Descripción |
|---|---|
| System prompt + user request | El orchestrator envía definiciones de tools + request al LLM |
| Tool result feedback | Después de ejecutar un tool, el resultado se devuelve al LLM |
| Iteración hasta DONE | El LLM decide autónomamente cuándo ha terminado |

### Vía ILLMProvider (métodos directos)
| Método | Llamada LLM | Propósito |
|---|---|---|
| `generateTest()` | ✅ Real | Generar código de test |
| `fixTest()` | ✅ Real | Corregir test con error context |
| `planTestStrategy()` | ✅ Real | Planificar enfoque de testing |
| `generateJestConfig()` | ✅ Real | Generar configuración Jest personalizada |
| `detectDependencies()` | ✅ Real | Detectar versiones de dependencias compatibles |
| `planBatchGeneration()` | ✅ Real | Priorizar archivos para generación batch |
| `validateAndFixVersions()` | ✅ Real | Corregir versiones npm inválidas |
| `analyzeAndFixError()` | ✅ Real | Diagnosticar errores de instalación npm |
| `sendPrompt()` | ✅ Real | Prompt genérico (interfaz ICoreProvider) |

### Formato de Respuesta
El LLM responde con tool calls embebidos en bloques de código JSON:

````markdown
Voy a analizar el proyecto primero.

```json
{"tool": "analyze_project", "parameters": {"workspaceRoot": "/path/to/project"}}
```
````

El `ToolRegistry.parseToolCalls()` extrae estos JSON del output del LLM.

---

## Resumen de Componentes

| Componente | Archivo | Responsabilidad |
|---|---|---|
| Entry Point | `extension.ts` | Activación, registro, inicialización de orchestrator |
| Chat Router | `ChatHandlers.ts` | Enrutamiento de comandos a handlers |
| Orchestrator | `orchestrator/LLMOrchestrator.ts` | Loop agéntico con tool calling |
| Factory | `orchestrator/OrchestratorFactory.ts` | Creación de ToolRegistry con 8 tools |
| Base Tool | `tools/BaseTool.ts` | Clase abstracta para todos los tools |
| Registry | `tools/ToolRegistry.ts` | Almacenamiento y ejecución de tools |
| Types | `tools/ToolTypes.ts` | Tipos core del sistema de tools |
| Deterministic | `tools/deterministic/*.ts` | 6 tools sin LLM |
| Intelligent | `tools/intelligent/*.ts` | 2 tools con LLM |
| Copilot | `providers/CopilotProvider.ts` | Proveedor via `vscode.lm` API |
| Azure OpenAI | `providers/AzureOpenAIProvider.ts` | Proveedor via `@azure/openai` SDK |
| Test Agent | `agent/TestAgent.ts` | Agente clásico de generación (fallback) |
| Code Agent | `agent/CodeAssistantAgent.ts` | Orquestador genérico de capabilities |
| Stack | `services/StackDiscoveryService.ts` | Detección determinista del stack del proyecto |
| Dependencies | `services/DependencyDetectionService.ts` | Detección LLM-first con 3 capas |
