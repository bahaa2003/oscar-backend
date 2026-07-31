'use strict';

const mongoose = require('mongoose');
const {
    PAYOUT_RECONCILIATION_CODES,
    classifyReferralPayoutState,
} = require('../../scripts/referralPayoutReconciliationPreflight');

const id = () => new mongoose.Types.ObjectId();

describe('Phase 2E referral payout reconciliation preflight classifier', () => {
    test('classifies healthy pending, rejected, wallet-paid, and manual-paid states', () => {
        const payoutId = id();
        const referrerId = id();
        const commissionId = id();
        const basePayout = {
            _id: payoutId,
            referrerId,
            commissionIds: [commissionId],
            amountUsd: '5.00',
        };
        const lockedCommission = {
            _id: commissionId,
            referrerId,
            status: 'LOCKED',
            payoutRequestId: payoutId,
            commissionAmountUsd: '5.00',
        };
        const paidCommission = { ...lockedCommission, status: 'PAID' };

        expect(classifyReferralPayoutState({
            payout: { ...basePayout, status: 'PENDING', method: 'WALLET' },
            commissions: [lockedCommission],
            walletLedgers: [],
        })).toBe(PAYOUT_RECONCILIATION_CODES.HEALTHY_PENDING);

        expect(classifyReferralPayoutState({
            payout: { ...basePayout, status: 'REJECTED', method: 'WALLET' },
            commissions: [{ ...lockedCommission, status: 'AVAILABLE', payoutRequestId: null }],
            walletLedgers: [],
        })).toBe(PAYOUT_RECONCILIATION_CODES.HEALTHY_REJECTED);

        expect(classifyReferralPayoutState({
            payout: { ...basePayout, status: 'PAID', method: 'WALLET' },
            commissions: [paidCommission],
            walletLedgers: [{ amount: 5 }],
        })).toBe(PAYOUT_RECONCILIATION_CODES.HEALTHY_PAID_WALLET);

        expect(classifyReferralPayoutState({
            payout: { ...basePayout, status: 'PAID', method: 'MANUAL', externalReference: 'MANUAL-1' },
            commissions: [paidCommission],
            walletLedgers: [],
        })).toBe(PAYOUT_RECONCILIATION_CODES.HEALTHY_PAID_MANUAL);
    });

    test('classifies blocking payout reconciliation states without writes', () => {
        const payoutId = id();
        const referrerId = id();
        const commissionId = id();
        const payout = {
            _id: payoutId,
            referrerId,
            commissionIds: [commissionId],
            amountUsd: '5.00',
            status: 'PENDING',
            method: 'WALLET',
        };

        expect(classifyReferralPayoutState({ payout, commissions: [], walletLedgers: [] }))
            .toBe(PAYOUT_RECONCILIATION_CODES.PENDING_WITH_MISSING_COMMISSION);
        expect(classifyReferralPayoutState({
            payout,
            commissions: [{
                _id: commissionId,
                referrerId,
                status: 'AVAILABLE',
                payoutRequestId: null,
                commissionAmountUsd: '5.00',
            }],
            walletLedgers: [],
        })).toBe(PAYOUT_RECONCILIATION_CODES.PENDING_WITH_AVAILABLE_COMMISSION);
        expect(classifyReferralPayoutState({
            payout,
            commissions: [{
                _id: commissionId,
                referrerId,
                status: 'LOCKED',
                payoutRequestId: payoutId,
                commissionAmountUsd: '4.99',
            }],
            walletLedgers: [],
        })).toBe(PAYOUT_RECONCILIATION_CODES.TOTAL_MISMATCH);
    });
});
