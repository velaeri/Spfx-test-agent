export {
    RULES,
    QUALITY_GATES,
    TIERS,
    MOCK_BOUNDARIES,
    SKIP_PATTERNS,
    shouldSkipFile,
    classifyTier,
    evaluateQualityGates,
    getPolicyText,
} from './GoldenPolicy';

export type {
    PolicyRule,
    QualityGate,
    TierDefinition,
    QualityGateResult,
} from './GoldenPolicy';
