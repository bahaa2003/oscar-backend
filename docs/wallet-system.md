# Wallet System

## Overview

Every user has an embedded wallet (`walletBalance` on the `User` document). Wallet balance changes use atomic MongoDB writes and every completed balance change creates a `WalletTransaction`. Deposit approval now uses one MongoDB transaction for the PENDING deposit claim, final financial validation, approval snapshot update, wallet balance credit, `WalletTransaction` insert, referral commission evaluation, and eligible `ReferralCommission` insert.

---

## Design Principles

1. **Wallet-only policy** — orders succeed only when `walletBalance >= orderAmount`. The balance can never go negative.
2. **Atomic operations** — every balance change is a single `findOneAndUpdate` with an aggregation pipeline. The check and the update are inseparable.
3. **Immutable audit trail** — every balance change creates a `WalletTransaction` document that is never modified after creation.
4. **Session propagation** - wallet functions accept an optional `ClientSession` and propagate it to their writes when supplied. Deposit approval requires MongoDB transactions and has no unsafe non-transaction fallback.

---

## Three Operations

### 1. `debitWalletAtomic` — Order Payments

**File:** `src/modules/wallet/wallet.service.js`

Called by `order.service.js` inside the order-creation transaction.

```js
const { walletDeducted, creditUsedAmount, transaction } = await debitWalletAtomic({
    userId,
    amount,         // total order cost in user currency
    reference,      // order._id (set via update after order creation)
    description,    // e.g. "Order payment for Free Fire Diamonds"
    session,        // REQUIRED — MongoDB ClientSession
});
```

**Internal logic:**

```js
User.findOneAndUpdate(
    {
        _id: userId,
        status: 'ACTIVE',               // must be active
        walletBalance: { $gte: amount } // sufficient funds check
    },
    [{
        $set: {
            walletBalance: { $subtract: ['$walletBalance', amount] }
        }
    }],
    { new: false, session }             // pre-update doc for audit
)
```

If the `findOneAndUpdate` returns `null`:
- A second query checks whether the user exists and is active
- If active but insufficient: throws `InsufficientFundsError(required, available)`
- If inactive: throws `BusinessRuleError('ACCOUNT_INACTIVE')`
- If not found: throws `NotFoundError('User')`

**Returns:**
```js
{
    walletDeducted: amount,   // always equals the debit amount
    creditUsedAmount: 0,      // always 0 (credit system removed)
    transaction: WalletTransaction
}
```

---

### 2. `refundWalletAtomic` — Order Refunds

Called when an order fails, is explicitly canceled by the provider, or is failed by an admin action.

```js
const { transaction } = await refundWalletAtomic({
    userId,
    walletDeducted,      // from order.walletDeducted
    creditUsedAmount,    // from order.creditUsedAmount (always 0)
    reference,           // order._id
    description,
    session,
});
```

**Internal logic:**

```js
User.findOneAndUpdate(
    { _id: userId },
    [{
        $set: {
            walletBalance: { $add: ['$walletBalance', walletDeducted] },
            creditUsed: {
                $max: [0, { $subtract: ['$creditUsed', creditUsedAmount] }]
            }
        }
    }],
    { new: false, session }
)
```

The `$max: [0, ...]` clamp on `creditUsed` guards against any numeric edge case.

**Idempotency guard:** Before calling `refundWalletAtomic`, the fulfillment service checks `order.refunded === true`. If already `true`, the refund is skipped — preventing double-refunds in retry scenarios.

---

### 3. `creditWalletDirect` — Deposit Top-Ups

Called when an admin approves a deposit request.

```js
const { transaction } = await creditWalletDirect({
    userId,
    amount,         // approved USD amount credited to the wallet
    reference,      // depositRequest._id
    description,    // "Deposit approved by admin"
    session,
});
```

**Internal logic:**

```js
User.findOneAndUpdate(
    { _id: userId },
    [{
        $set: {
            walletBalance: { $add: ['$walletBalance', amount] }
        }
    }],
    { new: false, session }
)
```

No status check is required here — admin-approved deposits credit the wallet unconditionally.

---

## WalletTransaction Model

Every balance change writes an immutable `WalletTransaction` record:

```json
{
  "_id":           "64def...",
  "userId":        "64abc...",
  "type":          "DEBIT",
  "amount":        10.99,
  "balanceBefore": 150.00,
  "balanceAfter":  139.01,
  "reference":     "64ord...",
  "status":        "COMPLETED",
  "description":   "Order payment for Free Fire Diamonds",
  "createdAt":     "2024-03-10T04:00:00Z"
}
```

| Type | When Created |
|------|-------------|
| `DEBIT` | Order placed |
| `REFUND` | Order failed / manual admin refund |
| `CREDIT` | Deposit approved / admin manually adds funds |

Indexes ensure fast per-user history queries:
```
userId + createdAt DESC  → transaction history
reference               → look up by order ID
```

---

## Transaction History

```js
getTransactionHistory(userId, { page = 1, limit = 20 })
```

Returns paginated transactions sorted newest-first, with the referenced order populated (`status`, `totalPrice`).

### Customer API

```http
GET /api/me/wallet/transactions?page=1&limit=20
```

### Admin API

```http
GET /api/admin/wallets/:userId/transactions?page=1&limit=50
```

---

## Admin Direct Wallet Adjustments

Admins can add or deduct funds outside the normal order/deposit flow. Both operations use the same atomic wrappers.

### Add Funds

```http
POST /api/admin/wallets/:userId/add
{
  "amount": 100,
  "reason": "Promotional credit"
}
```

→ Calls `creditWalletDirect()` inside a session.
→ Writes a `CREDIT` WalletTransaction.

### Deduct Funds

```http
POST /api/admin/wallets/:userId/deduct
{
  "amount": 50,
  "reason": "Correction"
}
```

→ Calls `debitWalletAtomic()` inside a session.
→ Writes a `DEBIT` WalletTransaction.
→ Fails with `422 INSUFFICIENT_BALANCE` if wallet is too low.

---

## Currency Handling

Users hold wallets in their own currency (e.g. SAR, EGP, USD). Product prices are always in USD internally. At order creation:

```
usdAmount    = finalPriceUSD × quantity
rateSnapshot = Currency.platformRate  (at that moment)
chargedAmount = usdAmount × rateSnapshot
```

The wallet is debited `chargedAmount` in the user's currency. All three values are frozen on the order document.

Phase 3B resolves `finalPriceUSD` through the backend commercial pricing resolver. Approved resellers use their valid assigned active Group; suspended resellers do not retain reseller pricing for future orders. The client may display quote previews but cannot submit authoritative prices, totals, Groups, percentages, reseller state, or exchange rates. New orders store immutable `pricingSnapshot` and currency snapshots so refunds and history do not depend on later product, Group, currency, or reseller-state changes.

### Currency Conversion Example

```
Product basePrice:   $9.99 USD
User markup:         15%
USD order total:     $11.49 USD

User currency: SAR
platformRate: 3.75 SAR/USD
Charged:  11.49 × 3.75 = 43.09 SAR
```

The user's wallet is debited **43.09 SAR**.

---

## Deposit Request Flow

```
Customer POSTs deposit request
    requestedAmount: 100
    currency: "EGP"
    paymentMethodId: "vodafone-cash"
    senderDetails: { value: "+1-555-0100" }
    receipt: <file>    ← multer uploads to /uploads/deposits/
              │
              ▼
DepositRequest created (status=PENDING)
              │
    (Admin reviews uploaded screenshot)
              │
              ▼
Admin: PATCH /api/admin/deposits/:id/review
    { status: "APPROVED", amount: 95, currency: "EGP" }    ← optional amount/currency correction
              │
              ▼ Phase 2C MongoDB transaction:
    DepositRequest.status = APPROVED
    DepositRequest.amountUsd = 1.90
    DepositRequest.reviewedBy = adminId
    DepositRequest.reviewedAt = now
    creditWalletDirect({ userId, amount: amountUsd, session, source identity })
    WalletTransaction inserted with the same session
    ReferralCommission inserted with the same session when eligible
    DepositRequest.referralCommissionEvaluation stored with the same session
              │
              ▼ Commit
    AuditLog and notification run after commit only
              │
              ▼
User wallet balance += amountUsd
WalletTransaction (CREDIT) created
```

### Rejected Deposit

```
Admin: PATCH /api/admin/deposits/:id/reject
    → DepositRequest.status = REJECTED
    → Wallet NOT credited
    → AuditLog written
```

---

## State Invariants

| Invariant | Enforced By |
|-----------|-------------|
| `walletBalance >= 0` | Atomic update filter: `walletBalance: { $gte: amount }` |
| No double-debit per order | Atomic wallet update filter and order lifecycle guards |
| No double-refund | `order.refunded` boolean checked before `refundWalletAtomic()` |
| No double-deposit-approval | Healthy repeated approvals return idempotent success without another credit |
| All money changes audited | `_createTransactionRecord` called inside every wallet function |
| Deposit source identity | `sourceType`, `sourceId`, `operation`, and `idempotencyKey` are mandatory for deposit wallet credits |

---

## Edge Cases

### Concurrent Orders Same User

Two simultaneous orders from the same user both reach `debitWalletAtomic`. MongoDB processes them sequentially (document-level lock). Only one will see `walletBalance >= amount` after the first debit — the second correctly throws `InsufficientFundsError`.

### Refund to Deleted User

`refundWalletAtomic` does not check `status` — it always restores the balance. Even if a user account is soft-deleted, the refund is credited back. The referenced `WalletTransaction` preserves the audit trail.

### Zero-Amount Guard

Both `debitWalletAtomic` and `creditWalletDirect` throw `BusinessRuleError('INVALID_AMOUNT')` if `amount <= 0`, preventing silent no-ops.

### Session Propagation

The wallet helpers do not hard-require `session` for all call sites. When a session is supplied, it is passed to the user update and the `WalletTransaction` insert. Deposit approval supplies the same session to the deposit write, user read/write, currency read when an override requires it, wallet ledger insert, commission eligibility reads, commission insert, and evaluation snapshot update.

### Wallet Source Idempotency

Deposit credits write:

- `sourceType = DEPOSIT`
- `sourceId = <depositId>`
- `operation = CREDIT`
- `idempotencyKey = deposit:<depositId>:credit`

The `unique_wallet_source_operation` index is a partial unique index on `{ userId, sourceType, sourceId, operation }`. It applies only when complete source identity exists, so legacy ledger rows without source identity remain possible. An approved deposit without a matching ledger, a pending deposit with a credit ledger, duplicate ledgers, amount mismatches, or Phase 2C commission mismatches require manual reconciliation.

### Referral Commission Records

When `REFERRAL_COMMISSION_ENABLED=true` and `REFERRAL_COMMISSION_RATE_PERCENT` is a valid configured rate greater than zero, a newly approved eligible referred user's deposit creates one `ReferralCommission` inside the same deposit transaction. The commission snapshots the referrer, referred user, deposit id, wallet transaction id, source amount/currency/exchange rate/USD amount, rate, calculated USD commission, referral source, referred-at timestamp, policy source, and calculation version `v1`.

New commissions are created with status `AVAILABLE`. Deposit approval does not credit the referrer's wallet and does not create a referrer `WalletTransaction`. Repeat approval reads the stored `referralCommissionEvaluation` snapshot; it does not re-evaluate current referrer status or the current configured rate.

### Referral Payout Wallet Credits

Phase 2E adds payout settlement as a separate admin-reviewed workflow. Creating a payout request does not change wallet balance; it creates `ReferralPayoutRequest(PENDING)` and locks selected commissions `AVAILABLE -> LOCKED` in one transaction. Rejection unlocks commissions back to `AVAILABLE` without wallet credit.

Only `WALLET` settlement credits the referrer's wallet. That transaction updates `User.walletBalance`, inserts exactly one `WalletTransaction`, marks linked commissions `PAID`, and marks the payout `PAID` with the same MongoDB session. The wallet ledger source identity is:

- `sourceType = REFERRAL_PAYOUT`
- `sourceId = <referralPayoutRequestId>`
- `operation = CREDIT`
- `idempotencyKey = referral-payout:<referralPayoutRequestId>:credit`

`MANUAL` settlement records a confirmed external reference, marks linked commissions and the payout `PAID`, and never credits the wallet or inserts a wallet ledger row. External payment-provider execution is outside the backend.
