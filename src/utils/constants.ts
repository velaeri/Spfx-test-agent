/**
 * DEPRECATED: Hardcoded dependencies removed in v0.5.0 (LLM-First Architecture)
 * 
 * The extension now uses LLM to dynamically detect compatible versions.
 * If LLM fails after retries, npm "latest" strategy is used instead of fixed versions.
 * 
 * This file is kept for backward compatibility but constants are no longer used.
 */

// These constants are NO LONGER USED since v0.5.0
// Left here only for reference - DO NOT USE
export const JEST_DEPENDENCIES_DEPRECATED = {
    'jest': '^29.7.0',
    '@types/jest': '^29.5.11',
    'ts-jest': '^29.1.1',
    '@testing-library/react': '^14.1.2',
    '@testing-library/jest-dom': '^6.1.5',
    '@testing-library/user-event': '^14.5.1',
    'react-test-renderer': '^17.0.1',
    '@types/react-test-renderer': '^17.0.1',
    'identity-obj-proxy': '^3.0.0'
};

export const JEST_28_COMPATIBLE_DEPENDENCIES_DEPRECATED = {
    'jest': '^28.1.0',
    '@types/jest': '^28.1.0',
    'ts-jest': '^28.0.8',
    '@testing-library/react': '^13.4.0',
    '@testing-library/jest-dom': '^5.16.5',
    '@testing-library/user-event': '^14.4.3',
    'react-test-renderer': '^17.0.1',
    '@types/react-test-renderer': '^17.0.1',
    'identity-obj-proxy': '^3.0.0'
};

