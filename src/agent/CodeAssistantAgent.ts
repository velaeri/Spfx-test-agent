import * as vscode from 'vscode';
import { ICoreProvider } from '../interfaces/ICoreProvider';
import { ILLMCapability, CapabilityContext, CapabilityError } from '../interfaces/ILLMCapability';
import { Logger } from '../services/Logger';

/**
 * Generic Code Assistant Agent
 * 
 * This agent orchestrates multiple capabilities (testing, refactoring, analysis, etc.)
 * and provides a unified interface for executing them.
 * 
 * It acts as a plugin system where new capabilities can be registered dynamically.
 */
export class CodeAssistantAgent {
    private capabilities: Map<string, ILLMCapability<any, any>>;
    private provider: ICoreProvider;
    private logger: Logger;

    constructor(provider: ICoreProvider) {
        this.provider = provider;
        this.capabilities = new Map();
        this.logger = Logger.getInstance();
        
        this.logger.info(`CodeAssistantAgent initialized with provider: ${provider.getProviderName()}`);
    }

    /**
     * Register a new capability
     * 
     * Capabilities can be registered at runtime, allowing for a plugin-like architecture.
     * 
     * @param capability - The capability to register
     * @throws Error if a capability with the same name is already registered
     */
    registerCapability(capability: ILLMCapability<any, any>): void {
        if (this.capabilities.has(capability.name)) {
            throw new Error(`Capability already registered: ${capability.name}`);
        }

        this.capabilities.set(capability.name, capability);
        this.logger.info(`Registered capability: ${capability.name} (${capability.description})`);
    }

    /**
     * Unregister a capability
     * 
     * @param capabilityName - Name of the capability to remove
     * @returns true if removed, false if not found
     */
    unregisterCapability(capabilityName: string): boolean {
        const removed = this.capabilities.delete(capabilityName);
        if (removed) {
            this.logger.info(`Unregistered capability: ${capabilityName}`);
        }
        return removed;
    }

    /**
     * Get a registered capability by name
     * 
     * @param capabilityName - Name of the capability
     * @returns The capability, or undefined if not found
     */
    getCapability(capabilityName: string): ILLMCapability<any, any> | undefined {
        return this.capabilities.get(capabilityName);
    }

    /**
     * Get all registered capabilities
     * 
     * @returns Array of all capabilities
     */
    getAllCapabilities(): ILLMCapability<any, any>[] {
        return Array.from(this.capabilities.values());
    }

    /**
     * Get capabilities by category
     * 
     * @param category - Category to filter by
     * @returns Array of capabilities in that category
     */
    getCapabilitiesByCategory(category: string): ILLMCapability<any, any>[] {
        return this.getAllCapabilities().filter(cap => cap.category === category);
    }

    /**
     * Execute a specific capability by name
     * 
     * @param capabilityName - Name of the capability to execute
     * @param input - Input data for the capability
     * @param stream - VS Code chat stream for user feedback
     * @param token - Cancellation token
     * @returns The result of executing the capability
     * @throws CapabilityError if capability not found or execution fails
     */
    async execute<TInput = any, TOutput = any>(
        capabilityName: string,
        input: TInput,
        stream: vscode.ChatResponseStream,
        token?: vscode.CancellationToken
    ): Promise<TOutput> {
        const capability = this.capabilities.get(capabilityName);
        
        if (!capability) {
            const error = `Capability not found: ${capabilityName}`;
            this.logger.error(error);
            stream.markdown(`❌ **Error:** ${error}\n\n`);
            stream.markdown(`Available capabilities: ${Array.from(this.capabilities.keys()).join(', ')}\n\n`);
            throw new CapabilityError(error, capabilityName);
        }

        this.logger.info(`Executing capability: ${capabilityName}`);

        try {
            // Optional: Validate input
            if (capability.validateInput) {
                const validation = await capability.validateInput(input);
                if (!validation.valid) {
                    const error = `Invalid input: ${validation.error}`;
                    this.logger.error(error);
                    stream.markdown(`❌ **Validation Error:** ${validation.error}\n\n`);
                    
                    if (validation.suggestions && validation.suggestions.length > 0) {
                        stream.markdown('**Suggestions:**\n');
                        validation.suggestions.forEach(s => stream.markdown(`- ${s}\n`));
                        stream.markdown('\n');
                    }
                    
                    throw new CapabilityError(error, capabilityName);
                }
            }

            // Execute capability
            const result = await capability.execute(this.provider, input, stream, token);
            
            this.logger.info(`Capability executed successfully: ${capabilityName}`);
            return result;

        } catch (error) {
            if (error instanceof CapabilityError) {
                throw error;
            }

            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Capability execution failed: ${capabilityName}`, error);
            throw new CapabilityError(
                `Failed to execute ${capabilityName}: ${errorMsg}`,
                capabilityName,
                error instanceof Error ? error : undefined
            );
        }
    }

    /**
     * Auto-detect and execute the appropriate capability based on context
     * 
     * Useful when the user doesn't specify an explicit command.
     * The first capability that returns true from canHandle() will be executed.
     * 
     * @param context - Context information to determine which capability to use
     * @param stream - VS Code chat stream for user feedback
     * @param token - Cancellation token
     * @returns The result of executing the detected capability
     * @throws CapabilityError if no capability can handle the request
     */
    async autoExecute(
        context: CapabilityContext,
        stream: vscode.ChatResponseStream,
        token?: vscode.CancellationToken
    ): Promise<any> {
        this.logger.info('Auto-detecting capability', { command: context.command, message: context.message });

        // Try to find a capable capability
        for (const capability of this.capabilities.values()) {
            if (capability.canHandle(context)) {
                this.logger.info(`Auto-selected capability: ${capability.name}`);
                stream.markdown(`🤖 Using: **${capability.description}**\n\n`);
                
                return this.execute(capability.name, context, stream, token);
            }
        }

        // No capability found
        const error = 'No capability can handle this request';
        this.logger.warn(error, { context });
        
        stream.markdown(`❌ **Error:** ${error}\n\n`);
        stream.markdown('**Available capabilities:**\n');
        
        this.getAllCapabilities().forEach(cap => {
            stream.markdown(`- **${cap.name}**: ${cap.description}\n`);
        });
        
        throw new CapabilityError(error, 'auto-detect');
    }

    /**
     * Show help information about available capabilities
     * 
     * @param stream - VS Code chat stream for displaying help
     * @param capabilityName - Optional: Show help for a specific capability
     */
    async showHelp(stream: vscode.ChatResponseStream, capabilityName?: string): Promise<void> {
        if (capabilityName) {
            // Show help for specific capability
            const capability = this.capabilities.get(capabilityName);
            if (!capability) {
                stream.markdown(`❌ Capability not found: ${capabilityName}\n\n`);
                return;
            }

            stream.markdown(`# ${capability.name}\n\n`);
            stream.markdown(`**Description:** ${capability.description}\n\n`);
            stream.markdown(`**Category:** ${capability.category}\n\n`);
            stream.markdown(capability.getHelpText());
            
        } else {
            // Show all capabilities
            stream.markdown('# Available Capabilities\n\n');
            stream.markdown(`**LLM Provider:** ${this.provider.getProviderName()}\n\n`);
            
            // Group by category
            const categories = new Set(this.getAllCapabilities().map(c => c.category));
            
            for (const category of categories) {
                const caps = this.getCapabilitiesByCategory(category);
                stream.markdown(`## ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n`);
                
                caps.forEach(cap => {
                    stream.markdown(`### ${cap.name}\n`);
                    stream.markdown(`${cap.description}\n\n`);
                });
            }

            stream.markdown('\n---\n\n');
            stream.markdown('💡 Use `@spfx-tester /help <capability-name>` for detailed help on a specific capability.\n\n');
        }
    }

    /**
     * Get the current LLM provider
     * 
     * @returns The ICoreProvider instance
     */
    getProvider(): ICoreProvider {
        return this.provider;
    }

    /**
     * Replace the LLM provider
     * 
     * Useful for switching providers at runtime (e.g., from Copilot to Azure OpenAI)
     * 
     * @param provider - The new provider to use
     */
    setProvider(provider: ICoreProvider): void {
        this.logger.info(`Switching provider from ${this.provider.getProviderName()} to ${provider.getProviderName()}`);
        this.provider = provider;
    }
}
