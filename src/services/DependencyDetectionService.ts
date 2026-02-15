import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Logger } from './Logger';
import { ConfigService } from './ConfigService';
import { LLMProviderFactory } from '../factories/LLMProviderFactory';
import { ILLMProvider } from '../interfaces/ILLMProvider';
import { StackDiscoveryService, ProjectStack } from './StackDiscoveryService';
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
     * Get compatible dependencies using stack analysis + LLM + NPM VALIDATION.
     *
     * Flow:
     * 1. Run StackDiscoveryService (deterministic) to understand the project
     * 2. Enrich the package.json sent to the LLM with stack context
     * 3. Filter the LLM response to remove packages irrelevant to the detected stack
     * 4. Validate remaining versions against npm registry
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

        // ── Step 0: Deterministic stack analysis ─────────────────────
        const stackService = new StackDiscoveryService();
        let stack: ProjectStack;
        try {
            stack = await stackService.discover(projectRoot);
            this.logger.info('📊 Stack discovered', {
                framework: stack.framework,
                uiLibrary: stack.uiLibrary,
                language: stack.language,
                usesJsx: stack.usesJsx,
                testRunner: stack.testRunner
            });
        } catch (err) {
            this.logger.warn('Stack discovery failed, continuing with minimal info', err);
            stack = {
                framework: 'unknown', language: 'javascript', uiLibrary: 'none',
                componentLibrary: 'none', testRunner: 'none', packageManager: 'npm',
                moduleSystem: 'commonjs', keyDependencies: installedDeps,
                mockPatterns: [], usesJsx: false, confidence: 'low'
            };
        }

        // Inject stack summary into packageJson so the LLM receives it inside the prompt
        const enrichedPackageJson = {
            ...packageJson,
            _stackAnalysis: {
                framework: stack.framework,
                uiLibrary: stack.uiLibrary,
                language: stack.language,
                usesJsx: stack.usesJsx,
                testRunner: stack.testRunner,
                hasReact: !!installedDeps['react'],
                hasAngular: !!installedDeps['@angular/core'],
                hasVue: !!installedDeps['vue'],
            }
        };

        this.logger.info('🧠 Using LLM to detect compatible dependencies...');

        while (attempt < maxRetries) {
            attempt++;
            this.logger.info(`Attempt ${attempt}/${maxRetries}...`);

            try {
                // Step 1: LLM suggests versions (with enriched context)
                const llmVersions = await this.llmProvider.detectDependencies(
                    enrichedPackageJson,
                    lastError ? { error: lastError, attemptNumber: attempt - 1 } : undefined
                );

                if (llmVersions && Object.keys(llmVersions).length > 0) {
                    this.logger.info('✅ LLM suggested versions', {
                        count: Object.keys(llmVersions).length,
                        packages: Object.keys(llmVersions)
                    });

                    // Step 1.5: DETERMINISTIC FILTER — remove irrelevant packages
                    const filtered = this.filterByStack(llmVersions, stack, installedDeps);
                    this.logger.info('🔎 After stack filter', {
                        before: Object.keys(llmVersions).length,
                        after: Object.keys(filtered).length,
                        removed: Object.keys(llmVersions).filter(k => !(k in filtered))
                    });

                    if (Object.keys(filtered).length === 0) {
                        this.logger.info('✅ All needed dependencies already installed (after filter)');
                        return {};
                    }

                    // Step 2: VALIDATE versions against npm registry
                    this.logger.info('🔍 Validating suggested versions against npm registry...');
                    const validationErrors: string[] = [];
                    const validatedVersions = await this.validateVersionsWithNpm(filtered, validationErrors);

                    if (validationErrors.length === 0) {
                        this.logger.info('✅ All versions validated successfully');
                        return validatedVersions;
                    }

                    // Step 3: If validation failed, ask LLM to fix
                    this.logger.warn(`⚠️ Validation errors found: ${validationErrors.length} packages`);
                    this.logger.debug('Validation errors:', validationErrors);

                    const fixedVersions = await this.llmProvider.validateAndFixVersions({
                        suggestedVersions: filtered,
                        validationErrors
                    });

                    // Step 4: Validate fixed versions
                    const finalValidationErrors: string[] = [];
                    const finalVersions = await this.validateVersionsWithNpm(fixedVersions, finalValidationErrors);

                    if (finalValidationErrors.length === 0) {
                        this.logger.info('✅ Fixed versions validated successfully');
                        return finalVersions;
                    }

                    // Still have errors after LLM fix — prepare error message for retry
                    lastError = `Validation failed for packages: ${finalValidationErrors.join(', ')}`;
                    this.logger.warn(`❌ Still have validation errors after LLM fix`);
                    
                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        continue;
                    }
                } else if (Object.keys(llmVersions).length === 0) {
                    this.logger.info('✅ All dependencies already installed');
                    return {};
                }
            } catch (error) {
                lastError = error instanceof Error ? error.message : 'Unknown LLM error';
                this.logger.warn(`❌ LLM attempt ${attempt} failed: ${lastError}`);
                
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    continue;
                }
            }
        }

        // ✨ NEW: If LLM fails after retries, try "latest" strategy
        this.logger.warn('⚠️ LLM failed after 3 attempts - using latest version strategy');
        return this.getLatestCompatibleVersions(installedDeps);
    }

    /**
     * Last resort: Suggest "latest" for missing essential packages
     * This avoids hardcoded versions that may not exist
     */
    private getLatestCompatibleVersions(installedDeps: Record<string, string>): Record<string, string> {
        // Only truly universal test packages — framework/environment-specific deps
        // are handled by the LLM based on actual project analysis
        const essentialPackages = [
            'jest',
            '@types/jest',
            'ts-jest'
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

    /**
     * Validate package versions against npm registry
     * Returns only valid versions, populates errors array for invalid ones
     */
    private async validateVersionsWithNpm(
        versions: Record<string, string>, 
        errors: string[]
    ): Promise<Record<string, string>> {
        const validVersions: Record<string, string> = {};
        const validationPromises: Promise<void>[] = [];

        for (const [pkg, version] of Object.entries(versions)) {
            // Skip validation for "latest" - npm will always resolve it
            if (version === 'latest') {
                validVersions[pkg] = version;
                continue;
            }

            const validationPromise = this.checkPackageVersionExists(pkg, version)
                .then(exists => {
                    if (exists) {
                        validVersions[pkg] = version;
                        this.logger.debug(`✅ ${pkg}@${version} exists in npm`);
                    } else {
                        errors.push(`${pkg}@${version} not found in npm registry`);
                        this.logger.warn(`❌ ${pkg}@${version} does NOT exist in npm`);
                    }
                })
                .catch(error => {
                    errors.push(`Failed to validate ${pkg}@${version}: ${error.message}`);
                    this.logger.error(`Failed to validate ${pkg}@${version}`, error);
                });

            validationPromises.push(validationPromise);
        }

        // Wait for all validations
        await Promise.all(validationPromises);

        return validVersions;
    }

    /**
     * Check if a specific package@version exists in npm registry
     */
    private async checkPackageVersionExists(packageName: string, version: string): Promise<boolean> {
        return new Promise((resolve) => {
            // Clean version string (remove ^, ~, etc.)
            const cleanVersion = version.replace(/^[\^~>=<]/, '');

            // Use npm view to check if package@version exists
            const child = spawn('npm', ['view', `${packageName}@${cleanVersion}`, 'version'], {
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                if (code === 0 && stdout.trim().length > 0) {
                    // Package version exists
                    resolve(true);
                } else if (stderr.includes('E404') || stderr.includes('ETARGET') || stderr.includes('notarget')) {
                    // Package or version not found
                    resolve(false);
                } else {
                    // Other errors (network, etc.) - assume valid to avoid blocking
                    this.logger.warn(`Could not validate ${packageName}@${version}, assuming valid`);
                    resolve(true);
                }
            });

            child.on('error', (error) => {
                this.logger.error(`Error validating ${packageName}@${version}`, error);
                // On error, assume valid to avoid blocking installation
                resolve(true);
            });

            // Timeout after 5 seconds per package
            setTimeout(() => {
                child.kill();
                this.logger.warn(`Validation timeout for ${packageName}@${version}, assuming valid`);
                resolve(true);
            }, 5000);
        });
    }

    // ── Deterministic post-LLM filter ────────────────────────────

    /**
     * Remove packages from the LLM suggestion that are irrelevant to this project's stack.
     * This is a hard guardrail — even if the LLM hallucinates, we won't install nonsense.
     */
    private filterByStack(
        suggestedVersions: Record<string, string>,
        stack: ProjectStack,
        installedDeps: Record<string, string>
    ): Record<string, string> {
        const hasReact = !!installedDeps['react'];
        const hasAngular = !!installedDeps['@angular/core'];
        const hasVue = !!installedDeps['vue'];
        const needsBrowser = hasReact || hasAngular || hasVue ||
            stack.framework === 'spfx' || stack.framework === 'next' ||
            stack.usesJsx;

        // Packages that require React
        const reactOnly = new Set([
            '@testing-library/react',
            'react-test-renderer',
            '@types/react-test-renderer',
        ]);

        // Packages that only make sense for browser/DOM projects
        const browserOnly = new Set([
            'jest-environment-jsdom',
            'identity-obj-proxy',
            '@testing-library/jest-dom',
        ]);

        // Packages that require Angular
        const angularOnly = new Set([
            '@angular/compiler-cli',
            'jest-preset-angular',
        ]);

        // Packages that require Vue
        const vueOnly = new Set([
            '@testing-library/vue',
            '@vue/test-utils',
        ]);

        const filtered: Record<string, string> = {};

        for (const [pkg, version] of Object.entries(suggestedVersions)) {
            // Skip already-installed packages
            if (installedDeps[pkg]) {
                this.logger.debug(`Skipping ${pkg}: already installed (${installedDeps[pkg]})`);
                continue;
            }

            // React-specific: remove if no React
            if (reactOnly.has(pkg) && !hasReact) {
                this.logger.info(`🚫 Filtered out ${pkg}: project has no React dependency`);
                continue;
            }

            // Browser/DOM-specific: remove if no browser need
            if (browserOnly.has(pkg) && !needsBrowser) {
                this.logger.info(`🚫 Filtered out ${pkg}: project has no browser/DOM need`);
                continue;
            }

            // Angular-specific
            if (angularOnly.has(pkg) && !hasAngular) {
                this.logger.info(`🚫 Filtered out ${pkg}: project has no Angular dependency`);
                continue;
            }

            // Vue-specific
            if (vueOnly.has(pkg) && !hasVue) {
                this.logger.info(`🚫 Filtered out ${pkg}: project has no Vue dependency`);
                continue;
            }

            filtered[pkg] = version;
        }

        return filtered;
    }
}
