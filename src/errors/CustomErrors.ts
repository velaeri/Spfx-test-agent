/**
 * Custom error classes for better error handling and diagnostics
 */

/**
 * Base error class for all SPFX Test Agent errors
 */
export class SPFXTestAgentError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Error thrown when Jest is not installed in the project
 */
export class JestNotFoundError extends SPFXTestAgentError {
    constructor(workspaceRoot: string) {
        super(
            `Jest is not installed in this project (${workspaceRoot}). Please run: npm install --save-dev jest @types/jest ts-jest`,
            'JEST_NOT_FOUND'
        );
    }
}

/**
 * Error thrown when no LLM model is available
 */
export class LLMNotAvailableError extends SPFXTestAgentError {
    constructor(vendor: string, family: string) {
        super(
            `No ${family} model available from vendor '${vendor}'. Ensure GitHub Copilot is installed and activated.`,
            'LLM_NOT_AVAILABLE'
        );
    }
}

/**
 * Error thrown when LLM request times out
 */
export class LLMTimeoutError extends SPFXTestAgentError {
    constructor(timeoutMs: number) {
        super(
            `LLM request timed out after ${timeoutMs}ms`,
            'LLM_TIMEOUT'
        );
    }
}

/**
 * Error thrown when rate limit is exceeded
 */
export class RateLimitError extends SPFXTestAgentError {
    constructor(public readonly retryAfterMs?: number) {
        super(
            retryAfterMs 
                ? `Rate limit exceeded. Retry after ${retryAfterMs}ms`
                : 'Rate limit exceeded. Please try again later.',
            'RATE_LIMIT_EXCEEDED'
        );
    }
}

/**
 * Error thrown when test generation fails after maximum attempts
 */
export class TestGenerationError extends SPFXTestAgentError {
    constructor(
        message: string,
        public readonly attempt: number,
        public readonly maxAttempts: number,
        public readonly jestOutput?: string
    ) {
        super(
            `${message} (Attempt ${attempt}/${maxAttempts})`,
            'TEST_GENERATION_FAILED'
        );
    }
}

/**
 * Error thrown when test execution fails
 */
export class TestExecutionError extends SPFXTestAgentError {
    public readonly cause?: Error;

    constructor(
        public readonly testFilePath: string,
        public readonly output: string,
        cause?: Error
    ) {
        super(
            `Test execution failed for ${testFilePath}`,
            'TEST_EXECUTION_FAILED'
        );
        this.cause = cause;
    }
}

/**
 * Error thrown when file validation fails
 */
export class FileValidationError extends SPFXTestAgentError {
    constructor(message: string, public readonly filePath: string) {
        super(message, 'FILE_VALIDATION_FAILED');
    }
}

/**
 * Error thrown when workspace is not found
 */
export class WorkspaceNotFoundError extends SPFXTestAgentError {
    constructor() {
        super(
            'No workspace folder found. Please open a workspace/folder.',
            'WORKSPACE_NOT_FOUND'
        );
    }
}

/**
 * Error thrown when command injection is detected
 */
export class SecurityError extends SPFXTestAgentError {
    constructor(message: string) {
        super(message, 'SECURITY_ERROR');
    }
}
