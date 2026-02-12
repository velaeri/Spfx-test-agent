import { ConfigService } from './ConfigService';
import { Logger } from './Logger';

export interface TelemetryEvent {
    eventName: string;
    properties?: Record<string, string>;
    measurements?: Record<string, number>;
}

export class TelemetryService {
    private static instance: TelemetryService;
    private configService: ConfigService;
    private logger: Logger;
    private isEnabled: boolean;

    private constructor() {
        this.configService = ConfigService.getInstance();
        this.logger = Logger.getInstance();
        this.isEnabled = this.configService.getConfig().telemetryEnabled;
    }

    public static getInstance(): TelemetryService {
        if (!TelemetryService.instance) {
            TelemetryService.instance = new TelemetryService();
        }
        return TelemetryService.instance;
    }

    public trackEvent(event: TelemetryEvent): void {
        if (!this.isEnabled) {
            return;
        }

        const sanitizedEvent = this.sanitizeEvent(event);
        
        // Log telemetry to output channel (privacy-safe)
        this.logger.info(
            `[Telemetry] ${sanitizedEvent.eventName}`,
            JSON.stringify({
                properties: sanitizedEvent.properties,
                measurements: sanitizedEvent.measurements
            }, null, 2)
        );
    }

    public trackCommandExecution(command: string): void {
        this.trackEvent({
            eventName: 'command.executed',
            properties: {
                command: this.sanitizeCommand(command)
            }
        });
    }

    public trackTestGeneration(success: boolean, attempts: number, durationMs: number): void {
        this.trackEvent({
            eventName: 'test.generation',
            properties: {
                success: success.toString(),
                provider: this.getProviderType()
            },
            measurements: {
                attempts,
                durationMs
            }
        });
    }

    public trackBatchGeneration(totalFiles: number, successCount: number, failureCount: number, durationMs: number): void {
        this.trackEvent({
            eventName: 'batch.generation',
            measurements: {
                totalFiles,
                successCount,
                failureCount,
                durationMs,
                successRate: totalFiles > 0 ? (successCount / totalFiles) * 100 : 0
            }
        });
    }

    public trackSetup(success: boolean, durationMs: number): void {
        this.trackEvent({
            eventName: 'setup.execution',
            properties: {
                success: success.toString()
            },
            measurements: {
                durationMs
            }
        });
    }

    public trackError(errorType: string, phase: string): void {
        this.trackEvent({
            eventName: 'error.occurred',
            properties: {
                errorType: this.sanitizeErrorType(errorType),
                phase: this.sanitizePhase(phase)
            }
        });
    }

    public trackHealingAttempt(attemptNumber: number, errorType: string): void {
        this.trackEvent({
            eventName: 'healing.attempt',
            properties: {
                errorType: this.sanitizeErrorType(errorType)
            },
            measurements: {
                attemptNumber
            }
        });
    }

    private sanitizeEvent(event: TelemetryEvent): TelemetryEvent {
        return {
            eventName: event.eventName,
            properties: event.properties ? this.sanitizeProperties(event.properties) : undefined,
            measurements: event.measurements
        };
    }

    private sanitizeProperties(properties: Record<string, string>): Record<string, string> {
        const sanitized: Record<string, string> = {};
        
        for (const [key, value] of Object.entries(properties)) {
            // Remove any potential PII or code snippets
            if (typeof value === 'string' && value.length > 100) {
                sanitized[key] = '[TRUNCATED]';
            } else if (this.containsPotentialPII(value)) {
                sanitized[key] = '[REDACTED]';
            } else {
                sanitized[key] = value;
            }
        }
        
        return sanitized;
    }

    private containsPotentialPII(value: string): boolean {
        // Check for file paths, emails, tokens, etc.
        const piiPatterns = [
            /[a-zA-Z]:[\\\/]/, // Windows paths
            /\/home\/|\/Users\//, // Unix paths
            /@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // Emails
            /Bearer\s+/i, // Auth tokens
            /password|secret|token|key/i // Sensitive keywords
        ];
        
        return piiPatterns.some(pattern => pattern.test(value));
    }

    private sanitizeCommand(command: string): string {
        const allowedCommands = ['generate', 'generate-all', 'setup'];
        return allowedCommands.includes(command) ? command : 'unknown';
    }

    private sanitizeErrorType(errorType: string): string {
        // Extract only error class name, not the message
        const match = errorType.match(/^([A-Za-z]+Error)/);
        return match ? match[1] : 'UnknownError';
    }

    private sanitizePhase(phase: string): string {
        const allowedPhases = ['generation', 'execution', 'healing', 'setup', 'analysis'];
        return allowedPhases.includes(phase) ? phase : 'unknown';
    }

    private getProviderType(): string {
        const config = this.configService.getConfig();
        if (config.azureOpenAI?.endpoint) {
            return 'azure';
        }
        return 'copilot';
    }
}
