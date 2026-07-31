'use strict';

const {
    SYSTEM_READINESS_CODES,
    REQUIRED_INDEXES,
    summarizeConfig,
    computeOverallStatus,
} = require('../../scripts/systemReadinessPreflight');

describe('systemReadinessPreflight', () => {
    test('declares the cross-phase readiness indexes without exposing secrets', () => {
        const names = REQUIRED_INDEXES.map((entry) => entry.name);

        expect(names).toEqual(expect.arrayContaining([
            'unique_referral_code',
            'unique_wallet_source_operation',
            'unique_referral_commission_per_deposit',
            'unique_referral_payout_idempotency_key',
            'unique_pending_reseller_application_per_user',
            'unique_order_number_non_empty',
        ]));

        REQUIRED_INDEXES.forEach((entry) => {
            expect(entry).not.toHaveProperty('connectionUri');
            expect(entry).not.toHaveProperty('credentials');
        });
    });

    test('configuration summary reports presence without values', () => {
        const summary = summarizeConfig();
        const db = summary.find((entry) => entry.key === 'db.uri');
        const jwt = summary.find((entry) => entry.key === 'jwt.secret');

        expect(db.secret).toBe(true);
        expect(jwt.secret).toBe(true);
        summary.forEach((entry) => {
            expect(entry).not.toHaveProperty('value');
        });
    });

    test('overall status is fail on any failed section and warn on warnings only', () => {
        expect(computeOverallStatus({
            data: [{ status: SYSTEM_READINESS_CODES.PASS }],
            indexes: [{ status: SYSTEM_READINESS_CODES.WARN }],
        })).toBe(SYSTEM_READINESS_CODES.WARN);

        expect(computeOverallStatus({
            data: [{ status: SYSTEM_READINESS_CODES.PASS }],
            indexes: [{ status: SYSTEM_READINESS_CODES.FAIL }],
        })).toBe(SYSTEM_READINESS_CODES.FAIL);
    });
});
