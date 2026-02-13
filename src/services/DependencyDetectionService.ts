import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Logger } from './Logger';
import { ConfigService } from './ConfigService';
import { LLMProviderFactory } from '../factories/LLMProviderFactory';
import { ILLMProvider } from '../interfaces/ILLMProvider';
// ✨ v0.5.0: Removed hardcoded JEST_DEPENDENCIES imports - now using LLM-First approach



export class DependencyDetectionService {
    private logger: Logger;
    private llmProvider: ILLMProvider;

    constructor() {
        this.logger = Logger.getInstance();
        this.llmProvider = LLMProviderFactory.createProvider();
    }

    /**
     * Checks if Jest is available in the project (either in package.json or globally executable)
     * 
     * @param projectRoot - Root directory of the project
     * @returns Promise<boolean> indicating if Jest is available
     */
    async checkJestAvailability(projectRoot: string): Promise<boolean> {
        // 1. Check package.json (fastest)
        const versionInfo = this.getExistingJestVersion(projectRoot);
        if (versionInfo) {
            this.logger.debug(`Jest found in package.json: ${versionInfo.version}`);
            return true;
        }

        // 2. Check executable (slower but covers global installs or monorepos)
        this.logger.debug('Jest not in package.json, checking executable...');
        return new Promise((resolve) => {
            const child = spawn('npx', ['jest', '--version'], {
                cwd: projectRoot,
                shell: true
            });

            child.on('error', () => {
                this.logger.debug('Jest executable check failed');
                resolve(false);
            });

            child.on('close', (code) => {
                const available = code === 0;
                this.logger.debug(`Jest executable check result: ${available}`);
                resolve(available);
            });
        });
    }

    /**
     * Use LLM to analyze package.json and recommend compatible Jest versions
     */
    async getCompatibleVersionsFromLLM(projectRoot: string): Promise<Record<string, string> | null> {
        try {
            const packageJsonPath = path.join(projectRoot, 'package.json');
            if (!fs.existsSync(packageJsonPath)) {
                return null;
            }
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            
            const versions = await this.llmProvider.detectDependencies(packageJson);
            
            this.logger.info('LLM recommended versions:', versions);
            return versions;
        } catch (error) {
            this.logger.error('Failed to get versions from LLM', error);
            return null;
        }
    }

    /**
     * Detect existing Jest version in the project
     */
    getExistingJestVersion(projectRoot: string): { version: string; major: number } | null {
        try {
            const packageJsonPath = path.join(projectRoot, 'package.json');
            if (!fs.existsSync(packageJsonPath)) {
                return null;
            }
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            const allDeps = {
                ...packageJson.dependencies || {},
                ...packageJson.devDependencies || {}
            };
            const jestVersion = allDeps['jest'];
            if (!jestVersion) {
                return null;
            }
            // Extract major version (e.g., "^28.1.3" -> 28)
            const match = jestVersion.match(/(\d+)\./);
            if (match) {
                const major = parseInt(match[1], 10);
                this.logger.info(`Detected existing Jest version: ${jestVersion} (major: ${major})`);
                return { version: jestVersion, major };
            }
            return null;
        } catch (error) {
            this.logger.error('Failed to detect Jest version', error);
            return null;
        }
    }

    /**
     * Get compatible dependencies using LLM with retry loop (NO HARDCODED FALLBACK)
     */
    async getCompatibleDependencies(projectRoot: string): Promise<Record<string, string>> {
        const maxRetries = 3;
        let attempt = 0;
        let lastError: string | undefined;

        // Get currently installed dependencies
        const packageJsonPath = path.join(projectRoot, 'package.json');
        let packageJson: any = {};
        if (fs.existsSync(packageJsonPath)) {
            packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        }

        const installedDeps: Record<string, string> = {
            ...packageJson.dependencies || {},
            ...packageJson.devDependencies || {}
        };

        this.logger.info('🧠 Using LLM to detect compatible dependencies...');

        while (attempt < maxRetries) {
            attempt++;
            this.logger.info(`Attempt ${attempt}/${maxRetries}...`);

            try {
                const llmVersions = await this.llmProvider.detectDependencies(
                    packageJson,
                    lastError ? { error: lastError, attemptNumber: attempt - 1 } : undefined
                );

                if (llmVersions && Object.keys(llmVersions).length > 0) {
                    this.logger.info('✅ LLM analysis completed', {
                        missingCount: Object.keys(llmVersions).length,
                        packages: Object.keys(llmVersions)
                    });
                    return llmVersions;
                }

                if (Object.keys(llmVersions).length === 0) {
                    this.logger.info('✅ All dependencies already installed');
                    return {};
                }
            } catch (error) {
                lastError = error instanceof Error ? error.message : 'Unknown LLM error';
                this.logger.warn(`❌ LLM attempt ${attempt} failed: ${lastError}`);
                
                if (attempt < maxRetries) {
                    // Wait before retry
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    continue;
                }
            }
        }

        //  ✨ NEW: If LLM fails after retries, try "latest" strategy instead of hardcoded versions
        this.logger.warn('⚠️ LLM failed after 3 attempts - using latest version strategy');
        return this.getLatestCompatibleVersions(installedDeps);
    }

    /**
     * Last resort: Suggest "latest" for missing essential packages
     * This avoids hardcoded versions that may not exist
     */
    private getLatestCompatibleVersions(installedDeps: Record<string, string>): Record<string, string> {
        const essentialPackages = [
            'jest',
            '@types/jest',
            'ts-jest',
            '@testing-library/react',
            '@testing-library/jest-dom',
            'react-test-renderer',
            '@types/react-test-renderer',
            'identity-obj-proxy'
        ];

        const missing: Record<string, string> = {};
        
        for (const pkg of essentialPackages) {
            if (!installedDeps[pkg]) {
                // Use "latest" tag - npm will resolve the newest stable version
                missing[pkg] = 'latest';
            }
        }

        this.logger.info('Using "latest" strategy for missing packages', {
            count: Object.keys(missing).length,
            packages: Object.keys(missing)
        });

        return missing;
    }
}
