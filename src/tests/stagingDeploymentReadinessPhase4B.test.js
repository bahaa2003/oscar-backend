'use strict';

const {
    INDEX_ROLLOUTS,
    assertStagingArgs,
    assertSafeDatabaseName,
    redactMongoUri,
} = require('../../scripts/stagingIndexRollout');

const {
    READ_ONLY_PREFLIGHTS,
    assertOrchestratorArgs,
    buildChildEnv,
} = require('../../scripts/stagingReadinessOrchestrator');

describe('Phase 4B staging deployment readiness package', () => {
    test('staging index rollout requires explicit staging and mode flags', () => {
        expect(() => assertStagingArgs(['--check'])).toThrow('--staging');
        expect(() => assertStagingArgs(['--staging'])).toThrow('--check');
        expect(() => assertStagingArgs(['--staging', '--check', '--apply'])).toThrow('either');
        expect(() => assertStagingArgs(['--staging', '--check'])).not.toThrow();
    });

    test('staging index rollout refuses production-like database names', () => {
        expect(() => assertSafeDatabaseName('oscar_staging')).not.toThrow();
        expect(() => assertSafeDatabaseName('oscar_production')).toThrow('production-like');
        expect(() => assertSafeDatabaseName('live')).toThrow('production-like');
    });

    test('staging index rollout declares required unique financial indexes and redacts credentials', () => {
        const indexNames = INDEX_ROLLOUTS.map((entry) => entry.name);
        expect(indexNames).toEqual(expect.arrayContaining([
            'unique_referral_code',
            'unique_wallet_source_operation',
            'unique_referral_commission_per_deposit',
            'unique_referral_payout_idempotency_key',
            'unique_pending_reseller_application_per_user',
            'unique_order_number_non_empty',
        ]));

        const redacted = redactMongoUri('mongodb+srv://stagingUser:secretValue@example.mongodb.net/oscar_staging');
        expect(redacted).not.toContain('stagingUser');
        expect(redacted).not.toContain('secretValue');
        expect(redacted).toContain('REDACTED');
    });

    test('staging orchestrator runs only read-only preflight commands', () => {
        expect(() => assertOrchestratorArgs(['--staging'])).toThrow('--check');
        expect(() => assertOrchestratorArgs(['--staging', '--check'])).not.toThrow();

        const commandArgs = READ_ONLY_PREFLIGHTS.flatMap((entry) => entry.args);
        expect(commandArgs).toContain('--check');
        expect(commandArgs).not.toContain('--apply');
        expect(commandArgs).not.toContain('--fix');

        const env = buildChildEnv('mongodb://example.invalid/oscar_staging');
        expect(env.NODE_ENV).toBe('staging');
        expect(env.MONGO_URI).toBe('mongodb://example.invalid/oscar_staging');
        expect(env.DISABLE_EXTERNAL_PROVIDER_CALLS).toBe('true');
    });
});
