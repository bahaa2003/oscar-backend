'use strict';

require('dotenv').config();

const path = require('path');
const { spawnSync } = require('child_process');

const READ_ONLY_PREFLIGHTS = Object.freeze([
    {
        name: 'financialTopology',
        script: 'financialTopologyPreflight.js',
        args: ['--check'],
    },
    {
        name: 'walletLedgerIdempotency',
        script: 'walletLedgerIdempotencyPreflight.js',
        args: ['--check'],
    },
    {
        name: 'depositApprovalReconciliation',
        script: 'depositApprovalReconciliationPreflight.js',
        args: ['--check'],
    },
    {
        name: 'referralPayoutReconciliation',
        script: 'referralPayoutReconciliationPreflight.js',
        args: ['--check'],
    },
    {
        name: 'resellerApplicationReconciliation',
        script: 'resellerApplicationReconciliationPreflight.js',
        args: ['--check'],
    },
    {
        name: 'resellerPricingReconciliation',
        script: 'resellerPricingReconciliationPreflight.js',
        args: ['--check'],
    },
    {
        name: 'systemReadiness',
        script: 'systemReadinessPreflight.js',
        args: ['--check'],
    },
    {
        name: 'stagingIndexRolloutDryRun',
        script: 'stagingIndexRollout.js',
        args: ['--staging', '--check'],
    },
]);

const resolveStagingUri = () => process.env.STAGING_MONGO_URI || '';

const assertOrchestratorArgs = (args = process.argv.slice(2)) => {
    if (!args.includes('--staging')) {
        throw new Error('Refusing to run without explicit --staging flag.');
    }
    if (!args.includes('--check')) {
        throw new Error('Refusing to run without explicit --check flag.');
    }
};

const buildChildEnv = (stagingUri) => ({
    ...process.env,
    NODE_ENV: 'staging',
    MONGO_URI: stagingUri,
    STAGING_MONGO_URI: stagingUri,
    DISABLE_EXTERNAL_PROVIDER_CALLS: 'true',
});

const trimOutput = (value = '') => String(value || '').trim().slice(0, 4000);

const runPreflightCommand = ({ name, script, args }, env) => {
    const child = spawnSync(
        process.execPath,
        [path.join(__dirname, script), ...args],
        {
            cwd: path.join(__dirname, '..'),
            env,
            encoding: 'utf8',
            timeout: 120000,
        }
    );

    return {
        name,
        command: `node scripts/${script} ${args.join(' ')}`,
        status: child.status === 0 ? 'PASS' : 'FAIL',
        exitCode: child.status,
        signal: child.signal,
        stdout: trimOutput(child.stdout),
        stderr: trimOutput(child.stderr),
    };
};

const runStagingReadinessOrchestrator = ({ stagingUri }) => {
    const env = buildChildEnv(stagingUri);
    const results = READ_ONLY_PREFLIGHTS.map((entry) => runPreflightCommand(entry, env));
    const failed = results.filter((result) => result.status !== 'PASS');

    return {
        checkedAt: new Date().toISOString(),
        target: {
            configured: Boolean(stagingUri),
            source: 'STAGING_MONGO_URI',
        },
        readOnly: true,
        externalProviderCalls: false,
        overallStatus: failed.length ? 'FAIL' : 'PASS',
        failedChecks: failed.map((result) => result.name),
        results,
    };
};

const main = () => {
    const args = process.argv.slice(2);
    assertOrchestratorArgs(args);

    const stagingUri = resolveStagingUri();
    if (!stagingUri) {
        console.log(JSON.stringify({
            success: false,
            code: 'NOT_RUN',
            message: 'STAGING_MONGO_URI is required. This orchestrator will not fall back to MONGO_URI.',
        }, null, 2));
        process.exitCode = 1;
        return;
    }

    const result = runStagingReadinessOrchestrator({ stagingUri });
    console.log(JSON.stringify(result, null, 2));
    if (result.overallStatus !== 'PASS') {
        process.exitCode = 1;
    }
};

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(JSON.stringify({
            success: false,
            code: err.code || 'STAGING_READINESS_ORCHESTRATOR_FAILED',
            message: err.message,
        }, null, 2));
        process.exitCode = 1;
    }
}

module.exports = {
    READ_ONLY_PREFLIGHTS,
    assertOrchestratorArgs,
    buildChildEnv,
    runStagingReadinessOrchestrator,
};
