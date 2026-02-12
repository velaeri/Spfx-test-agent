import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Logger } from './Logger';
import { ConfigService } from './ConfigService';
import { CopilotProvider } from '../providers/CopilotProvider';
import { AzureOpenAIProvider } from '../providers/AzureOpenAIProvider';
import { ILLMProvider } from '../interfaces/ILLMProvider';
import { JEST_DEPENDENCIES, JEST_28_COMPATIBLE_DEPENDENCIES } from '../utils/constants';



export class DependencyDetectionService {
    private logger: Logger;
    private llmProvider: ILLMProvider;

    constructor() {
        this.logger = Logger.getInstance();
        const config = ConfigService.getConfig();
        
        // Check if Azure OpenAI is configured
        const hasAzureConfig = config.azureOpenAI?.endpoint && 
                             config.azureOpenAI?.apiKey && 
                             config.azureOpenAI?.deploymentName;

        if (hasAzureConfig) {
            this.llmProvider = new AzureOpenAIProvider();
        } else {
            this.llmProvider = new CopilotProvider(config.llmVendor, config.llmFamily);
        }
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
     * Get compatible dependencies based on LLM analysis or fallback to heuristics
     */
    async getCompatibleDependencies(projectRoot: string): Promise<Record<string, string>> {
        // Get currently installed dependencies
        const packageJsonPath = path.join(projectRoot, 'package.json');
        let installedDeps: Record<string, string> = {};
        if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            installedDeps = {
                ...packageJson.dependencies || {},
                ...packageJson.devDependencies || {}
            };
        }

        // Determine which Jest version template to use
        const existingJest = this.getExistingJestVersion(projectRoot);
        let baseDeps = JEST_DEPENDENCIES;
        if (existingJest && existingJest.major === 28) {
            this.logger.info('Detected Jest 28.x, using compatible versions');
            baseDeps = JEST_28_COMPATIBLE_DEPENDENCIES;
        } else {
            this.logger.info('Using Jest 29.x versions (default)');
        }

        // CRITICAL: Always verify essential dependencies are installed
        // ts-jest is REQUIRED for TypeScript projects, otherwise Babel will be used
        const essentialDeps = ['ts-jest', '@types/jest'];
        const missingDeps: Record<string, string> = {};
        
        for (const pkg of essentialDeps) {
            if (!installedDeps[pkg]) {
                this.logger.warn(`CRITICAL: ${pkg} is missing - TypeScript tests will fail without it`);
                missingDeps[pkg] = baseDeps[pkg as keyof typeof baseDeps] || JEST_DEPENDENCIES[pkg as keyof typeof JEST_DEPENDENCIES];
            }
        }

        // Try LLM for other dependencies (non-essential)
        this.logger.info('🧠 Using LLM to analyze project and identify missing dependencies...');
        try {
            const llmVersions = await this.getCompatibleVersionsFromLLM(projectRoot);
            if (llmVersions !== null && Object.keys(llmVersions).length > 0) {
                this.logger.info('✅ LLM analysis completed', {
                    missingCount: Object.keys(llmVersions).length,
                    packages: Object.keys(llmVersions)
                });
                // Merge with essential deps (essential deps take priority)
                return { ...llmVersions, ...missingDeps };
            }
        } catch (error) {
            this.logger.warn('❌ LLM analysis threw error, falling back to heuristics', error);
        }

        // Fallback: Use heuristic detection and filter by what's already installed
        this.logger.info('⚠️ LLM unavailable or returned empty, using heuristic detection...');
        
        // Check all base dependencies
        for (const [pkg, version] of Object.entries(baseDeps)) {
            if (!installedDeps[pkg] && !missingDeps[pkg]) {
                missingDeps[pkg] = version;
            }
        }
        
        this.logger.info('Heuristic analysis complete', {
            total: Object.keys(baseDeps).length,
            installed: Object.keys(baseDeps).length - Object.keys(missingDeps).length,
            missing: Object.keys(missingDeps).length,
            missingPackages: Object.keys(missingDeps)
        });
        
        return missingDeps;
    }
}
