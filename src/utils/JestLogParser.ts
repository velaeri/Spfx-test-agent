import { ConfigService } from '../services/ConfigService';

/**
 * JestLogParser - Utility to clean and extract relevant information from Jest output
 * 
 * This parser removes ANSI escape codes, filters out noise from node_modules stack traces,
 * and extracts only the relevant error messages and user code stack traces.
 * This is crucial for reducing token usage when sending errors to the LLM.
 */
export class JestLogParser {
    /**
     * Removes ANSI escape codes (color codes) from a string
     * ANSI codes like \x1b[31m (red), \x1b[0m (reset), etc. add noise for LLMs
     * 
     * @param text - Text containing ANSI codes
     * @returns Clean text without ANSI codes
     */
    static removeAnsiCodes(text: string): string {
        // eslint-disable-next-line no-control-regex
        return text.replace(/\x1b\[[0-9;]*m/g, '');
    }

    /**
     * Extracts only the relevant error information from Jest output
     * Removes stack traces from node_modules and internal libraries
     * 
     * @param jestOutput - Raw Jest output (stdout/stderr)
     * @returns Cleaned error message focusing on user code issues
     */
    static cleanJestOutput(jestOutput: string): string {
        // First, remove ANSI codes
        const cleaned = this.removeAnsiCodes(jestOutput);

        // Extract FAIL sections (these contain the actual test failures)
        const failSections: string[] = [];
        const failRegex = /FAIL\s+.*?\n([\s\S]*?)(?=\n\s*Test Suites:|$)/g;
        let match;
        
        while ((match = failRegex.exec(cleaned)) !== null) {
            failSections.push(match[0]);
        }

        if (failSections.length === 0) {
            // If no FAIL sections found, look for error messages
            const errorLines = cleaned.split('\n').filter(line => 
                line.includes('Error:') || 
                line.includes('Expected') || 
                line.includes('Received') ||
                line.includes('●')
            );
            
            if (errorLines.length > 0) {
                return errorLines.join('\n');
            }
            
            // Return a subset if no specific errors found
            return cleaned.substring(0, 2000);
        }

        // Process each FAIL section to extract relevant info
        const processedSections = failSections.map(section => {
            const lines = section.split('\n');
            const relevantLines: string[] = [];

            for (const line of lines) {
                // Skip lines from node_modules
                if (line.includes('node_modules')) {
                    continue;
                }

                // Skip internal Jest/React lines unless they're error messages
                if (line.includes('at ') && 
                    (line.includes('internal/') || 
                     line.includes('jest-') ||
                     line.includes('react-dom/') ||
                     line.includes('scheduler/'))) {
                    continue;
                }

                // Include error messages, test descriptions, and user code stack traces
                if (line.trim().startsWith('●') || // Test name
                    line.trim().startsWith('Expected') ||
                    line.trim().startsWith('Received') ||
                    line.includes('Error:') ||
                    line.includes('at ') || // Stack trace (after filtering above)
                    line.includes('FAIL') ||
                    /^\s+\d+\s*\|/.test(line)) { // Code snippet lines
                    relevantLines.push(line);
                }
            }

            return relevantLines.join('\n');
        });

        const result = processedSections.join('\n\n---\n\n');

        // Limit total length to avoid excessive token usage (configurable)
        const maxLength = ConfigService.get('maxTokensPerError', 1500);
        if (result.length > maxLength) {
            return result.substring(0, maxLength) + '\n... (output truncated)';
        }

        return result;
    }

    /**
     * Extracts test summary information from Jest output
     * Handles multiple Jest output formats
     * 
     * @param jestOutput - Raw Jest output
     * @returns Object with test statistics
     */
    static extractTestSummary(jestOutput: string): {
        total: number;
        passed: number;
        failed: number;
        skipped: number;
    } {
        const cleaned = this.removeAnsiCodes(jestOutput);
        
        // Try multiple patterns to match different Jest output formats
        // Pattern 1: "Tests:       1 failed, 1 total"
        // Pattern 2: "Tests: 1 failed, 2 passed, 3 total"
        // Pattern 3: "failed: 1, passed: 2, total: 3"
        
        const patterns = [
            /Tests:\s+(?:(\d+)\s+failed[,\s]+)?(?:(\d+)\s+passed[,\s]+)?(?:(\d+)\s+skipped[,\s]+)?(\d+)\s+total/i,
            /failed:\s*(\d+)[,\s]+passed:\s*(\d+)[,\s]+total:\s*(\d+)/i,
            /(\d+)\s+failed[,\s]+(\d+)\s+passed[,\s]+(\d+)\s+total/i
        ];
        
        for (const pattern of patterns) {
            const match = cleaned.match(pattern);
            if (match) {
                // Handle different capture group arrangements
                if (pattern === patterns[0]) {
                    return {
                        failed: parseInt(match[1] || '0'),
                        passed: parseInt(match[2] || '0'),
                        skipped: parseInt(match[3] || '0'),
                        total: parseInt(match[4] || '0')
                    };
                } else if (pattern === patterns[1]) {
                    return {
                        failed: parseInt(match[1] || '0'),
                        passed: parseInt(match[2] || '0'),
                        skipped: 0,
                        total: parseInt(match[3] || '0')
                    };
                } else {
                    return {
                        failed: parseInt(match[1] || '0'),
                        passed: parseInt(match[2] || '0'),
                        skipped: 0,
                        total: parseInt(match[3] || '0')
                    };
                }
            }
        }

        return { total: 0, passed: 0, failed: 0, skipped: 0 };
    }
}
