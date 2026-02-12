import { ILLMProvider } from '../interfaces/ILLMProvider';
import { AzureOpenAIProvider } from '../providers/AzureOpenAIProvider';
import { CopilotProvider } from '../providers/CopilotProvider';
import { ConfigService } from '../services/ConfigService';
import { Logger } from '../services/Logger';

export class LLMProviderFactory {
    private static logger = Logger.getInstance();

    public static createProvider(): ILLMProvider {
        const config = ConfigService.getConfig();
        let provider: ILLMProvider;

        // Check if Azure OpenAI is configured
        const hasAzureConfig = config.azureOpenAI?.endpoint && 
                             config.azureOpenAI?.apiKey && 
                             config.azureOpenAI?.deploymentName;

        if (hasAzureConfig) {
            this.logger.info('Using Azure OpenAI Provider');
            provider = new AzureOpenAIProvider();
        } else {
            this.logger.info(`Using Copilot Provider (${config.llmVendor} - ${config.llmFamily})`);
            provider = new CopilotProvider(config.llmVendor, config.llmFamily);
        }

        return provider;
    }
}
