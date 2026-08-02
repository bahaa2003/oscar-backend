'use strict';

const mongoose = require('mongoose');
const {
    DepositRequest,
    DEPOSIT_STATUS,
    REFERRAL_COMMISSION_EVALUATION_OUTCOME,
} = require('./deposit.model');
const { User, USER_STATUS } = require('../users/user.model');
const {
    creditWalletDirect,
    TRANSACTION_SOURCE_TYPES,
    TRANSACTION_OPERATIONS,
} = require('../wallet/wallet.service');
const { WalletTransaction, TRANSACTION_TYPES } = require('../wallet/walletTransaction.model');
const {
    ReferralCommission,
} = require('../referrals/referralCommission.model');
const {
    evaluateDepositCommission,
    createDepositCommission,
    toMoneyString,
    toRateString,
} = require('../referrals/referralCommission.service');
const { getConversionRate } = require('../../services/currencyConverter.service');
// Deposit approval credits the USD snapshot (`amountUsd`) into the platform wallet.
const {
    NotFoundError,
    BusinessRuleError,
    AuthorizationError,
} = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { DEPOSIT_ACTIONS, WALLET_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const { notifyNewDeposit, notifyDepositApproved, notifyDepositRejected } = require('../notifications/notification.service');
const whatsappService = require('../whatsapp/whatsapp.service');

const APPROVAL_TRANSACTION_OPTIONS = Object.freeze({
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
    readPreference: 'primary',
});

const MAX_DEPOSIT_TRANSACTION_ATTEMPTS = 3;

const DEPOSIT_RECONCILIATION_CODES = Object.freeze({
    HEALTHY_APPROVED: 'HEALTHY_APPROVED',
    APPROVED_WITHOUT_LEDGER: 'APPROVED_WITHOUT_LEDGER',
    APPROVED_WITH_MULTIPLE_LEDGERS: 'APPROVED_WITH_MULTIPLE_LEDGERS',
    APPROVED_WITH_LEDGER_AMOUNT_MISMATCH: 'APPROVED_WITH_LEDGER_AMOUNT_MISMATCH',
    PENDING_WITH_EXISTING_LEDGER: 'PENDING_WITH_EXISTING_LEDGER',
    REJECTED_WITH_CREDIT_LEDGER: 'REJECTED_WITH_CREDIT_LEDGER',
    APPROVED_COMMISSION_MISSING: 'APPROVED_COMMISSION_MISSING',
    APPROVED_COMMISSION_DUPLICATE: 'APPROVED_COMMISSION_DUPLICATE',
    APPROVED_COMMISSION_MISMATCH: 'APPROVED_COMMISSION_MISMATCH',
    APPROVED_COMMISSION_UNEXPECTED: 'APPROVED_COMMISSION_UNEXPECTED',
    PENDING_WITH_EXISTING_COMMISSION: 'PENDING_WITH_EXISTING_COMMISSION',
    REJECTED_WITH_EXISTING_COMMISSION: 'REJECTED_WITH_EXISTING_COMMISSION',
    UNKNOWN: 'UNKNOWN',
});

let approvalTestHooks = {};

const __setDepositApprovalTestHooks = (hooks = {}) => {
    approvalTestHooks = hooks || {};
};

const runApprovalTestHook = async (name, payload) => {
    if (process.env.NODE_ENV !== 'test') return;
    if (typeof approvalTestHooks[name] === 'function') {
        await approvalTestHooks[name](payload);
    }
};

const safeParseJson = (value) => {
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch (_) {
        return null;
    }
};

const normalizeSenderDetails = (source = {}) => {
    const rawDetails = source.senderDetails && typeof source.senderDetails === 'object'
        ? source.senderDetails
        : safeParseJson(source.senderDetails);
    const details = rawDetails && typeof rawDetails === 'object' ? rawDetails : {};
    const value = String(
        details.value
        || source.senderDetailValue
        || source.senderWalletAddress
        || source.senderWalletNumber
        || source.transferredFromNumber
        || ''
    ).trim();

    if (!value) return null;

    const methodType = String(
        details.methodType
        || details.type
        || source.paymentMethodType
        || ''
    ).trim().toLowerCase();
    const field = String(
        details.field
        || source.senderDetailField
        || (source.senderWalletAddress ? 'senderWalletAddress' : 'senderWalletNumber')
    ).trim();
    const label = String(
        details.label
        || (field === 'senderWalletAddress' || methodType === 'usdt'
            ? 'عنوان المحفظة المحول منها'
            : 'رقم المحفظة المحول منها')
    ).trim();

    return {
        methodType: methodType.slice(0, 64),
        field: field.slice(0, 64),
        label: label.slice(0, 128),
        value: value.slice(0, 200),
    };
};

// =============================================================================
// CREATE
// =============================================================================

/**
 * Customer creates a new deposit request (multi-currency).
 *
 * Business rules:
 *   - User must exist and be ACTIVE (enforced upstream by requireActiveUser middleware).
 *   - requestedAmount must be > 0 (enforced by schema).
 *   - amountUsd is pre-calculated by the controller using the frozen exchangeRate.
 *   - No wallet credit at this stage; the request is PENDING until admin review.
 *   - Multiple concurrent PENDING deposits are allowed.
 *
 * Audit: DEPOSIT_REQUESTED — fire-and-forget after save.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.userId
 * @param {string}          params.paymentMethodId
 * @param {number}          params.requestedAmount
 * @param {string}          params.currency
 * @param {number}          params.exchangeRate
 * @param {number}          params.amountUsd
 * @param {string}          params.receiptImage
 * @param {string|null}     [params.notes]
 * @param {Object|null}     [params.senderDetails]
 * @param {Object|null}     [params.auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const createDepositRequest = async ({
    userId,
    paymentMethodId,
    requestedAmount,
    currency,
    exchangeRate,
    amountUsd,
    receiptImage,
    notes = null,
    senderDetails = null,
    auditContext = null,
}) => {
    // Confirm user exists (belt-and-suspenders — middleware already checks ACTIVE)
    const user = await User.findById(userId).select('_id role name email');
    if (!user) throw new NotFoundError('User');

    const deposit = await DepositRequest.create({
        userId,
        paymentMethodId,
        requestedAmount: Number(parseFloat(requestedAmount).toFixed(2)),
        currency,
        exchangeRate,
        amountUsd: Number(parseFloat(amountUsd).toFixed(2)),
        receiptImage,
        notes,
        senderDetails,
        status: DEPOSIT_STATUS.PENDING,
    });

    // Audit: fire-and-forget
    createAuditLog({
        actorId: auditContext?.actorId ?? userId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.CUSTOMER,
        action: DEPOSIT_ACTIONS.REQUESTED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            userId: userId.toString(),
            paymentMethodId,
            requestedAmount: deposit.requestedAmount,
            currency,
            exchangeRate,
            amountUsd: deposit.amountUsd,
            senderDetails,
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    notifyNewDeposit(deposit);

    try {
        whatsappService.sendAdminNotification(
            `💰 *طلب شحن رصيد!*\nالمستخدم: ${user.name || user.email || userId}\nالمبلغ: ${deposit.requestedAmount} ${deposit.currency}\nوسيلة الدفع: ${paymentMethodId}`
        ).catch((err) => {
            console.error('WhatsApp Notification failed:', err.message);
        });
    } catch (err) {
        console.error('WhatsApp Notification failed:', err.message);
    }

    return deposit;
};

const roundMoney = (value, decimals = 2) => Number(Number(value).toFixed(decimals));

const amountsMatch = (left, right) => (
    Number.isFinite(Number(left))
    && Number.isFinite(Number(right))
    && Math.abs(Number(left) - Number(right)) < 0.005
);

const normalizeApprovalOverrides = (adminOverrides = {}) => (
    adminOverrides !== null
    && typeof adminOverrides === 'object'
    && !Array.isArray(adminOverrides)
)
    ? adminOverrides
    : { amount: adminOverrides };

const isMongoDuplicateKeyError = (err) => err?.code === 11000;

const hasMongoErrorLabel = (err, label) => (
    typeof err?.hasErrorLabel === 'function'
        ? err.hasErrorLabel(label)
        : Array.isArray(err?.errorLabels) && err.errorLabels.includes(label)
);

const isTransactionUnavailableError = (err) => {
    const message = String(err?.message || '');
    return err?.codeName === 'IllegalOperation'
        || /transaction numbers are only allowed/i.test(message)
        || /transactions are not supported/i.test(message)
        || /replica set/i.test(message)
        || /client session/i.test(message);
};

const makeReconciliationError = (classification) => new BusinessRuleError(
    `Deposit approval requires manual reconciliation (${classification}).`,
    'DEPOSIT_RECONCILIATION_REQUIRED'
);

const makeRetryExhaustedError = () => new BusinessRuleError(
    'Deposit approval transaction retry attempts were exhausted.',
    'DEPOSIT_APPROVAL_RETRY_EXHAUSTED'
);

const withBoundedApprovalTransactionRetry = async (session, transactionFn) => {
    for (let attempt = 1; attempt <= MAX_DEPOSIT_TRANSACTION_ATTEMPTS; attempt += 1) {
        try {
            return await session.withTransaction(transactionFn, APPROVAL_TRANSACTION_OPTIONS);
        } catch (err) {
            if (!hasMongoErrorLabel(err, 'TransientTransactionError')) {
                throw err;
            }
            if (attempt === MAX_DEPOSIT_TRANSACTION_ATTEMPTS) {
                throw makeRetryExhaustedError();
            }
        }
    }

    throw makeRetryExhaustedError();
};

const populateDepositForReturn = (depositId) => DepositRequest.findById(depositId)
    .populate('userId', 'name email avatar currency walletBalance')
    .populate('reviewedBy', 'name email');

const selectDepositForApproval = (query) => query.select('+referralCommissionEvaluation');

const findDepositCreditLedgers = async (deposit, session = null) => {
    if (!deposit?._id || !deposit?.userId) return [];

    const query = WalletTransaction.find({
        userId: deposit.userId,
        type: TRANSACTION_TYPES.CREDIT,
        $or: [
            {
                sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
                sourceId: deposit._id,
                operation: TRANSACTION_OPERATIONS.CREDIT,
            },
            {
                reference: deposit._id,
                $or: [
                    { sourceType: null },
                    { sourceType: { $exists: false } },
                ],
            },
        ],
    }).sort({ createdAt: 1 });

    if (session) query.session(session);
    return query;
};

const findDepositCommissions = async (deposit, session = null) => {
    if (!deposit?._id) return [];

    const query = ReferralCommission.find({ depositId: deposit._id }).sort({ createdAt: 1 });
    if (session) query.session(session);
    return query;
};

const commissionMatchesEvaluation = ({ deposit, ledger, commission }) => {
    const evaluation = deposit.referralCommissionEvaluation;
    if (!evaluation || evaluation.outcome !== REFERRAL_COMMISSION_EVALUATION_OUTCOME.CREATED) {
        return false;
    }

    return objectIdsMatch(commission._id, evaluation.commissionId)
        && objectIdsMatch(commission.depositId, deposit._id)
        && objectIdsMatch(commission.referrerId, evaluation.referrerId)
        && objectIdsMatch(commission.referredUserId, deposit.userId)
        && objectIdsMatch(commission.walletTransactionId, ledger?._id)
        && commission.sourceAmount === toMoneyString(deposit.requestedAmount)
        && commission.sourceCurrency === deposit.currency
        && commission.sourceExchangeRate === toRateString(deposit.exchangeRate)
        && commission.sourceAmountUsd === toMoneyString(deposit.amountUsd)
        && commission.commissionRatePercent === evaluation.ratePercent
        && commission.commissionAmountUsd === evaluation.amountUsd
        && commission.commissionCurrency === (evaluation.currency || 'USD')
        && (evaluation.amount == null || commission.commissionAmount === evaluation.amount)
        && (evaluation.referrerExchangeRateFromUsd == null || commission.referrerExchangeRateFromUsd === evaluation.referrerExchangeRateFromUsd)
        && (
            !evaluation.eligibilityWindowEndsAt
            || (
                commission.eligibilityWindowEndsAt
                && new Date(commission.eligibilityWindowEndsAt).getTime() === new Date(evaluation.eligibilityWindowEndsAt).getTime()
            )
        )
        && ['v1', 'v2'].includes(commission.calculationVersion)
        && commission.policySource === 'ENV_REFERRAL_COMMISSION'
        && commission.idempotencyKey === `deposit:${deposit._id}:referral-commission:v1`;
};

const objectIdsMatch = (left, right) => (
    left != null
    && right != null
    && String(left) === String(right)
);

const classifyReferralCommissionState = ({ deposit, ledger, commissions = [] }) => {
    const evaluation = deposit?.referralCommissionEvaluation || null;

    if (deposit?.status === DEPOSIT_STATUS.PENDING && commissions.length > 0) {
        return DEPOSIT_RECONCILIATION_CODES.PENDING_WITH_EXISTING_COMMISSION;
    }

    if (deposit?.status === DEPOSIT_STATUS.REJECTED && commissions.length > 0) {
        return DEPOSIT_RECONCILIATION_CODES.REJECTED_WITH_EXISTING_COMMISSION;
    }

    if (deposit?.status !== DEPOSIT_STATUS.APPROVED) {
        return DEPOSIT_RECONCILIATION_CODES.UNKNOWN;
    }

    if (!evaluation) {
        return commissions.length > 0
            ? DEPOSIT_RECONCILIATION_CODES.APPROVED_COMMISSION_UNEXPECTED
            : DEPOSIT_RECONCILIATION_CODES.HEALTHY_APPROVED;
    }

    if (
        evaluation.outcome === REFERRAL_COMMISSION_EVALUATION_OUTCOME.DISABLED
        || evaluation.outcome === REFERRAL_COMMISSION_EVALUATION_OUTCOME.NOT_ELIGIBLE
    ) {
        return commissions.length > 0
            ? DEPOSIT_RECONCILIATION_CODES.APPROVED_COMMISSION_UNEXPECTED
            : DEPOSIT_RECONCILIATION_CODES.HEALTHY_APPROVED;
    }

    if (evaluation.outcome === REFERRAL_COMMISSION_EVALUATION_OUTCOME.CREATED) {
        if (commissions.length === 0) {
            return DEPOSIT_RECONCILIATION_CODES.APPROVED_COMMISSION_MISSING;
        }
        if (commissions.length > 1) {
            return DEPOSIT_RECONCILIATION_CODES.APPROVED_COMMISSION_DUPLICATE;
        }
        if (!commissionMatchesEvaluation({ deposit, ledger, commission: commissions[0] })) {
            return DEPOSIT_RECONCILIATION_CODES.APPROVED_COMMISSION_MISMATCH;
        }
        return DEPOSIT_RECONCILIATION_CODES.HEALTHY_APPROVED;
    }

    return DEPOSIT_RECONCILIATION_CODES.APPROVED_COMMISSION_MISMATCH;
};

const classifyDepositApprovalState = ({ deposit, ledgers = [], commissions = [] }) => {
    if (!deposit) return DEPOSIT_RECONCILIATION_CODES.UNKNOWN;

    const creditLedgers = (ledgers || []).filter((ledger) => ledger?.type === TRANSACTION_TYPES.CREDIT);

    if (deposit.status === DEPOSIT_STATUS.APPROVED) {
        if (creditLedgers.length === 0) {
            return DEPOSIT_RECONCILIATION_CODES.APPROVED_WITHOUT_LEDGER;
        }
        if (creditLedgers.length > 1) {
            return DEPOSIT_RECONCILIATION_CODES.APPROVED_WITH_MULTIPLE_LEDGERS;
        }

        const [ledger] = creditLedgers;
        if (
            !amountsMatch(ledger.amount, deposit.amountUsd)
            && !amountsMatch(ledger.amount, deposit.requestedAmount)
        ) {
            return DEPOSIT_RECONCILIATION_CODES.APPROVED_WITH_LEDGER_AMOUNT_MISMATCH;
        }

        return classifyReferralCommissionState({
            deposit,
            ledger,
            commissions,
        });
    }

    if (deposit.status === DEPOSIT_STATUS.PENDING && creditLedgers.length > 0) {
        return DEPOSIT_RECONCILIATION_CODES.PENDING_WITH_EXISTING_LEDGER;
    }

    if (deposit.status === DEPOSIT_STATUS.PENDING && commissions.length > 0) {
        return DEPOSIT_RECONCILIATION_CODES.PENDING_WITH_EXISTING_COMMISSION;
    }

    if (deposit.status === DEPOSIT_STATUS.REJECTED && creditLedgers.length > 0) {
        return DEPOSIT_RECONCILIATION_CODES.REJECTED_WITH_CREDIT_LEDGER;
    }

    if (deposit.status === DEPOSIT_STATUS.REJECTED && commissions.length > 0) {
        return DEPOSIT_RECONCILIATION_CODES.REJECTED_WITH_EXISTING_COMMISSION;
    }

    return DEPOSIT_RECONCILIATION_CODES.UNKNOWN;
};

const resolveExistingApproval = async (deposit, session = null) => {
    const [ledgers, commissions] = await Promise.all([
        findDepositCreditLedgers(deposit, session),
        findDepositCommissions(deposit, session),
    ]);
    const classification = classifyDepositApprovalState({ deposit, ledgers, commissions });

    if (
        deposit.status === DEPOSIT_STATUS.APPROVED
        && classification === DEPOSIT_RECONCILIATION_CODES.HEALTHY_APPROVED
    ) {
        return {
            depositId: deposit._id,
            idempotent: true,
            classification,
        };
    }

    if (deposit.status === DEPOSIT_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'A rejected deposit cannot be approved. Create a new request.',
            'DEPOSIT_ALREADY_REJECTED'
        );
    }

    if (classification !== DEPOSIT_RECONCILIATION_CODES.UNKNOWN) {
        throw makeReconciliationError(classification);
    }

    throw new BusinessRuleError(
        'Deposit approval state changed before the request could be claimed.',
        'DEPOSIT_APPROVAL_CONFLICT'
    );
};

const classifyUnknownCommitResult = async (depositId) => {
    const deposit = await selectDepositForApproval(DepositRequest.findById(depositId));
    if (!deposit) throw new NotFoundError('DepositRequest');

    const [ledgers, commissions] = await Promise.all([
        findDepositCreditLedgers(deposit),
        findDepositCommissions(deposit),
    ]);
    const classification = classifyDepositApprovalState({ deposit, ledgers, commissions });

    if (classification === DEPOSIT_RECONCILIATION_CODES.HEALTHY_APPROVED) {
        return {
            committed: true,
            depositId: deposit._id,
            classification,
        };
    }

    if (
        deposit.status === DEPOSIT_STATUS.PENDING
        && ledgers.length === 0
        && commissions.length === 0
    ) {
        throw new BusinessRuleError(
            'Deposit approval commit result is unknown and appears retryable.',
            'DEPOSIT_APPROVAL_RETRYABLE'
        );
    }

    throw makeReconciliationError(classification);
};

const resolveApprovalAfterRetryExhaustion = async (depositId, retryError) => {
    const deposit = await selectDepositForApproval(DepositRequest.findById(depositId));
    if (!deposit) throw new NotFoundError('DepositRequest');

    try {
        return await resolveExistingApproval(deposit);
    } catch (stateError) {
        if (stateError?.code === 'DEPOSIT_APPROVAL_CONFLICT') {
            throw retryError;
        }
        throw stateError;
    }
};

const buildDepositApprovalSideEffects = ({
    previousDeposit,
    updatedDeposit,
    adminId,
    auditContext,
    finalAmount,
    finalCurrency,
    finalCurrencyRate,
    finalAmountUsd,
    walletCreditAmount,
    referralCommissionEvaluation,
    commission,
}) => {
    const actorId = auditContext?.actorId ?? adminId;
    const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.ADMIN;
    const ipAddress = auditContext?.ipAddress ?? null;
    const userAgent = auditContext?.userAgent ?? null;
    const walletCurrency = 'USD';
    const source = {
        sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
        sourceId: updatedDeposit._id.toString(),
        operation: TRANSACTION_OPERATIONS.CREDIT,
        idempotencyKey: `deposit:${updatedDeposit._id}:credit`,
    };

    return () => {
        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: DEPOSIT_ACTIONS.APPROVED,
            entityType: ENTITY_TYPES.DEPOSIT,
            entityId: updatedDeposit._id,
            metadata: {
                userId: updatedDeposit.userId.toString(),
                finalAmount,
                finalCurrency,
                originalRequestedAmount: previousDeposit.requestedAmount,
                originalCurrency: previousDeposit.currency,
                exchangeRate: finalCurrencyRate,
                amountUsd: finalAmountUsd,
                adminOverrideApplied: !!(
                    previousDeposit.requestedAmount !== finalAmount
                    || previousDeposit.currency !== finalCurrency
                ),
                walletCurrency,
                walletCreditAmount,
                conversionNote: `${finalAmount} ${finalCurrency} -> ${walletCreditAmount} USD`,
                reviewedBy: adminId.toString(),
                walletSourceIdentity: source,
                referralCommission: referralCommissionEvaluation
                    ? {
                        outcome: referralCommissionEvaluation.outcome,
                        reason: referralCommissionEvaluation.reason,
                        commissionId: referralCommissionEvaluation.commissionId?.toString?.() || null,
                        referrerId: referralCommissionEvaluation.referrerId?.toString?.() || null,
                        amountUsd: referralCommissionEvaluation.amountUsd,
                    }
                    : null,
            },
        });

        createAuditLog({
            actorId, actorRole, ipAddress, userAgent,
            action: WALLET_ACTIONS.CREDIT,
            entityType: ENTITY_TYPES.WALLET,
            entityId: updatedDeposit.userId,
            metadata: {
                depositId: updatedDeposit._id.toString(),
                walletCurrency,
                walletCreditAmount,
                reason: 'DEPOSIT_APPROVED',
                walletSourceIdentity: source,
                referralCommissionId: commission?._id?.toString?.() || null,
            },
        });
    };
};

// =============================================================================
// APPROVE
// =============================================================================

/**
 * Admin approves a deposit request and credits the user's wallet with amountUsd.
 *
 * Legacy Phase 2A implementation retained for historical comparison only.
 * The exported `approveDeposit` below is the active Phase 2B transaction path.
 *
 * Phase 2A used an atomic compare-and-swap on { _id, status: PENDING }:
 *   1. Load and validate the deposit.
 *   2. Atomic findOneAndUpdate — prevents double-approval even under
 *      concurrent requests (no-op if status changed).
 *   3. Credit the user's wallet through the wallet helper.
 *
 * This legacy helper is not one shared MongoDB transaction across deposit
 * status, wallet balance, and wallet ledger.
 *
 * Concurrency safety:
 *   findOneAndUpdate with { _id, status: PENDING } acts as a compare-and-swap.
 *   The first concurrent approve wins; the second finds no matching document
 *   (status is no longer PENDING) and throws DEPOSIT_ALREADY_APPROVED.
 *
 * Audit: DEPOSIT_APPROVED + WALLET_CREDIT are fire-and-forget after the
 * financial writes in the current non-transactional flow.
 *
 * @param {string|ObjectId} depositId
 * @param {string|ObjectId} adminId
 * @param {Object|null}     [auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const approveDepositPhase2A = async (depositId, adminId, adminOverrides = {}, auditContext = null) => {
    const normalizedOverrides = (
        adminOverrides !== null
        && typeof adminOverrides === 'object'
        && !Array.isArray(adminOverrides)
    )
        ? adminOverrides
        : { amount: adminOverrides };

    // Pre-read to give clear error messages if status is already wrong
    const existing = await DepositRequest.findById(depositId);
    if (!existing) throw new NotFoundError('DepositRequest');

    if (existing.status === DEPOSIT_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'This deposit request has already been approved.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }
    if (existing.status === DEPOSIT_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'A rejected deposit cannot be approved. Create a new request.',
            'DEPOSIT_ALREADY_REJECTED'
        );
    }

    // ── Resolve final amount & currency (admin overrides take priority) ────
    const finalAmount = Number(parseFloat(
        normalizedOverrides.amount ?? existing.requestedAmount
    ).toFixed(2));
    const finalCurrency = (
        normalizedOverrides.currency || existing.currency || 'USD'
    ).toUpperCase();

    if (finalAmount <= 0) {
        throw new BusinessRuleError('Deposit amount must be greater than zero.', 'INVALID_AMOUNT');
    }

    const userDoc = await User.findById(existing.userId).select('currency status');
    if (!userDoc) throw new NotFoundError('User');
    if (userDoc.status !== USER_STATUS.ACTIVE) {
        throw new BusinessRuleError(
            'Inactive users cannot receive deposit credits.',
            'ACCOUNT_INACTIVE'
        );
    }

    const { getConversionRate } = require('../../services/currencyConverter.service');
    const finalCurrencyRate = await getConversionRate(finalCurrency);
    const walletCurrency = (userDoc.currency ?? 'USD').toUpperCase();
    const walletCurrencyRate = await getConversionRate(walletCurrency);
    const finalAmountUsd = Number((finalAmount / finalCurrencyRate).toFixed(2));

    // ── Atomic compare-and-swap on { _id, status: PENDING } ──────────────
    const $setFields = {
        status: DEPOSIT_STATUS.APPROVED,
        reviewedBy: adminId,
        reviewedAt: new Date(),
    };

    // Persist admin overrides on the deposit document if provided
    if (normalizedOverrides.amount != null) {
        $setFields.requestedAmount = finalAmount;
    }
    if (normalizedOverrides.currency) {
        $setFields.currency = finalCurrency;
    }
    if (normalizedOverrides.amount != null || normalizedOverrides.currency) {
        $setFields.exchangeRate = finalCurrencyRate;
        $setFields.amountUsd = finalAmountUsd;
    }
    if (normalizedOverrides.adminNotes) {
        $setFields.adminNotes = String(normalizedOverrides.adminNotes).trim();
    }

    const updated = await DepositRequest.findOneAndUpdate(
        { _id: depositId, status: DEPOSIT_STATUS.PENDING },
        { $set: $setFields },
        { new: true }
    );

    if (!updated) {
        throw new BusinessRuleError(
            'This deposit request has already been approved.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }

    // ── Determine the wallet credit amount (smart cross-currency) ─────────
    // walletBalance is stored in the user's local currency.
    //
    // Case 1 (same currency): Deposit SAR, wallet SAR → credit exact amount.
    // Case 2 (cross-currency): Deposit EGP, wallet SAR → EGP → USD → SAR.
    let walletCreditAmount;
    let conversionNote;

    if (finalCurrency === walletCurrency) {
        // Same currency — direct credit, no conversion loss
        walletCreditAmount = finalAmount;
        conversionNote = `${finalAmount} ${finalCurrency} (direct, no conversion)`;
    } else {
        // Cross-currency: finalCurrency → USD → walletCurrency
        const amountInUsd = Number((finalAmount / finalCurrencyRate).toFixed(6));
        walletCreditAmount = Number((amountInUsd * walletCurrencyRate).toFixed(2));
        conversionNote = `${finalAmount} ${finalCurrency} → ${amountInUsd} USD → ${walletCreditAmount} ${walletCurrency}`;
    }

    // Credit the wallet
    await creditWalletDirect({
        userId: updated.userId,
        amount: walletCreditAmount,
        reference: updated._id,
        description: `Deposit #${updated._id.toString().slice(-6)} (${finalAmount} ${finalCurrency})`,
    });

    // ── Audit: fire-and-forget ────────────────────────────────────────────
    const actorId = auditContext?.actorId ?? adminId;
    const actorRole = auditContext?.actorRole ?? ACTOR_ROLES.ADMIN;
    const ipAddress = auditContext?.ipAddress ?? null;
    const userAgent = auditContext?.userAgent ?? null;

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: DEPOSIT_ACTIONS.APPROVED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: updated._id,
        metadata: {
            userId: updated.userId.toString(),
            finalAmount,
            finalCurrency,
            originalRequestedAmount: existing.requestedAmount,
            originalCurrency: existing.currency,
            exchangeRate: finalCurrencyRate,
            amountUsd: finalAmountUsd,
            adminOverrideApplied: !!(normalizedOverrides.amount || normalizedOverrides.currency),
            walletCurrency,
            walletCreditAmount,
            conversionNote,
            reviewedBy: adminId.toString(),
        },
    });

    createAuditLog({
        actorId, actorRole, ipAddress, userAgent,
        action: WALLET_ACTIONS.CREDIT,
        entityType: ENTITY_TYPES.WALLET,
        entityId: updated.userId,
        metadata: {
            depositId: updated._id.toString(),
            walletCurrency,
            walletCreditAmount,
            reason: 'DEPOSIT_APPROVED',
        },
    });

    // ── Populate refs before returning to the frontend ────────────────────
    // Without this, the Zustand store overwrites the populated userId object
    // with a raw string ID, breaking the admin table's user column.
    const populated = await DepositRequest.findById(updated._id)
        .populate('userId', 'name email avatar currency walletBalance')
        .populate('reviewedBy', 'name email');

    // Notification: fire-and-forget
    notifyDepositApproved(populated);

    return populated;
};

const approveDeposit = async (depositId, adminId, adminOverrides = {}, auditContext = null) => {
    const normalizedOverrides = normalizeApprovalOverrides(adminOverrides);
    let postCommitSideEffects = null;
    let transactionResult = null;
    let transactionAttemptCount = 0;
    let session;

    try {
        session = await mongoose.startSession();
    } catch (_) {
        throw new BusinessRuleError(
            'Deposit approval requires MongoDB transaction support.',
            'FINANCIAL_TRANSACTION_UNAVAILABLE'
        );
    }

    if (!session || typeof session.withTransaction !== 'function') {
        if (session) await session.endSession();
        throw new BusinessRuleError(
            'Deposit approval requires MongoDB transaction support.',
            'FINANCIAL_TRANSACTION_UNAVAILABLE'
        );
    }

    try {
        await runApprovalTestHook('beforeTransaction', { depositId, adminId });

        transactionResult = await withBoundedApprovalTransactionRetry(session, async () => {
            transactionAttemptCount += 1;
            if (transactionAttemptCount > MAX_DEPOSIT_TRANSACTION_ATTEMPTS) {
                throw makeRetryExhaustedError();
            }
            await runApprovalTestHook('transactionAttemptStarted', {
                depositId,
                adminId,
                attempt: transactionAttemptCount,
                maxAttempts: MAX_DEPOSIT_TRANSACTION_ATTEMPTS,
            });

            const existing = await selectDepositForApproval(
                DepositRequest.findById(depositId).session(session)
            );
            if (!existing) throw new NotFoundError('DepositRequest');

            if (existing.status !== DEPOSIT_STATUS.PENDING) {
                return resolveExistingApproval(existing, session);
            }

            const [pendingLedgers, pendingCommissions] = await Promise.all([
                findDepositCreditLedgers(existing, session),
                findDepositCommissions(existing, session),
            ]);
            const pendingClassification = classifyDepositApprovalState({
                deposit: existing,
                ledgers: pendingLedgers,
                commissions: pendingCommissions,
            });
            if (pendingClassification !== DEPOSIT_RECONCILIATION_CODES.UNKNOWN) {
                throw makeReconciliationError(pendingClassification);
            }

            const userDoc = await User.findById(existing.userId)
                .select('currency status +referredBy +referredAt +referralSource')
                .session(session);
            if (!userDoc) throw new NotFoundError('User');
            if (userDoc.status !== USER_STATUS.ACTIVE) {
                throw new BusinessRuleError(
                    'Inactive users cannot receive deposit credits.',
                    'ACCOUNT_INACTIVE'
                );
            }

            const hasAmountOverride = normalizedOverrides.amount != null && normalizedOverrides.amount !== '';
            const hasCurrencyOverride = !!normalizedOverrides.currency;
            const finalAmount = roundMoney(
                parseFloat(hasAmountOverride ? normalizedOverrides.amount : existing.requestedAmount)
            );
            const finalCurrency = String(
                hasCurrencyOverride ? normalizedOverrides.currency : existing.currency || 'USD'
            ).toUpperCase();

            if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
                throw new BusinessRuleError(
                    'Deposit amount must be greater than zero.',
                    'INVALID_APPROVED_AMOUNT'
                );
            }

            const currentRate = hasAmountOverride || hasCurrencyOverride
                ? await getConversionRate(finalCurrency, {
                    session,
                    bypassCache: true,
                })
                : null;
            const finalCurrencyRate = hasAmountOverride || hasCurrencyOverride
                ? currentRate
                : Number(existing.exchangeRate);
            const finalAmountUsd = hasAmountOverride || hasCurrencyOverride
                ? roundMoney(finalAmount / currentRate)
                : roundMoney(existing.amountUsd);

            if (
                !Number.isFinite(finalCurrencyRate)
                || finalCurrencyRate <= 0
                || !Number.isFinite(finalAmountUsd)
                || finalAmountUsd <= 0
            ) {
                throw new BusinessRuleError(
                    'Deposit financial snapshots are invalid.',
                    'INVALID_DEPOSIT_SNAPSHOT'
                );
            }

            const $setFields = {
                status: DEPOSIT_STATUS.APPROVED,
                reviewedBy: adminId,
                reviewedAt: new Date(),
                requestedAmount: finalAmount,
                currency: finalCurrency,
                exchangeRate: finalCurrencyRate,
                amountUsd: finalAmountUsd,
            };

            if (normalizedOverrides.adminNotes) {
                $setFields.adminNotes = String(normalizedOverrides.adminNotes).trim();
            }

            await runApprovalTestHook('beforeDepositUpdate', {
                depositId,
                userId: existing.userId,
                finalAmount,
                finalCurrency,
                finalAmountUsd,
            });

            const updated = await DepositRequest.findOneAndUpdate(
                { _id: depositId, status: DEPOSIT_STATUS.PENDING },
                { $set: $setFields },
                { new: true, session }
            );

            if (!updated) {
                const current = await selectDepositForApproval(
                    DepositRequest.findById(depositId).session(session)
                );
                if (!current) throw new NotFoundError('DepositRequest');
                return resolveExistingApproval(current, session);
            }

            await runApprovalTestHook('afterDepositUpdate', {
                depositId,
                userId: updated.userId,
                finalAmountUsd,
            });

            const walletCreditAmount = finalAmountUsd;
            const { transaction: walletTransaction } = await creditWalletDirect({
                userId: updated.userId,
                amount: walletCreditAmount,
                reference: updated._id,
                description: `Deposit #${updated._id.toString().slice(-6)} (${finalAmount} ${finalCurrency})`,
                session,
                sourceType: TRANSACTION_SOURCE_TYPES.DEPOSIT,
                sourceId: updated._id,
                operation: TRANSACTION_OPERATIONS.CREDIT,
                idempotencyKey: `deposit:${updated._id}:credit`,
                requireSourceIdentity: true,
            });

            const commissionEvaluation = await evaluateDepositCommission({
                referredUser: userDoc,
                approvalTimestamp: updated.reviewedAt,
                sourceAmountUsd: finalAmountUsd,
                session,
            });

            let commission = null;
            let referralCommissionEvaluation = commissionEvaluation.evaluation;

            if (commissionEvaluation.eligible) {
                await runApprovalTestHook('beforeReferralCommissionInsert', {
                    depositId: updated._id,
                    walletTransactionId: walletTransaction._id,
                    referrerId: commissionEvaluation.referrer._id,
                    commissionAmountUsd: commissionEvaluation.commissionAmountUsd,
                });

                commission = await createDepositCommission({
                    referrer: commissionEvaluation.referrer,
                    referredUser: userDoc,
                    deposit: updated,
                    walletTransaction,
                    evaluation: commissionEvaluation.evaluation,
                    session,
                });

                referralCommissionEvaluation = {
                    ...commissionEvaluation.evaluation,
                    commissionId: commission._id,
                };
            }

            await runApprovalTestHook('beforeReferralCommissionEvaluationUpdate', {
                depositId: updated._id,
                evaluation: referralCommissionEvaluation,
                commissionId: commission?._id || null,
            });

            const evaluationUpdate = await DepositRequest.updateOne(
                { _id: updated._id },
                { $set: { referralCommissionEvaluation } },
                { session }
            );

            if (evaluationUpdate.matchedCount !== 1) {
                throw new BusinessRuleError(
                    'Deposit commission evaluation snapshot could not be persisted.',
                    'DEPOSIT_COMMISSION_EVALUATION_UPDATE_FAILED'
                );
            }

            updated.referralCommissionEvaluation = referralCommissionEvaluation;

            postCommitSideEffects = buildDepositApprovalSideEffects({
                previousDeposit: existing,
                updatedDeposit: updated,
                adminId,
                auditContext,
                finalAmount,
                finalCurrency,
                finalCurrencyRate,
                finalAmountUsd,
                walletCreditAmount,
                referralCommissionEvaluation,
                commission,
            });

            return {
                depositId: updated._id,
                idempotent: false,
                classification: DEPOSIT_RECONCILIATION_CODES.HEALTHY_APPROVED,
            };
        });

        await runApprovalTestHook('afterCommitBeforeResult', {
            depositId: transactionResult?.depositId || depositId,
            transactionResult,
        });
    } catch (err) {
        if (hasMongoErrorLabel(err, 'UnknownTransactionCommitResult')) {
            transactionResult = await classifyUnknownCommitResult(depositId);
        } else if (err?.code === 'DEPOSIT_APPROVAL_RETRY_EXHAUSTED') {
            transactionResult = await resolveApprovalAfterRetryExhaustion(depositId, err);
            postCommitSideEffects = null;
        } else if (isMongoDuplicateKeyError(err)) {
            const deposit = await selectDepositForApproval(DepositRequest.findById(depositId));
            if (!deposit) throw new NotFoundError('DepositRequest');
            transactionResult = await resolveExistingApproval(deposit);
        } else if (isTransactionUnavailableError(err)) {
            throw new BusinessRuleError(
                'Deposit approval requires MongoDB transaction support.',
                'FINANCIAL_TRANSACTION_UNAVAILABLE'
            );
        } else {
            throw err;
        }
    } finally {
        await session.endSession();
    }

    const populated = await populateDepositForReturn(transactionResult.depositId || depositId);
    if (!populated) throw new NotFoundError('DepositRequest');

    if (!transactionResult.idempotent) {
        if (postCommitSideEffects) {
            await runApprovalTestHook('beforePostCommitAudit', {
                depositId: transactionResult.depositId || depositId,
            });
            postCommitSideEffects();
        }
        await runApprovalTestHook('beforeApprovalNotification', {
            depositId: transactionResult.depositId || depositId,
        });
        notifyDepositApproved(populated);
    }

    return populated;
};

// =============================================================================
// REJECT
// =============================================================================

/**
 * Admin rejects a deposit request.
 *
 * Only PENDING requests can be rejected.
 * No financial operation is performed — wallet is untouched.
 *
 * Audit: DEPOSIT_REJECTED — fire-and-forget after save.
 *
 * @param {string|ObjectId} depositId
 * @param {string|ObjectId} adminId
 * @param {string|null}     [adminNotes]      - optional reason for rejection
 * @param {Object|null}     [auditContext]
 *
 * @returns {Promise<DepositRequest>}
 */
const rejectDeposit = async (depositId, adminId, adminNotes = null, auditContext = null) => {
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit) throw new NotFoundError('DepositRequest');

    if (deposit.status === DEPOSIT_STATUS.REJECTED) {
        throw new BusinessRuleError(
            'This deposit request has already been rejected.',
            'DEPOSIT_ALREADY_REJECTED'
        );
    }
    if (deposit.status === DEPOSIT_STATUS.APPROVED) {
        throw new BusinessRuleError(
            'An approved deposit cannot be rejected. It has already been credited.',
            'DEPOSIT_ALREADY_APPROVED'
        );
    }

    deposit.status = DEPOSIT_STATUS.REJECTED;
    deposit.reviewedBy = adminId;
    deposit.reviewedAt = new Date();
    if (adminNotes) deposit.adminNotes = adminNotes;
    await deposit.save();

    // Audit: fire-and-forget after save
    createAuditLog({
        actorId: auditContext?.actorId ?? adminId,
        actorRole: auditContext?.actorRole ?? ACTOR_ROLES.ADMIN,
        action: DEPOSIT_ACTIONS.REJECTED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            userId: deposit.userId.toString(),
            requestedAmount: deposit.requestedAmount,
            currency: deposit.currency,
            amountUsd: deposit.amountUsd,
            adminNotes: adminNotes || null,
            reviewedBy: adminId.toString(),
        },
        ipAddress: auditContext?.ipAddress ?? null,
        userAgent: auditContext?.userAgent ?? null,
    });

    // Notification: fire-and-forget
    notifyDepositRejected(deposit, adminNotes);

    return deposit;
};

// =============================================================================
// QUERIES
// =============================================================================

/**
 * Admin: list deposit requests with optional status filter, paginated.
 * Sorted newest-first so the most recent requests appear on Page 1.
 */
const listDeposits = async ({ page = 1, limit = 20, status, search } = {}) => {
    const filter = {};
    // Enforce uppercase to match DEPOSIT_STATUS enum (PENDING, APPROVED, REJECTED)
    if (status) filter.status = String(status).toUpperCase();

    // Search by user name or email
    if (search && String(search).trim()) {
        const regex = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const matchingUsers = await User.find({
            $or: [{ name: regex }, { email: regex }],
        }).select('_id').lean();
        filter.userId = { $in: matchingUsers.map((u) => u._id) };
    }

    const skip = (page - 1) * limit;

    const [deposits, total, summaryStats] = await Promise.all([
        DepositRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('userId', 'name email walletBalance currency')
            .populate('reviewedBy', 'name email'),
        DepositRequest.countDocuments(filter),
        // Base stats — always unfiltered so dashboard cards remain stable
        DepositRequest.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    pending: { $sum: { $cond: [{ $eq: ['$status', DEPOSIT_STATUS.PENDING] }, 1, 0] } },
                    approved: { $sum: { $cond: [{ $eq: ['$status', DEPOSIT_STATUS.APPROVED] }, 1, 0] } },
                },
            },
        ]).then((r) => r[0] || { total: 0, pending: 0, approved: 0 }),
    ]);

    return {
        deposits,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        summary: {
            totalDeposits: summaryStats.total,
            pendingCount: summaryStats.pending,
            approvedCount: summaryStats.approved,
        },
    };
};

/**
 * Customer: list their own deposit requests, paginated.
 * Sorted newest-first.
 */
const listMyDeposits = async (userId, { page = 1, limit = 20, status } = {}) => {
    const filter = { userId };
    if (status) filter.status = status;

    const skip = (page - 1) * limit;

    const [deposits, total] = await Promise.all([
        DepositRequest.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        DepositRequest.countDocuments(filter),
    ]);

    return {
        deposits,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
};

/**
 * Get a single deposit request by ID.
 * Customers may only see their own; admins may see any.
 *
 * @param {string|ObjectId}      depositId
 * @param {string|ObjectId|null} [requestingUserId] - if set, enforces ownership
 */
const getDepositById = async (depositId, requestingUserId = null) => {
    const deposit = await DepositRequest.findById(depositId)
        .populate('userId', 'name email')
        .populate('reviewedBy', 'name email');

    if (!deposit) throw new NotFoundError('DepositRequest');

    if (requestingUserId && deposit.userId._id.toString() !== requestingUserId.toString()) {
        throw new AuthorizationError('You do not have permission to view this deposit request.');
    }

    return deposit;
};

// =============================================================================
// UPDATE PENDING DEPOSIT
// =============================================================================

/**
 * Update a PENDING deposit request (admin editing fields).
 *
 * Guard: strictly rejects updates if the deposit is NOT in PENDING status.
 *
 * @param {string}          depositId
 * @param {Object}          data
 * @param {number}          [data.requestedAmount]
 * @param {string|ObjectId} adminId
 *
 * @returns {Promise<DepositRequest>}
 */
const updatePendingDeposit = async (depositId, data, adminId) => {
    const deposit = await DepositRequest.findById(depositId);
    if (!deposit) throw new NotFoundError('Deposit request');

    if (deposit.status !== DEPOSIT_STATUS.PENDING) {
        throw new BusinessRuleError(
            `Cannot update a ${deposit.status.toLowerCase()} deposit. Only PENDING deposits can be edited.`,
            'DEPOSIT_NOT_PENDING'
        );
    }

    const before = {
        requestedAmount: deposit.requestedAmount,
    };

    if (data.requestedAmount !== undefined) {
        deposit.requestedAmount = Number(parseFloat(data.requestedAmount).toFixed(2));
        // Recalculate amountUsd with stored exchangeRate
        deposit.amountUsd = Number((deposit.requestedAmount / deposit.exchangeRate).toFixed(2));
    }

    await deposit.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: DEPOSIT_ACTIONS.UPDATED,
        entityType: ENTITY_TYPES.DEPOSIT,
        entityId: deposit._id,
        metadata: {
            before,
            after: {
                requestedAmount: deposit.requestedAmount,
                amountUsd: deposit.amountUsd,
            },
        },
    });

    return deposit;
};

module.exports = {
    createDepositRequest,
    approveDeposit,
    rejectDeposit,
    listDeposits,
    listMyDeposits,
    getDepositById,
    updatePendingDeposit,
    normalizeSenderDetails,
    DEPOSIT_RECONCILIATION_CODES,
    MAX_DEPOSIT_TRANSACTION_ATTEMPTS,
    classifyDepositApprovalState,
    findDepositCreditLedgers,
    findDepositCommissions,
    __setDepositApprovalTestHooks,
};
