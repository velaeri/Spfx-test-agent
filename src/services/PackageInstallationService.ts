import { spawn } from 'child_process';
import { Logger } from './Logger';

export interface InstallResult {
    success: boolean;
    error?: string;
}

export class PackageInstallationService {
    private logger: Logger;

    constructor() {
        this.logger = Logger.getInstance();
    }

    /**
     * Install dependencies using npm
     * @param projectRoot Root directory of the project
     * @param packagesWithVersions List of packages with versions (e.g. ['jest@^29.7.0', 'ts-jest@^29.1.1'])
     * @returns Promise with success status and error message if failed
     */
    async installPackages(projectRoot: string, packagesWithVersions: string[]): Promise<InstallResult> {
        this.logger.info(`Installing packages: ${packagesWithVersions.join(', ')}`);

        return new Promise((resolve) => {
            // Use --legacy-peer-deps to avoid peer dependency conflicts
            const npmProcess = spawn('npm', ['install', '--save-dev', '--legacy-peer-deps', ...packagesWithVersions], {
                cwd: projectRoot,
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let output = '';
            npmProcess.stdout?.on('data', (data) => {
                output += data.toString();
            });

            npmProcess.stderr?.on('data', (data) => {
                output += data.toString();
            });

            npmProcess.on('close', (code) => {
                if (code === 0) {
                    this.logger.info('Dependencies installed successfully');
                    resolve({ success: true });
                } else {
                    this.logger.error('npm install failed', new Error(output));
                    resolve({ success: false, error: output });
                }
            });

            npmProcess.on('error', (error) => {
                this.logger.error('Failed to spawn npm process', error);
                resolve({ success: false, error: error.message });
            });
        });
    }
}
