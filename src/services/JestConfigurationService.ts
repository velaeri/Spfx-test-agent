import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './Logger';

/**
 * Default Jest configuration for SPFx projects
 */
const DEFAULT_JEST_CONFIG = {
    preset: 'ts-jest',
    testEnvironment: 'jsdom',
    moduleNameMapper: {
        '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
        '\\.(jpg|jpeg|png|gif|svg)$': '<rootDir>/__mocks__/fileMock.js'
    },
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    testMatch: [
        '**/__tests__/**/*.(test|spec).ts?(x)',
        '**/?(*.)+(spec|test).ts?(x)'
    ],
    collectCoverageFrom: [
        'src/**/*.{ts,tsx}',
        '!src/**/*.d.ts',
        '!src/index.ts'
    ],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            tsconfig: {
                jsx: 'react',
                esModuleInterop: true,
                allowSyntheticDefaultImports: true
            }
        }]
    },
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json']
};

/**
 * Default jest.setup.js content
 */
const JEST_SETUP_CONTENT = `// Jest setup file
import '@testing-library/jest-dom';

// Mock SharePoint framework context if needed
global.spfxContext = {};
`;

/**
 * File mock for static assets
 */
const FILE_MOCK_CONTENT = `module.exports = 'test-file-stub';
`;

export class JestConfigurationService {
    private logger: Logger;

    constructor() {
        this.logger = Logger.getInstance();
    }

    /**
     * Check if project has a Jest configuration file
     * 
     * @param projectRoot - Project root directory
     * @returns True if jest.config.* exists
     */
    hasJestConfig(projectRoot: string): boolean {
        const configFiles = [
            'jest.config.js',
            'jest.config.ts',
            'jest.config.mjs',
            'jest.config.cjs',
            'jest.config.cts',
            'jest.config.json'
        ];

        return configFiles.some(file => 
            fs.existsSync(path.join(projectRoot, file))
        );
    }

    /**
     * Create jest.config.js
     */
    async createJestConfig(projectRoot: string): Promise<void> {
        const configPath = path.join(projectRoot, 'jest.config.js');
        const configContent = `module.exports = ${JSON.stringify(DEFAULT_JEST_CONFIG, null, 2)};
`;
        fs.writeFileSync(configPath, configContent, 'utf-8');
        this.logger.info(`Created jest.config.js at ${configPath}`);
    }

    /**
     * Create jest.setup.js
     */
    async createJestSetup(projectRoot: string): Promise<void> {
        const setupPath = path.join(projectRoot, 'jest.setup.js');
        fs.writeFileSync(setupPath, JEST_SETUP_CONTENT, 'utf-8');
        this.logger.info(`Created jest.setup.js at ${setupPath}`);
    }

    /**
     * Create __mocks__ directory with file mock
     */
    async createMockDirectory(projectRoot: string): Promise<void> {
        const mocksDir = path.join(projectRoot, '__mocks__');
        if (!fs.existsSync(mocksDir)) {
            fs.mkdirSync(mocksDir);
        }

        const fileMockPath = path.join(mocksDir, 'fileMock.js');
        if (!fs.existsSync(fileMockPath)) {
            fs.writeFileSync(fileMockPath, FILE_MOCK_CONTENT, 'utf-8');
        }

        this.logger.info(`Created __mocks__ directory at ${mocksDir}`);
    }

    /**
     * Update package.json to add test scripts
     */
    async updatePackageJsonScripts(projectRoot: string): Promise<void> {
        const packageJsonPath = path.join(projectRoot, 'package.json');
        const content = fs.readFileSync(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(content);

        if (!packageJson.scripts) {
            packageJson.scripts = {};
        }

        // Add test scripts if they don't exist
        if (!packageJson.scripts.test) {
            packageJson.scripts.test = 'jest';
        }
        if (!packageJson.scripts['test:watch']) {
            packageJson.scripts['test:watch'] = 'jest --watch';
        }
        if (!packageJson.scripts['test:coverage']) {
            packageJson.scripts['test:coverage'] = 'jest --coverage';
        }

        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf-8');
        this.logger.info('Updated package.json scripts');
    }
}
