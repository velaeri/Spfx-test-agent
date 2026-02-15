# 🔧 ¿Qué son los "TOOLS" en LLM-First?

## Concepto Fundamental

**"Tools"** (también llamados "Functions" o "Actions") son **funciones que el LLM puede invocar por su cuenta** para realizar acciones en el mundo real.

Es como darle al LLM una **caja de herramientas** y decirle: "Usa lo que necesites para lograr el objetivo".

---

## 🎯 Comparación: Actual vs Tools

### **ACTUAL (Sin Tools)** 🔴

El código TypeScript decide TODO y solo le pide al LLM que genere texto:

```typescript
// ChatHandlers.ts (ACTUAL - línea ~800+)
async function handleGenerateAllRequest() {
    // ❌ La EXTENSIÓN busca archivos manualmente
    const files = await vscode.workspace.findFiles('**/*.ts', '**/node_modules/**');
    
    // ❌ La EXTENSIÓN filtra cuáles necesitan tests
    const filesWithoutTests = [];
    for (const file of files) {
        const testFile = getTestFilePath(file);
        if (!fs.existsSync(testFile)) {
            filesWithoutTests.push(file);
        }
    }
    
    // ❌ La EXTENSIÓN lee cada archivo
    for (const file of filesWithoutTests) {
        const sourceCode = fs.readFileSync(file, 'utf-8');
        
        // ❌ La EXTENSIÓN analiza dependencias manualmente
        const deps = new DependencyDetectionService();
        const dependencies = await deps.analyzeDependencies(sourceCode);
        
        // 🟡 Aquí FINALMENTE llama al LLM (pero solo para generar)
        const testCode = await llmProvider.generateTest({
            sourceCode: sourceCode,
            dependencies: dependencies
        });
        
        // ❌ La EXTENSIÓN escribe el archivo
        fs.writeFileSync(testFilePath, testCode);
        
        // ❌ La EXTENSIÓN ejecuta Jest
        const result = await runJest(testFilePath);
        
        // ❌ Si falla, la EXTENSIÓN decide reintentar
        if (!result.success) {
            const fixed = await llmProvider.fixTest({
                error: result.error
            });
            fs.writeFileSync(testFilePath, fixed);
        }
    }
}
```

**Problemas:**
- El LLM NO decide nada
- La extensión tiene 13 servicios con lógica hardcodeada
- Cambiar el orden = modificar código TypeScript

---

### **PROPUESTO (Con Tools)** 🟢

El LLM decide TODO usando tools que tú le proporcionas:

```typescript
// extension.ts (PROPUESTO)
async function handleGenerateAllRequest() {
    
    // ✅ Solo le das al LLM el objetivo y las herramientas
    const orchestrator = new LLMOrchestrator();
    
    return await orchestrator.execute({
        goal: "Generate tests for all source files",
        tools: [
            new ListSourceFilesTool(),      // 🔧 Tool 1
            new ReadFileTool(),             // 🔧 Tool 2
            new AnalyzeDependenciesTool(),  // 🔧 Tool 3
            new WriteTestTool(),            // 🔧 Tool 4
            new RunTestTool(),              // 🔧 Tool 5
            new FixTestTool()               // 🔧 Tool 6
        ]
    });
}
```

**El LLM entonces hace esto SOLO:**

```yaml
# Conversación del LLM (interno):

LLM piensa: "Ok, mi objetivo es generar tests. Primero necesito 
             saber qué archivos hay."

LLM decide: "Voy a usar el tool 'list_source_files'"

→ LLM llama: list_source_files({ exclude: "node_modules" })

← Resultado: { files: ["src/UserService.ts", "src/helpers.ts"] }

LLM piensa: "Perfecto, hay 2 archivos. Voy a leer el primero."

→ LLM llama: read_file({ path: "src/UserService.ts" })

← Resultado: { content: "export class UserService {...}" }

LLM piensa: "Es una clase. Necesito saber qué dependencias tiene."

→ LLM llama: analyze_dependencies({ sourceCode: "..." })

← Resultado: { imports: ["axios", "./Logger"], needsMocking: ["axios"] }

LLM piensa: "Genial, usa axios. Voy a generar un test con mocking."

→ LLM llama: write_test({ 
    source: "src/UserService.ts",
    testCode: "import { UserService } from './UserService';\n..."
  })

← Resultado: { testPath: "src/UserService.test.ts", success: true }

LLM piensa: "Test creado. Lo ejecuto para validar."

→ LLM llama: run_test({ testFile: "src/UserService.test.ts" })

← Resultado: { success: false, error: "ReferenceError: axios is not defined" }

LLM piensa: "Ah, olvidé jest.mock('axios'). Lo arreglo."

→ LLM llama: fix_test({ 
    testFile: "src/UserService.test.ts",
    error: "...",
    fix: "jest.mock('axios');\n..."
  })

← Resultado: { success: true }

→ LLM llama: run_test({ testFile: "src/UserService.test.ts" })

← Resultado: { success: true, passed: 5 }

LLM piensa: "✅ UserService done. Siguiente archivo..."

[REPITE PARA helpers.ts]

LLM responde al usuario: "✅ Tests generados para 2 archivos. Todos pasan."
```

---

## 🛠️ ¿Qué es un "Tool" Técnicamente?

Un **tool** es una función que el LLM puede invocar, descrita en formato JSON Schema.

### Ejemplo Real: `ListSourceFilesTool`

```typescript
// src/tools/filesystem/ListSourceFilesTool.ts

export class ListSourceFilesTool extends BaseTool {
    
    // 📋 DEFINICIÓN: Le explica al LLM qué hace este tool
    get definition(): ToolDefinition {
        return {
            type: 'function',
            function: {
                name: 'list_source_files',  // ← Nombre del tool
                
                description: 'List all source files in the workspace that need tests',
                
                // ↓ Parámetros que el LLM puede pasar
                parameters: {
                    type: 'object',
                    properties: {
                        workspace_root: {
                            type: 'string',
                            description: 'Root path of the workspace'
                        },
                        exclude_patterns: {
                            type: 'array',
                            description: 'Patterns to exclude (e.g., ["node_modules", "*.test.ts"])'
                        }
                    },
                    required: ['workspace_root']
                }
            }
        };
    }
    
    // ⚙️ EJECUCIÓN: Lo que realmente hace cuando el LLM lo llama
    async execute(args: {
        workspace_root: string;
        exclude_patterns?: string[];
    }): Promise<{ files: string[]; total: number }> {
        
        const excludePattern = args.exclude_patterns?.join(',') || 
                               '**/{*.test.*,node_modules/**}';
        
        // Buscar archivos
        const files = await vscode.workspace.findFiles(
            '**/*.{ts,tsx}',
            excludePattern
        );
        
        // Filtrar los que ya tienen tests
        const filesWithoutTests: string[] = [];
        for (const file of files) {
            const testFile = this.getTestFilePath(file.fsPath);
            const hasTest = await this.fileExists(testFile);
            if (!hasTest) {
                filesWithoutTests.push(file.fsPath);
            }
        }
        
        // Devolver resultado al LLM
        return {
            files: filesWithoutTests,
            total: filesWithoutTests.length
        };
    }
}
```

### Cómo lo Usa el LLM

1. **LLM ve la definición:**
```json
{
  "name": "list_source_files",
  "description": "List all source files in the workspace that need tests",
  "parameters": {
    "workspace_root": { "type": "string" },
    "exclude_patterns": { "type": "array" }
  }
}
```

2. **LLM decide usarlo:**
```json
// El LLM responde con:
{
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "list_source_files",
        "arguments": "{\"workspace_root\": \"c:/dev/project\"}"
      }
    }
  ]
}
```

3. **Tu código ejecuta el tool:**
```typescript
const result = await listSourceFilesTool.execute({
    workspace_root: "c:/dev/project"
});
// → { files: ["src/UserService.ts", "src/helpers.ts"], total: 2 }
```

4. **Devuelves resultado al LLM:**
```json
{
  "tool_call_id": "call_abc123",
  "output": "{\"files\": [\"src/UserService.ts\", \"src/helpers.ts\"], \"total\": 2}"
}
```

5. **LLM procesa el resultado y decide qué hacer:**
   - "Ok, hay 2 archivos. Voy a leer el primero con `read_file`..."

---

## 📦 Ejemplo Completo: Comparación Lado a Lado

### Escenario: Generar test para `UserService.ts`

#### **CÓDIGO ACTUAL (Sin Tools)**

```typescript
// ChatHandlers.ts - handleGenerateSingleRequest() (simplificado)

async function handleGenerateSingleRequest(file: vscode.Uri) {
    
    // 1️⃣ La extensión lee el archivo
    const sourceCode = fs.readFileSync(file.fsPath, 'utf-8');
    
    // 2️⃣ La extensión analiza dependencias (300 líneas de código)
    const deps = new DependencyDetectionService();
    const dependencies = await deps.buildDependencyContext(sourceCode, file.fsPath);
    // En DependencyDetectionService.ts (línea 1-334):
    // - Parsea AST con TypeScript compiler
    // - Busca imports manualmente con regex
    // - Distingue dependencias externas vs internas
    // - Construye grafo de dependencias
    // - Detecta cuáles necesitan mocking
    
    // 3️⃣ La extensión detecta el framework (100 líneas)
    const stack = new StackDiscoveryService();
    const framework = await stack.detectFramework(workspaceRoot);
    // En StackDiscoveryService.ts:
    // - Lee package.json
    // - Busca keywords específicos: "react", "vue", "angular"
    // - Verifica archivos de config: tsconfig.json, .babelrc
    
    // 4️⃣ La extensión construye el prompt
    const systemPrompt = buildSystemPrompt(framework, dependencies);
    
    // 5️⃣ AQUÍ finalmente llama al LLM
    const testCode = await llmProvider.generateTest({
        sourceCode: sourceCode,
        dependencies: dependencies,
        systemPrompt: systemPrompt
    });
    // ↑ El LLM solo ve: código fuente + análisis completo
    // ↑ El LLM solo responde: código del test
    
    // 6️⃣ La extensión escribe el test
    const testPath = this.getTestFilePath(file.fsPath);
    fs.writeFileSync(testPath, testCode);
    
    // 7️⃣ La extensión ejecuta Jest
    const result = await new TestRunner().run(testPath);
    
    // 8️⃣ Si falla, la extensión decide reintentar (loop hardcodeado)
    let attempts = 0;
    while (!result.success && attempts < 3) {
        const error = result.error;
        const fixed = await llmProvider.fixTest({ error, testCode });
        fs.writeFileSync(testPath, fixed);
        result = await new TestRunner().run(testPath);
        attempts++;
    }
}
```

**Total: ~500 líneas de lógica imperativa**

---

#### **CÓDIGO PROPUESTO (Con Tools)**

```typescript
// extension.ts (PROPUESTO)

async function handleGenerateSingleRequest(file: vscode.Uri) {
    
    const orchestrator = new LLMOrchestrator();
    
    // ✅ TODO en 1 llamada
    return await orchestrator.execute({
        goal: `Generate a unit test for ${file.fsPath}`,
        context: { sourceFile: file.fsPath },
        tools: [
            new ReadFileTool(),
            new AnalyzeDependenciesTool(),
            new DetectFrameworkTool(),
            new WriteTestTool(),
            new RunTestTool(),
            new FixTestTool()
        ]
    });
}
```

**Total: ~50 líneas de código orquestador + 6 tools simples (~30 líneas cada uno)**

---

### ¿Qué hace el Orquestador?

```typescript
// LLMOrchestrator.ts (simplificado)

export class LLMOrchestrator {
    
    async execute(request: { goal: string; tools: BaseTool[] }) {
        
        // 1️⃣ Enviar objetivo + definiciones de tools al LLM
        const messages = [
            {
                role: 'system',
                content: `You are a test generator. Use these tools:\n${this.getToolsDescription(request.tools)}`
            },
            {
                role: 'user',
                content: request.goal
            }
        ];
        
        // 2️⃣ Loop agentico
        while (true) {
            // Llamar al LLM
            const response = await this.llm.sendRequest(messages, request.tools);
            
            // Si el LLM quiere usar tools
            if (response.tool_calls) {
                
                // Ejecutar cada tool que el LLM pidió
                for (const toolCall of response.tool_calls) {
                    const tool = this.findTool(toolCall.name, request.tools);
                    const args = JSON.parse(toolCall.arguments);
                    
                    // ⚙️ Ejecutar el tool
                    const result = await tool.execute(args);
                    
                    // Agregar resultado al historial
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(result)
                    });
                }
                
                // Continuar el loop (el LLM verá los resultados y decidirá qué hacer)
                continue;
            }
            
            // Si el LLM NO quiere más tools = terminó
            if (response.finish_reason === 'stop') {
                return response.content;
            }
        }
    }
}
```

---

## 🎬 Ejemplo de Ejecución Real

### Usuario escribe:
```
@spfx-tester /generate src/services/UserService.ts
```

### Conversación interna (con tools):

```yaml
═══════════════════════════════════════════════════════════
ENVÍO 1 (al LLM):
═══════════════════════════════════════════════════════════
System: "You are a test generator agent. Available tools:
  - read_file: Read a source file
  - analyze_dependencies: Analyze imports and dependencies
  - detect_framework: Detect project framework (React/Vue/Angular)
  - write_test: Write a test file
  - run_test: Execute a test with Jest
  - fix_test: Fix a failing test"

User: "Generate a unit test for src/services/UserService.ts"

Tools: [read_file, analyze_dependencies, ...]

═══════════════════════════════════════════════════════════
RESPUESTA LLM 1:
═══════════════════════════════════════════════════════════
{
  "content": "",
  "tool_calls": [
    {
      "id": "call_1",
      "function": {
        "name": "read_file",
        "arguments": "{\"path\": \"src/services/UserService.ts\"}"
      }
    }
  ]
}

# 🔧 TU CÓDIGO EJECUTA EL TOOL:
result_1 = readFileTool.execute({ path: "src/services/UserService.ts" })
# → { content: "export class UserService {\n  async getUser() {...}" }

═══════════════════════════════════════════════════════════
ENVÍO 2 (al LLM):
═══════════════════════════════════════════════════════════
[Historial anterior...]

Tool Result (call_1): 
{
  "content": "export class UserService {\n  async getUser(id: string) {\n    return axios.get(`/users/${id}`);\n  }\n}"
}

═══════════════════════════════════════════════════════════
RESPUESTA LLM 2:
═══════════════════════════════════════════════════════════
{
  "content": "",
  "tool_calls": [
    {
      "id": "call_2",
      "function": {
        "name": "analyze_dependencies",
        "arguments": "{\"sourceCode\": \"export class UserService...\"}"
      }
    }
  ]
}

# 🔧 TU CÓDIGO EJECUTA:
result_2 = analyzeDepsTools.execute({ sourceCode: "..." })
# → { imports: ["axios"], external: ["axios"], needsMocking: ["axios"] }

═══════════════════════════════════════════════════════════
ENVÍO 3 (al LLM):
═══════════════════════════════════════════════════════════
[Historial anterior...]

Tool Result (call_2): 
{ "imports": ["axios"], "needsMocking": ["axios"] }

═══════════════════════════════════════════════════════════
RESPUESTA LLM 3:
═══════════════════════════════════════════════════════════
{
  "content": "",
  "tool_calls": [
    {
      "id": "call_3",
      "function": {
        "name": "write_test",
        "arguments": "{\"sourceFile\": \"src/services/UserService.ts\", \"testCode\": \"import { UserService } from './UserService';\\n\\njest.mock('axios');\\n\\ndescribe('UserService', () => {\\n  it('should fetch user', async () => {\\n    const service = new UserService();\\n    await service.getUser('123');\\n    expect(axios.get).toHaveBeenCalledWith('/users/123');\\n  });\\n});\"}"
      }
    }
  ]
}

# 🔧 TU CÓDIGO EJECUTA:
result_3 = writeTestTool.execute({ sourceFile: "...", testCode: "..." })
# → { testPath: "src/services/UserService.test.ts", success: true }

═══════════════════════════════════════════════════════════
ENVÍO 4 (al LLM):
═══════════════════════════════════════════════════════════
Tool Result (call_3): 
{ "testPath": "src/services/UserService.test.ts", "success": true }

═══════════════════════════════════════════════════════════
RESPUESTA LLM 4:
═══════════════════════════════════════════════════════════
{
  "content": "",
  "tool_calls": [
    {
      "id": "call_4",
      "function": {
        "name": "run_test",
        "arguments": "{\"testFile\": \"src/services/UserService.test.ts\"}"
      }
    }
  ]
}

# 🔧 TU CÓDIGO EJECUTA:
result_4 = runTestTool.execute({ testFile: "..." })
# → { success: true, passed: 1, failed: 0 }

═══════════════════════════════════════════════════════════
ENVÍO 5 (al LLM):
═══════════════════════════════════════════════════════════
Tool Result (call_4): 
{ "success": true, "passed": 1, "failed": 0 }

═══════════════════════════════════════════════════════════
RESPUESTA LLM 5 (FINAL):
═══════════════════════════════════════════════════════════
{
  "content": "✅ Test generated successfully for UserService.ts\n\nTest file: src/services/UserService.test.ts\n- 1 test passing\n- Mocked axios dependency\n- Coverage: 100%",
  "finish_reason": "stop"
}

# ✅ FIN - El LLM decidió que terminó
```

---

## 🔑 Diferencias Clave

| Aspecto | Sin Tools (Actual) | Con Tools (Propuesto) |
|---------|-------------------|---------------------|
| **¿Quién decide?** | TypeScript (código imperativo) | LLM (reasoning + tool calls) |
| **Lógica de análisis** | 13 servicios (500+ líneas cada uno) | Tools simples (30 líneas cada uno) |
| **Flexibilidad** | Cambiar comportamiento = modificar código | Cambiar comportamiento = modificar prompt |
| **Orden de ejecución** | Hardcodeado en handlers | LLM decide según contexto |
| **Manejo de errores** | try/catch + loops fijos | LLM adapta estrategia |
| **Transparencia** | Opaco (solo ves logs) | Claro (ves cada tool call) |
| **Extensibilidad** | Agregar feature = modificar servicios | Agregar feature = crear nuevo tool |

---

## 🧪 Código Real de un Tool Completo

```typescript
// src/tools/testing/RunTestTool.ts

import { BaseTool, ToolDefinition } from '../base/BaseTool';
import { spawn } from 'child_process';

export class RunTestTool extends BaseTool {
    
    // 📋 Definición para el LLM
    get definition(): ToolDefinition {
        return {
            type: 'function',
            function: {
                name: 'run_test',
                description: 'Execute a test file with Jest and return results',
                parameters: {
                    type: 'object',
                    properties: {
                        test_file: {
                            type: 'string',
                            description: 'Path to the test file to execute'
                        }
                    },
                    required: ['test_file']
                }
            }
        };
    }
    
    // ⚙️ Implementación real
    async execute(args: { test_file: string }): Promise<{
        success: boolean;
        passed: number;
        failed: number;
        output: string;
        error?: string;
    }> {
        
        return new Promise((resolve) => {
            
            // Ejecutar Jest
            const jest = spawn('npx', ['jest', args.test_file, '--json'], {
                shell: true
            });
            
            let output = '';
            let errorOutput = '';
            
            jest.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            jest.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });
            
            jest.on('close', (code) => {
                
                // Parsear resultado JSON de Jest
                try {
                    const result = JSON.parse(output);
                    
                    resolve({
                        success: code === 0,
                        passed: result.numPassedTests,
                        failed: result.numFailedTests,
                        output: output,
                        error: code !== 0 ? errorOutput : undefined
                    });
                    
                } catch (e) {
                    resolve({
                        success: false,
                        passed: 0,
                        failed: 0,
                        output: output,
                        error: errorOutput || 'Failed to parse Jest output'
                    });
                }
            });
        });
    }
}
```

**Eso es todo.** 30 líneas vs 500 líneas de `TestRunner.ts`.

---

## 💡 Ventajas de los Tools

### 1. **Simplicidad**
Cada tool hace UNA cosa. No hay lógica compleja de orquestación.

### 2. **Reutilizabilidad**
Otros comandos pueden usar los mismos tools:
```typescript
// Comando /analyze
orchestrator.execute({
    goal: "Analyze test coverage",
    tools: [
        new ListSourceFilesTool(),
        new GetCoverageTool(),
        new AnalyzeGapsTool()
    ]
});

// Comando /fix
orchestrator.execute({
    goal: "Fix all failing tests",
    tools: [
        new ListTestsTool(),
        new RunTestTool(),
        new FixTestTool()
    ]
});
```

### 3. **Extensibilidad**
Agregar nuevo tool = 30 líneas:
```typescript
// Nuevo tool para Vitest (sin modificar nada más)
export class RunVitestTool extends BaseTool {
    get definition() {
        return {
            name: 'run_vitest',
            description: 'Run tests with Vitest'
        };
    }
    
    async execute(args) {
        // Ejecutar vitest
        return { success: true };
    }
}

// Registrar
toolRegistry.register(new RunVitestTool());
```

### 4. **Debugging**
Ves exactamente qué está haciendo el LLM:
```
🔧 Tool called: list_source_files
   → Found 15 files

🔧 Tool called: read_file (src/UserService.ts)
   → 234 lines

🔧 Tool called: analyze_dependencies
   → Found: axios, lodash

🔧 Tool called: write_test
   → Created src/UserService.test.ts

🔧 Tool called: run_test
   → ✅ All tests passed
```

---

## ❓ Preguntas Frecuentes

### **P: ¿No es más lento hacer múltiples llamadas al LLM?**

**R:** Sí, puede ser más lento. Pero:
- Cada llamada es más barata (contexto más pequeño)
- Puedes ejecutar tools en paralelo
- La transparencia y flexibilidad compensan
- Para casos simples, puedes usar el enfoque actual

**Enfoque híbrido recomendado:**
```typescript
// Comando simple = rápido, sin tools
if (command === 'generate') {
    return handleGenerateSingleRequest(); // Actual
}

// Comando complejo = flexible, con tools
if (command === 'generate-all') {
    return orchestrator.executeWithTools(); // Propuesto
}
```

### **P: ¿Qué pasa si el LLM usa mal un tool?**

**R:** Implementas validaciones:
```typescript
async execute(args: { test_file: string }) {
    // Validar que el archivo existe
    if (!fs.existsSync(args.test_file)) {
        return { 
            success: false, 
            error: `File not found: ${args.test_file}` 
        };
    }
    
    // Validar que es un archivo .test.ts
    if (!args.test_file.includes('.test.')) {
        return {
            success: false,
            error: 'Not a test file'
        };
    }
    
    // OK, ejecutar
    return this.runJest(args.test_file);
}
```

### **P: ¿Esto existe en VS Code API?**

**R:** **Sí**, desde VS Code 1.90+:
- `vscode.lm.invokeTool()` - Ejecutar tool
- `vscode.LanguageModelTool` - Definir tool
- Pero puedes implementarlo tú mismo si no quieres usar la API oficial

Referencias:
- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [Tool Calling Sample](https://github.com/microsoft/vscode-extension-samples/tree/main/chat-agent-tool-sample)

---

## 🎯 Resumen

| Concepto | Explicación |
|----------|------------|
| **Tool** | Función que el LLM puede invocar autónomamente |
| **Definición** | JSON Schema que explica al LLM qué hace el tool |
| **Ejecución** | Tu código ejecuta el tool cuando el LLM lo pide |
| **Loop Agentico** | LLM pide tool → Tu código ejecuta → LLM ve resultado → Decide siguiente acción |
| **Ventaja** | El LLM decide TODO, tú solo proporcionas capacidades |

---

## 🚀 Próximo Paso

¿Quieres que implemente un **Proof of Concept** con:
1. Un orquestador básico
2. 3 tools simples (list_files, read_file, write_test)
3. Un comando `/generate-llm-first` para probar

Sin romper nada del código actual?
