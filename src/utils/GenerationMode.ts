/**
 * Generation mode determines the balance between speed and thoroughness
 */
export enum GenerationMode {
    /**
     * Fast mode: Generate test without auto-healing
     * - No test execution
     * - No error detection
     * - Fast but may produce non-working tests
     * - Best for: Initial scaffolding, simple components
     */
    FAST = 'fast',
    
    /**
     * Balanced mode: Generate and try to heal once
     * - Executes test once
     * - One attempt to fix if fails
     * - Good balance of speed and quality
     * - Best for: Most use cases
     */
    BALANCED = 'balanced',
    
    /**
     * Thorough mode: Generate with full auto-healing
     * - Executes test
     * - Up to 3 attempts to fix
     * - Slower but higher success rate
     * - Best for: Complex components, production tests
     */
    THOROUGH = 'thorough'
}

/**
 * Configuration for each generation mode
 */
export interface GenerationModeConfig {
    mode: GenerationMode;
    maxHealingAttempts: number;
    executeTests: boolean;
    description: string;
    estimatedTimePerFile: string;
    tokenUsageEstimate: string;
}

/**
 * Mode configurations
 */
export const GENERATION_MODE_CONFIGS: Record<GenerationMode, GenerationModeConfig> = {
    [GenerationMode.FAST]: {
        mode: GenerationMode.FAST,
        maxHealingAttempts: 0,
        executeTests: false,
        description: 'Genera tests sin ejecutarlos ni repararlos',
        estimatedTimePerFile: '10-15 segundos',
        tokenUsageEstimate: '~2,000 tokens'
    },
    [GenerationMode.BALANCED]: {
        mode: GenerationMode.BALANCED,
        maxHealingAttempts: 1,
        executeTests: true,
        description: 'Genera y ejecuta tests con un intento de reparación',
        estimatedTimePerFile: '30-45 segundos',
        tokenUsageEstimate: '~5,000 tokens'
    },
    [GenerationMode.THOROUGH]: {
        mode: GenerationMode.THOROUGH,
        maxHealingAttempts: 3,
        executeTests: true,
        description: 'Generación completa con auto-reparación exhaustiva',
        estimatedTimePerFile: '60-90 segundos',
        tokenUsageEstimate: '~10,000 tokens'
    }
};

/**
 * Get mode configuration
 */
export function getModeConfig(mode: GenerationMode): GenerationModeConfig {
    return GENERATION_MODE_CONFIGS[mode];
}

/**
 * Parse mode from string
 */
export function parseMode(modeString: string): GenerationMode {
    const normalized = modeString.toLowerCase();
    
    switch (normalized) {
        case 'fast':
        case 'rapido':
        case 'rápido':
            return GenerationMode.FAST;
        
        case 'balanced':
        case 'equilibrado':
        case 'normal':
            return GenerationMode.BALANCED;
        
        case 'thorough':
        case 'completo':
        case 'exhaustivo':
            return GenerationMode.THOROUGH;
        
        default:
            return GenerationMode.BALANCED;
    }
}

/**
 * Estimate total time for batch generation
 */
export function estimateBatchTime(fileCount: number, mode: GenerationMode): string {
    const config = getModeConfig(mode);
    
    // Parse time range (e.g., "30-45 segundos" -> average 37.5 seconds)
    const timeMatch = config.estimatedTimePerFile.match(/(\d+)-(\d+)/);
    if (!timeMatch) {
        return 'Estimación no disponible';
    }
    
    const avgSeconds = (parseInt(timeMatch[1]) + parseInt(timeMatch[2])) / 2;
    const totalSeconds = avgSeconds * fileCount;
    
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    
    if (minutes === 0) {
        return `${seconds} segundos`;
    } else if (seconds === 0) {
        return `${minutes} minuto${minutes > 1 ? 's' : ''}`;
    } else {
        return `${minutes} minuto${minutes > 1 ? 's' : ''} y ${seconds} segundo${seconds > 1 ? 's' : ''}`;
    }
}

/**
 * Estimate total token usage for batch generation
 */
export function estimateBatchTokens(fileCount: number, mode: GenerationMode): number {
    const config = getModeConfig(mode);
    
    // Parse token estimate (e.g., "~2,000 tokens" -> 2000)
    const tokenMatch = config.tokenUsageEstimate.match(/(\d+,?\d*)/);
    if (!tokenMatch) {
        return 0;
    }
    
    const tokensPerFile = parseInt(tokenMatch[1].replace(',', ''));
    return tokensPerFile * fileCount;
}
