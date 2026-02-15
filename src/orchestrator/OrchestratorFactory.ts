import { ToolRegistry } from '../tools/ToolRegistry';
import { ILLMProvider } from '../interfaces/ILLMProvider';

// Deterministic tools
import { ListSourceFilesTool } from '../tools/deterministic/ListSourceFilesTool';
import { ReadFileTool } from '../tools/deterministic/ReadFileTool';
import { WriteFileTool } from '../tools/deterministic/WriteFileTool';
import { RunTestTool } from '../tools/deterministic/RunTestTool';
import { AnalyzeProjectTool } from '../tools/deterministic/AnalyzeProjectTool';
import { CollectContextTool } from '../tools/deterministic/CollectContextTool';

// Intelligent tools
import { GenerateTestTool } from '../tools/intelligent/GenerateTestTool';
import { FixTestTool } from '../tools/intelligent/FixTestTool';

/**
 * OrchestratorFactory — Creates a fully configured LLMOrchestrator
 * with all tools registered.
 * 
 * This is the single setup point for the tool-based architecture.
 */
export class OrchestratorFactory {
    /**
     * Create a ToolRegistry with all available tools
     */
    static createToolRegistry(llmProvider: ILLMProvider): ToolRegistry {
        const registry = new ToolRegistry();

        // Register deterministic tools (pure code, no LLM)
        registry.registerAll([
            new ListSourceFilesTool(),
            new ReadFileTool(),
            new WriteFileTool(),
            new RunTestTool(),
            new AnalyzeProjectTool(),
            new CollectContextTool()
        ]);

        // Register intelligent tools (use LLM internally)
        registry.registerAll([
            new GenerateTestTool(llmProvider),
            new FixTestTool(llmProvider)
        ]);

        return registry;
    }
}
