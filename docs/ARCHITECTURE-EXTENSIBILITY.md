# 🏗️ Análisis de Extensibilidad de Arquitectura

## 📊 Estado Actual (v0.5.3)

### ✅ **LO QUE ESTÁ BIEN DISEÑADO (Reutilizable)**

#### 1. **Provider Pattern + Dependency Injection**
```typescript
// Interface genérica para LLMs
interface ILLMProvider {
    generateTest(...): Promise<LLMResult>;
    fixTest(...): Promise<LLMResult>;
    // ... otros métodos
}

// Factory para cambiar providers fácilmente
LLMProviderFactory.createProvider() → CopilotProvider | AzureOpenAIProvider
```

**✅ Ventaja:** Fácil agregar nuevos LLM providers (Anthropic Claude, Google Gemini, etc.)

---

#### 2. **Servicios Independientes & Singleton Pattern**
```typescript
Logger.getInstance()           // ✅ Reutilizable para cualquier feature
ConfigService.getInstance()    // ✅ Reutilizable
TelemetryService.getInstance() // ✅ Reutilizable
StateService                   // ✅ Reutilizable
```

**✅ Ventaja:** Infraestructura común lista para nuevas features

---

#### 3. **Error Handling Robusto**
```typescript
CustomErrors:
  - LLMNotAvailableError
  - RateLimitError
  - TestGenerationError
  - FileValidationError
```

**✅ Ventaja:** Sistema de errores extensible para nuevos dominios

---

#### 4. **Arquitectura LLM-First**
```typescript
// Patrón: LLM analiza → decide → ejecuta → valida → reitera
1. Plan strategy     → LLM.planTestStrategy()
2. Execute           → LLM.generateTest()
3. Validate          → Jest execution
4. Fix if needed     → LLM.fixTest()
5. Repeat until pass
```

**✅ Ventaja:** Este patrón funciona para CUALQUIER tarea iterativa con validación

---

### ❌ **LO QUE ESTÁ ACOPLADO AL TESTING**

#### 1. **Interface `ILLMProvider` con Métodos Específicos**
```typescript
interface ILLMProvider {
    // ❌ Nombres acoplados al dominio de testing
    generateTest(context: TestContext): Promise<LLMResult>;
    fixTest(context: TestContext): Promise<LLMResult>;
    planTestStrategy(...): Promise<TestStrategy>;
    detectDependencies(...): Promise<Record<string, string>>;
    generateJestConfig(...): Promise<GeneratedJestConfig>;
    planBatchGeneration(...): Promise<BatchGenerationPlan>;
}
```

**❌ Problema:** Para agregar refactoring o análisis de arquitectura, necesitas modificar esta interface

---

#### 2. **Agent Monolítico**
```typescript
class TestAgent {
    // ❌ Nombre y métodos acoplados a testing
    async generateAndHealTest(...)
    async buildProjectAnalysis(...)
    async findExistingTestPatterns(...)
}
```

**❌ Problema:** Un "ArchitectureAgent" requeriría duplicar toda esta estructura

---

#### 3. **ChatHandlers con Comandos Hardcoded**
```typescript
// ChatHandlers.ts
switch (command) {
    case 'generate': handleGenerateRequest(...);
    case 'generate-all': handleGenerateAllRequest(...);
    case 'install': handleInstallRequest(...);
    case 'setup': handleSetupRequest(...);
    // ❌ Para agregar /refactor o /analyze-architecture hay que tocar este switch
}
```

**❌ Problema:** No hay un sistema de plugins/comandos extensible

---

#### 4. **Servicios Domain-Specific**
```typescript
DependencyDetectionService  // ❌ Solo para Jest dependencies
JestConfigurationService    // ❌ Solo para Jest
ProjectSetupService         // ❌ Solo para test setup
TestRunner                  // ❌ Solo ejecuta Jest
```

**❌ Problema:** No hay abstracciones genéricas reutilizables

---

## 🎯 **PROPUESTA: Arquitectura Extensible con Capabilities**

### **Concepto: Sistema de Capabilities/Plugins**

```typescript
// ================================
// 1. CORE: Generic Agent + LLM
// ================================

/**
 * Generic interface for any LLM capability
 * (Testing, Refactoring, Architecture Analysis, etc.)
 */
interface ILLMCapability<TInput, TOutput> {
    name: string;                    // "test-generation", "code-refactoring"
    description: string;             // Human-readable
    
    /** 
     * Execute the capability with LLM reasoning 
     */
    invoke(
        llm: ICoreProvider,          // NEW: Generic LLM interface
        input: TInput, 
        stream: ChatResponseStream
    ): Promise<TOutput>;
    
    /**
     * Validate if this capability can handle the request
     */
    canHandle(context: any): boolean;
}

/**
 * NEW: Core LLM Provider (only essential methods)
 */
interface ICoreProvider {
    /** Send a prompt and get a response */
    sendPrompt(systemPrompt: string, userPrompt: string): Promise<LLMResult>;
    
    /** Check availability */
    isAvailable(): Promise<boolean>;
    
    /** Get provider name */
    getProviderName(): string;
}

// ================================
// 2. GENERIC AGENT
// ================================

/**
 * Generic agent that orchestrates capabilities
 */
class CodeAssistantAgent {
    private capabilities: Map<string, ILLMCapability<any, any>>;
    private llmProvider: ICoreProvider;
    
    constructor(llmProvider: ICoreProvider) {
        this.llmProvider = llmProvider;
        this.capabilities = new Map();
    }
    
    /**
     * Register a new capability (plugin system)
     */
    registerCapability(capability: ILLMCapability<any, any>): void {
        this.capabilities.set(capability.name, capability);
        Logger.getInstance().info(`Registered capability: ${capability.name}`);
    }
    
    /**
     * Execute a capability by name
     */
    async execute<TInput, TOutput>(
        capabilityName: string, 
        input: TInput,
        stream: ChatResponseStream
    ): Promise<TOutput> {
        const capability = this.capabilities.get(capabilityName);
        if (!capability) {
            throw new Error(`Capability not found: ${capabilityName}`);
        }
        
        return capability.invoke(this.llmProvider, input, stream);
    }
    
    /**
     * Auto-detect which capability to use based on context
     */
    async autoExecute(context: any, stream: ChatResponseStream): Promise<any> {
        for (const capability of this.capabilities.values()) {
            if (capability.canHandle(context)) {
                return capability.invoke(this.llmProvider, context, stream);
            }
        }
        throw new Error('No capability can handle this request');
    }
}

// ================================
// 3. TESTING CAPABILITY (existing functionality)
// ================================

class TestGenerationCapability implements ILLMCapability<TestGenerationInput, TestResult> {
    name = 'test-generation';
    description = 'Generate and heal unit tests with Jest';
    
    canHandle(context: any): boolean {
        return context.command === 'generate' || context.sourceFile?.endsWith('.ts');
    }
    
    async invoke(
        llm: ICoreProvider, 
        input: TestGenerationInput,
        stream: ChatResponseStream
    ): Promise<TestResult> {
        // EL MISMO FLUJO QUE TESTAGEN.generateAndHealTest()
        // 1. Plan strategy
        const strategy = await this.planStrategy(llm, input);
        
        // 2. Generate test
        const testCode = await this.generateTest(llm, input, strategy);
        
        // 3. Execute & heal loop
        return this.healingLoop(llm, testCode, input, stream);
    }
    
    private async planStrategy(llm: ICoreProvider, input: TestGenerationInput): Promise<TestStrategy> {
        const prompt = PROMPTS.PLAN_TEST_STRATEGY(...);
        const response = await llm.sendPrompt('You are a test expert', prompt);
        return JSON.parse(response.code);
    }
    
    private async generateTest(llm: ICoreProvider, input: TestGenerationInput, strategy: TestStrategy): Promise<string> {
        const prompt = PROMPTS.GENERATE_TEST(...);
        const response = await llm.sendPrompt('You are a test expert', prompt);
        return response.code;
    }
    
    private async healingLoop(...): Promise<TestResult> {
        // Retry loop with LLM fixing
        // (código actual de TestAgent)
    }
}

// ================================
// 4. NEW CAPABILITIES (Refactoring)
// ================================

interface RefactoringInput {
    sourceFile: string;
    targetPattern: 'extract-function' | 'rename-variable' | 'simplify-logic';
    selectionRange?: { start: number; end: number };
}

interface RefactoringResult {
    refactoredCode: string;
    explanation: string;
    filesAffected: string[];
}

class CodeRefactoringCapability implements ILLMCapability<RefactoringInput, RefactoringResult> {
    name = 'code-refactoring';
    description = 'Refactor code with LLM guidance';
    
    canHandle(context: any): boolean {
        return context.command === 'refactor' || context.action?.includes('refactor');
    }
    
    async invoke(
        llm: ICoreProvider, 
        input: RefactoringInput,
        stream: ChatResponseStream
    ): Promise<RefactoringResult> {
        stream.markdown('🔄 **Analyzing code for refactoring opportunities...**\n\n');
        
        // 1. Analyze current code
        const analysis = await this.analyzeCode(llm, input);
        stream.markdown(`**Analysis:** ${analysis.complexity} complexity, ${analysis.issues.length} issues found\n\n`);
        
        // 2. LLM suggests refactoring
        const suggestion = await this.suggestRefactoring(llm, input, analysis);
        stream.markdown(`**Suggested Pattern:** ${suggestion.pattern}\n\n`);
        
        // 3. Apply refactoring
        const refactoredCode = await this.applyRefactoring(llm, input, suggestion);
        
        // 4. Validate (compile check, test if tests exist)
        const validation = await this.validateRefactoring(refactoredCode, input);
        
        if (!validation.success) {
            stream.markdown('❌ Refactoring failed validation, retrying...\n\n');
            // Retry loop similar to test healing
        }
        
        return {
            refactoredCode,
            explanation: suggestion.reasoning,
            filesAffected: [input.sourceFile]
        };
    }
    
    private async analyzeCode(llm: ICoreProvider, input: RefactoringInput): Promise<CodeAnalysis> {
        const prompt = `Analyze this code for refactoring opportunities:
        
\`\`\`typescript
${fs.readFileSync(input.sourceFile, 'utf-8')}
\`\`\`

Return JSON with:
- complexity: "low" | "medium" | "high"
- issues: string[] (code smells, duplications, overly complex logic)
- suggestedPatterns: string[]
`;
        const response = await llm.sendPrompt('You are a code refactoring expert', prompt);
        return JSON.parse(response.code);
    }
    
    private async suggestRefactoring(...): Promise<RefactoringSuggestion> {
        // LLM suggests specific refactoring steps
    }
    
    private async applyRefactoring(...): Promise<string> {
        // LLM generates refactored code
    }
    
    private async validateRefactoring(...): Promise<ValidationResult> {
        // TypeScript compilation check + run tests if exist
    }
}

// ================================
// 5. NEW CAPABILITIES (Architecture)
// ================================

interface ArchitectureInput {
    projectRoot: string;
    focus?: 'dependencies' | 'modularity' | 'patterns' | 'security';
}

interface ArchitectureReport {
    score: number;
    strengths: string[];
    weaknesses: string[];
    recommendations: Array<{
        priority: 'high' | 'medium' | 'low';
        issue: string;
        solution: string;
    }>;
    diagram?: string; // Mermaid diagram
}

class ArchitectureAnalysisCapability implements ILLMCapability<ArchitectureInput, ArchitectureReport> {
    name = 'architecture-analysis';
    description = 'Analyze project architecture and suggest improvements';
    
    canHandle(context: any): boolean {
        return context.command === 'analyze-architecture';
    }
    
    async invoke(
        llm: ICoreProvider, 
        input: ArchitectureInput,
        stream: ChatResponseStream
    ): Promise<ArchitectureReport> {
        stream.markdown('🏗️ **Analyzing project architecture...**\n\n');
        
        // 1. Scan codebase structure
        const structure = await this.scanProjectStructure(input.projectRoot);
        stream.progress('Scanning files and dependencies...');
        
        // 2. Analyze dependencies
        const depGraph = await this.buildDependencyGraph(input.projectRoot);
        stream.markdown(`**Files analyzed:** ${structure.fileCount}\n`);
        stream.markdown(`**Dependencies:** ${depGraph.nodeCount} nodes, ${depGraph.edgeCount} edges\n\n`);
        
        // 3. LLM analyzes architecture
        const analysis = await this.analyzeWithLLM(llm, structure, depGraph, input.focus);
        
        // 4. Generate report
        stream.markdown('## 📊 Architecture Report\n\n');
        stream.markdown(`**Overall Score:** ${analysis.score}/100\n\n`);
        stream.markdown('### ✅ Strengths\n');
        analysis.strengths.forEach(s => stream.markdown(`- ${s}\n`));
        stream.markdown('\n### ⚠️ Weaknesses\n');
        analysis.weaknesses.forEach(w => stream.markdown(`- ${w}\n`));
        
        // 5. Show recommendations
        stream.markdown('\n### 🎯 Recommendations\n\n');
        analysis.recommendations.forEach(rec => {
            stream.markdown(`**[${rec.priority.toUpperCase()}]** ${rec.issue}\n`);
            stream.markdown(`  → ${rec.solution}\n\n`);
        });
        
        // 6. Generate Mermaid diagram
        if (analysis.diagram) {
            stream.markdown('### 📐 Architecture Diagram\n\n');
            stream.markdown('```mermaid\n' + analysis.diagram + '\n```\n\n');
        }
        
        return analysis;
    }
    
    private async scanProjectStructure(projectRoot: string): Promise<ProjectStructure> {
        // Scan files, count LOC, identify patterns
    }
    
    private async buildDependencyGraph(projectRoot: string): Promise<DependencyGraph> {
        // Parse imports and build graph
    }
    
    private async analyzeWithLLM(
        llm: ICoreProvider, 
        structure: ProjectStructure, 
        depGraph: DependencyGraph,
        focus?: string
    ): Promise<ArchitectureReport> {
        const prompt = `Analyze this project architecture:

**Structure:**
- Files: ${structure.fileCount}
- Total LOC: ${structure.totalLOC}
- Directories: ${structure.directories.join(', ')}

**Dependency Graph:**
- Nodes: ${depGraph.nodeCount}
- Edges: ${depGraph.edgeCount}
- Circular dependencies: ${depGraph.circularDeps.length}
- Highly coupled files: ${depGraph.highlyCoupled.join(', ')}

**Focus:** ${focus || 'general'}

Provide:
1. Overall architecture score (0-100)
2. Key strengths (what's well done)
3. Critical weaknesses (what needs improvement)
4. Prioritized recommendations with solutions
5. Mermaid diagram showing key modules and their relationships

Return as JSON.`;
        
        const response = await llm.sendPrompt('You are a software architect expert', prompt);
        return JSON.parse(response.code);
    }
}

// ================================
// 6. NEW CAPABILITIES (Complexity)
// ================================

class ComplexityAnalysisCapability implements ILLMCapability<ComplexityInput, ComplexityReport> {
    name = 'complexity-analysis';
    description = 'Analyze code complexity and suggest simplifications';
    
    async invoke(llm: ICoreProvider, input: ComplexityInput, stream: ChatResponseStream): Promise<ComplexityReport> {
        // Cyclomatic complexity, cognitive complexity
        // LLM suggests simplifications
    }
}

// ================================
// 7. COMMAND HANDLER (Extensible)
// ================================

class ExtensibleChatHandler {
    private agent: CodeAssistantAgent;
    private commandMap: Map<string, string>; // command → capability name
    
    constructor(agent: CodeAssistantAgent) {
        this.agent = agent;
        this.commandMap = new Map([
            ['generate', 'test-generation'],
            ['generate-all', 'batch-test-generation'],
            ['refactor', 'code-refactoring'],
            ['analyze-architecture', 'architecture-analysis'],
            ['analyze-complexity', 'complexity-analysis'],
            ['install', 'dependency-installation'],
            ['setup', 'jest-setup']
        ]);
    }
    
    /**
     * Register a new command (plugin system)
     */
    registerCommand(command: string, capabilityName: string): void {
        this.commandMap.set(command, capabilityName);
    }
    
    async handleRequest(
        request: vscode.ChatRequest, 
        context: vscode.ChatContext, 
        stream: vscode.ChatResponseStream
    ): Promise<void> {
        const command = request.command || 'auto';
        
        if (command === 'auto') {
            // Auto-detect capability
            await this.agent.autoExecute(request, stream);
        } else {
            // Execute specific capability
            const capabilityName = this.commandMap.get(command);
            if (!capabilityName) {
                stream.markdown(`❌ Unknown command: \`${command}\`\n\n`);
                return;
            }
            
            await this.agent.execute(capabilityName, request, stream);
        }
    }
}

// ================================
// 8. INITIALIZATION (extension.ts)
// ================================

export function activate(context: vscode.ExtensionContext) {
    // 1. Create LLM provider
    const llmProvider = LLMProviderFactory.createProvider();
    
    // 2. Create agent
    const agent = new CodeAssistantAgent(llmProvider);
    
    // 3. Register capabilities (plugin system)
    agent.registerCapability(new TestGenerationCapability());
    agent.registerCapability(new BatchTestGenerationCapability());
    agent.registerCapability(new DependencyInstallationCapability());
    agent.registerCapability(new CodeRefactoringCapability());
    agent.registerCapability(new ArchitectureAnalysisCapability());
    agent.registerCapability(new ComplexityAnalysisCapability());
    
    // 4. Create command handler
    const chatHandler = new ExtensibleChatHandler(agent);
    
    // 5. Register chat participant
    const participant = vscode.chat.createChatParticipant('spfx-code-assistant', async (request, context, stream, token) => {
        await chatHandler.handleRequest(request, context, stream);
    });
    
    context.subscriptions.push(participant);
}
```

---

## 💡 **VENTAJAS DE ESTA ARQUITECTURA**

### 1. **Extensibilidad Sin Modificar Core**
```typescript
// Agregar nueva funcionalidad NO requiere tocar ILLMProvider
// Solo crear una nueva capability:

class CodeDocumentationCapability implements ILLMCapability<DocInput, DocResult> {
    name = 'documentation-generation';
    // ... implementación
}

// Registrarla:
agent.registerCapability(new CodeDocumentationCapability());
```

### 2. **Reutilización de Infraestructura**
- ✅ Todas las capabilities comparten: Logger, ConfigService, TelemetryService, Error Handling
- ✅ Patrón de healing loop reutilizable (plan → execute → validate → fix → repeat)
- ✅ UI/UX consistente (ChatResponseStream)

### 3. **Testing Independiente**
```typescript
// Testear cada capability por separado
describe('RefactoringCapability', () => {
    it('should extract function', async () => {
        const mockLLM = createMockProvider();
        const capability = new CodeRefactoringCapability();
        const result = await capability.invoke(mockLLM, {...}, mockStream);
        expect(result.refactoredCode).toContain('function extracted');
    });
});
```

### 4. **Marketplace de Capabilities (Futuro)**
```typescript
// Permitir a usuarios instalar capabilities desde marketplace
await agent.installCapability('@community/code-security-scan');
await agent.installCapability('@company/custom-linter');
```

---

## 🛠️ **PLAN DE MIGRACIÓN**

### **Phase 1: Refactor Core (v0.6.0)**
1. Extraer `ICoreProvider` de `ILLMProvider`
2. Crear `ILLMCapability<TInput, TOutput>` interface
3. Crear `CodeAssistantAgent` genérico
4. Migrar `TestAgent` → `TestGenerationCapability`

### **Phase 2: Extensible Commands (v0.7.0)**
5. Refactor `ChatHandlers` → `ExtensibleChatHandler`
6. Sistema de registro de comandos/capabilities

### **Phase 3: New Capabilities (v0.8.0+)**
7. Implementar `CodeRefactoringCapability`
8. Implementar `ArchitectureAnalysisCapability`
9. Implementar `ComplexityAnalysisCapability`

---

## 📊 **COMPARACIÓN: Antes vs Después**

| Aspecto | Actual (v0.5.3) | Propuesta (v0.6.0+) |
|---------|-----------------|---------------------|
| **Agregar feature** | Modificar `ILLMProvider` + crear `XAgent` + modificar `ChatHandlers` | Crear `XCapability` + registrar |
| **Testing** | Mock todo `ILLMProvider` | Mock solo `ICoreProvider` |
| **Reutilización** | Copiar código de `TestAgent` | Heredar de base capability |
| **Plugins** | ❌ No soportado | ✅ Sistema de registro |
| **Mantenibilidad** | Monolito testeado | Modular y extensible |

---

## 🎯 **CONCLUSIÓN**

**¿El sistema actual es extensible?**
- ✅ **Parcialmente**: Provider pattern y DI son buenos, pero...
- ❌ **Acoplamiento al testing**: Interface y agentes específicos de testing

**¿Qué se necesita para hacerlo verdaderamente extensible?**
1. **Capability/Plugin architecture** (descrita arriba)
2. **Generic core interfaces** (ICoreProvider, ILLMCapability)
3. **Command registry system** (extensible sin modificar código)

**Esfuerzo estimado de refactoring:**
- **Phase 1 (Core)**: ~3-5 días
- **Phase 2 (Commands)**: ~2-3 días  
- **Phase 3 (New features)**: ~1-2 días por capability

**¿Vale la pena?**
- ✅ **SÍ** si planeas agregar 3+ nuevas funcionalidades
- ✅ **SÍ** si quieres un producto extensible por la comunidad
- ❌ **NO** si solo quieres testing automation a corto plazo
