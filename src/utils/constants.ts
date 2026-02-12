/**
 * Required Jest dependencies for SPFx projects
 * These are FALLBACK versions used only when LLM is unavailable
 */
export const JEST_DEPENDENCIES = {
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

/**
 * Compatible versions for Jest 28.x (FALLBACK for SPFx 1.18.x when LLM unavailable)
 */
export const JEST_28_COMPATIBLE_DEPENDENCIES = {
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
