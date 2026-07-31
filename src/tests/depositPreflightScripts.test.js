'use strict';

const mongoose = require('mongoose');
const { DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const { TRANSACTION_TYPES } = require('../modules/wallet/walletTransaction.model');
const {
    classifyDepositApprovalState,
} = require('../../scripts/depositApprovalReconciliationPreflight');
const {
    classifyWalletLedgerSourceGroup,
} = require('../../scripts/walletLedgerIdempotencyPreflight');

const userId = new mongoose.Types.ObjectId();
const depositId = new mongoose.Types.ObjectId();

const makeDeposit = (overrides = {}) => ({
    _id: depositId,
    userId,
    status: DEPOSIT_STATUS.APPROVED,
    requestedAmount: 500,
    amountUsd: 10,
    ...overrides,
});

const makeLedger = (overrides = {}) => ({
    userId,
    type: TRANSACTION_TYPES.CREDIT,
    amount: 10,
    reference: depositId,
    ...overrides,
});

describe('Phase 2B preflight classifiers', () => {
    it('classifies approved deposit reconciliation states', () => {
        expect(classifyDepositApprovalState({
            deposit: makeDeposit(),
            ledgers: [makeLedger()],
        })).toBe('HEALTHY_APPROVED');

        expect(classifyDepositApprovalState({
            deposit: makeDeposit(),
            ledgers: [],
        })).toBe('APPROVED_WITHOUT_LEDGER');

        expect(classifyDepositApprovalState({
            deposit: makeDeposit(),
            ledgers: [makeLedger(), makeLedger({ amount: 10 })],
        })).toBe('APPROVED_WITH_MULTIPLE_LEDGERS');

        expect(classifyDepositApprovalState({
            deposit: makeDeposit(),
            ledgers: [makeLedger({ amount: 7 })],
        })).toBe('APPROVED_WITH_LEDGER_AMOUNT_MISMATCH');
    });

    it('classifies pending and rejected deposit ledger anomalies', () => {
        expect(classifyDepositApprovalState({
            deposit: makeDeposit({ status: DEPOSIT_STATUS.PENDING }),
            ledgers: [makeLedger()],
        })).toBe('PENDING_WITH_EXISTING_LEDGER');

        expect(classifyDepositApprovalState({
            deposit: makeDeposit({ status: DEPOSIT_STATUS.REJECTED }),
            ledgers: [makeLedger()],
        })).toBe('REJECTED_WITH_CREDIT_LEDGER');

        expect(classifyDepositApprovalState({
            deposit: makeDeposit({ status: DEPOSIT_STATUS.PENDING }),
            ledgers: [],
        })).toBe('UNKNOWN');
    });

    it('classifies wallet source operation idempotency groups', () => {
        expect(classifyWalletLedgerSourceGroup({
            count: 1,
            hasCompleteSourceIdentity: true,
        })).toBe('UNIQUE_SOURCE_OPERATION');

        expect(classifyWalletLedgerSourceGroup({
            count: 2,
            hasCompleteSourceIdentity: true,
        })).toBe('DUPLICATE_SOURCE_OPERATION');

        expect(classifyWalletLedgerSourceGroup({
            count: 1,
            hasCompleteSourceIdentity: false,
        })).toBe('LEGACY_OR_INCOMPLETE_SOURCE_IDENTITY');
    });
});
