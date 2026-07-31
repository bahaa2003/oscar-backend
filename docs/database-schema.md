# Database Schema

All collections use **Mongoose ODM** over MongoDB. Unless noted, all schemas include `createdAt` and `updatedAt` via the `{ timestamps: true }` option.

---

## Table of Contents

- [User](#user)
- [Group](#group)
- [Product](#product)
- [ProviderProduct](#providerproduct)
- [Provider](#provider)
- [Order](#order)
- [WalletTransaction](#wallettransaction)
- [DepositRequest](#depositrequest)
- [ReferralCommission](#referralcommission)
- [ResellerApplication](#resellerapplication)
- [Currency](#currency)
- [AuditLog](#auditlog)
- [Setting](#setting)
- [Indexes Summary](#indexes-summary)
- [Schema Relationships](#schema-relationships)

---

## User

**Collection:** `users`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | String | ✅ | 2–100 chars |
| `email` | String | ✅ | Unique, lowercase, sparse index |
| `password` | String | ❌ | Bcrypt hashed. Omitted for OAuth users. Never returned by default (`select: false`) |
| `googleId` | String | ❌ | Google OAuth sub. Sparse unique index |
| `verified` | Boolean | — | Default `false`. Google users auto-verified |
| `emailVerificationToken` | String | ❌ | SHA-256 hash. `select: false`. Null after verification |
| `emailVerificationExpires` | Date | ❌ | 24hr TTL. `select: false` |
| `role` | String | — | `ADMIN` \| `CUSTOMER`. Default `CUSTOMER` |
| `status` | String | — | `PENDING` \| `ACTIVE` \| `REJECTED`. Default `PENDING` |
| `approvedBy` | ObjectId → User | ❌ | Admin who approved |
| `approvedAt` | Date | ❌ | Timestamp of approval |
| `rejectedBy` | ObjectId → User | ❌ | Admin who rejected |
| `rejectedAt` | Date | ❌ | Timestamp of rejection |
| `groupId` | ObjectId → Group | ✅ | Pricing tier. Auto-assigned on registration |
| `walletBalance` | Number | — | Non-negative. Default `0` |
| `creditLimit` | Number | — | Schema field retained for compatibility. Not used in business logic |
| `creditUsed` | Number | — | Schema field retained for compatibility. Always `0` |
| `currency` | String | — | ISO 4217, 3 letters. Default `USD` |
| `referralCode` | String | ✅ | Own URL-safe invite code; unique partial index |
| `referredBy` | ObjectId → User | ❌ | Referrer identity; hidden by default |
| `referredAt` | Date | ❌ | Referral attribution timestamp; hidden by default |
| `referralSource` | String | ❌ | `EMAIL_REGISTRATION` or `GOOGLE_OAUTH`; hidden by default |
| `deletedAt` | Date | ❌ | Soft-delete timestamp. Null = not deleted |

**Virtuals:**
- `isActive` → `status === 'ACTIVE'` (backward-compat shim)
- `availableBalance` → `walletBalance` rounded to 2 dp
- `availableCredit` → `creditLimit - creditUsed` (always 0)

**Indexes:**
```
email       unique
googleId    unique sparse
status      1
role        1
groupId     1
deletedAt   1 sparse
referralCode 1 unique partial (`unique_referral_code`)
referredBy 1 + referredAt -1
```

**Phase 3A commercial reseller fields:**

`User` also stores reseller/sub-agent commercial state. These fields are account state, not authentication roles: `resellerStatus` (`NONE`, `PENDING`, `APPROVED`, `REJECTED`, `SUSPENDED`), `resellerApprovedAt`, `resellerApprovedBy`, `resellerRejectedAt`, `resellerRejectionReason`, `resellerSuspendedAt`, `resellerSuspensionReason`, `resellerReactivatedAt`, and `resellerGroupId`. `resellerGroupId` points to the approved reseller pricing Group; `groupId` is changed transactionally on approval/suspension/reactivation.

Phase 3B uses those fields only for commercial pricing. An approved reseller receives reseller pricing only when `status = ACTIVE`, `deletedAt = null`, `resellerStatus = APPROVED`, `resellerGroupId` exists, `groupId` equals `resellerGroupId`, and the referenced Group is active and not deleted. Suspended resellers must use the explicit Default Group for future orders. These fields do not create a new authentication role and do not affect referral commission or payout rates.

---

## Group

**Collection:** `groups`

Pricing tiers. Every user belongs to exactly one group. The group's `percentage` is applied as a markup on top of the product's base price.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | String | ✅ | Unique, 2–100 chars |
| `percentage` | Number | ✅ | Non-negative. e.g. `15` means 15% markup |
| `isActive` | Boolean | — | Default `true` |

**Indexes:**
```
name        unique
percentage  -1   (supports "highest percentage" queries for default group)
```

---

## Product

**Collection:** `products`

Admin-curated product catalogue. Decoupled from `ProviderProduct` to allow independent pricing, presentation, and form customization.

### Core Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | String | ✅ | Unique, 2–200 chars |
| `description` | String | ❌ | Max 2000 chars |
| `basePrice` | String | ✅ | Canonical Decimal string in USD, non-negative |
| `minQty` | Number | — | Default `1` |
| `maxQty` | Number | — | Default `9999` |
| `category` | String | ❌ | Free-form tag |
| `image` | String | ❌ | Image URL |
| `displayOrder` | Number | — | Sort order. Default `0` |
| `isActive` | Boolean | — | Default `true` |
| `executionType` | String | — | `manual` \| `automatic`. Default `manual` |

### Pricing Mode

| Field | Type | Notes |
|-------|------|-------|
| `pricingMode` | String | `manual` \| `sync`. `sync` auto-updates `basePrice` when the raw provider price changes |
| `markupType` | String | `percentage` \| `fixed` |
| `markupValue` | Number | Default `0` |

### Provider Link

| Field | Type | Notes |
|-------|------|-------|
| `providerProduct` | ObjectId → ProviderProduct | Null for standalone products |
| `createdBy` | ObjectId → User | Admin who created this product |

### Order Fields (Dynamic Form Schema)

`orderFields` is an array of field definition subdocuments:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | String | ✅ | Stable internal identifier (e.g. `"f1"`) |
| `label` | String | ✅ | Human-readable label shown to customer |
| `key` | String | ✅ | Programmatic key (lowercase snake_case, e.g. `player_id`) |
| `type` | String | ✅ | Enum: `text`, `textarea`, `number`, `select`, `url`, `email`, `tel`, `date` |
| `placeholder` | String | ❌ | Input hint text |
| `required` | Boolean | — | Default `true` |
| `options` | [String] | — | Only meaningful for `type=select` |
| `min` | Number | ❌ | Lower bound for `type=number` |
| `max` | Number | ❌ | Upper bound for `type=number` |
| `sortOrder` | Number | — | Default `0` |
| `isActive` | Boolean | — | Default `true` |

### Provider Mapping

```
providerMapping: Map<String, String>
```

Translates internal `orderField.key` values to the parameter names the provider API expects. Example:
```js
{ player_id: "link", server: "server_id" }
```

---

## ProviderProduct

**Collection:** `providerproducts`

Raw inventory data fetched and refreshed by the sync engine. **Never exposed to customers.** Internal to admin and sync systems only.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `provider` | ObjectId → Provider | ✅ | Source provider |
| `externalProductId` | String | ✅ | Provider's own product ID |
| `rawName` | String | ✅ | Name as returned by provider API |
| `translatedName` | String | ❌ | Admin-set friendly name. Never overwritten by sync |
| `rawPrice` | String | ✅ | Canonical Decimal string price as returned by provider (USD) |
| `minQty` | Number | — | Default `1` |
| `maxQty` | Number | — | Default `9999` |
| `isActive` | Boolean | — | Provider-reported availability |
| `lastSyncedAt` | Date | ❌ | Most recent sync timestamp |
| `rawPayload` | Mixed | ❌ | Full raw JSON response, preserved verbatim |

**Unique constraint:** `(provider, externalProductId)`

---

## Provider

**Collection:** `providers`

External API connection configuration.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | String | ✅ | Unique, 2–100 chars |
| `slug` | String | ❌ | URL-safe key (e.g. `royal-crown`). Auto-generated from `name` on first save |
| `baseUrl` | String | ✅ | API root URL |
| `apiToken` | String | ❌ | Primary authentication token |
| `apiKey` | String | ❌ | Deprecated alias for `apiToken` |
| `isActive` | Boolean | — | Default `true` |
| `syncInterval` | Number | — | Minutes between auto-syncs. `0` = manual only. Default `60` |
| `supportedFeatures` | [String] | — | e.g. `["placeOrder","checkOrder","getBalance"]` |
| `deletedAt` | Date | ❌ | Soft-delete |

**Virtual:** `effectiveToken` → `apiToken || apiKey || null`

---

## Order

**Collection:** `orders`

The single most complex document. Contains full point-in-time snapshots of pricing, group membership, customer inputs, and fulfillment state.

### Identity

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `userId` | ObjectId → User | ✅ | |
| `productId` | ObjectId → Product | ✅ | |
| `quantity` | Number | ✅ | Min 1 |
| `idempotencyKey` | String | ❌ | Sparse unique per `(userId, idempotencyKey)` |
| `orderNumber` | String | ❌ | Unique only when assigned as a non-empty string via `unique_order_number_non_empty`; legacy/null rows remain possible. |

### Pricing Snapshots (Written Once, Immutable)

| Field | Type | Notes |
|-------|------|-------|
| `basePriceSnapshot` | String | Canonical Decimal string of `product.basePrice` at order time |
| `markupPercentageSnapshot` | Number | `group.percentage` at order time |
| `finalPriceCharged` | String | Canonical Decimal string: `basePriceSnapshot * (1 + markup/100)` |
| `groupIdSnapshot` | ObjectId → Group | User's group at order time |
| `unitPrice` | String | Alias for `finalPriceCharged` (legacy) |
| `totalPrice` | String | Canonical Decimal string total charged for the order currency |

Phase 3B also stores a structured immutable `pricingSnapshot` on newly created orders:

```js
{
  pricingVersion: "reseller-pricing-v1",
  customerCommercialSnapshot: {
    userId,
    resellerStatus,
    effectiveGroupId,
    effectiveGroupName,
    groupPercentage,
    pricingType
  },
  currencySnapshot: {
    orderCurrency,
    exchangeRate,
    rateSource,
    capturedAt
  },
  subtotal,
  total,
  subtotalUsd,
  totalUsd,
  items: [{
    productId,
    productName,
    baseUnitPrice,
    groupPercentage,
    adjustmentAmount,
    finalUnitPrice,
    quantity,
    lineTotal,
    lineTotalUsd,
    currency,
    calculationVersion
  }]
}
```

The legacy snapshot fields remain for compatibility. Historical orders are not recalculated when product prices, Group percentages, user reseller state, or currency rates later change.
| `walletDeducted` | Number | Amount taken from wallet (always = `totalPrice`) |
| `creditUsedAmount` | Number | Always `0` (credit system removed) |

### Currency Snapshots (Written Once, Immutable)

| Field | Type | Notes |
|-------|------|-------|
| `currency` | String | User's wallet currency at order time. Default `USD` |
| `rateSnapshot` | Number | `Currency.platformRate` at order time. Default `1` |
| `usdAmount` | Number | Total cost in USD (before currency conversion) |
| `chargedAmount` | Number | Wallet amount deducted in user's currency |

### Status

| Field | Type | Notes |
|-------|------|-------|
| `status` | String | `PENDING` \| `PROCESSING` \| `COMPLETED` \| `FAILED` |
| `executionType` | String | `manual` \| `automatic` |
| `refundedAt` | Date | Set when wallet is credited back |
| `failedAt` | Date | Set when status moves to FAILED |

### Provider Fulfillment Fields

| Field | Type | Notes |
|-------|------|-------|
| `providerOrderId` | Number | Provider's numeric order ID (null until placed) |
| `providerStatus` | String | Raw status string from provider |
| `providerRawResponse` | Mixed | Full provider JSON response |
| `retryCount` | Number | Status-check attempts. Force-failed at `MAX_RETRY_COUNT` (5) |
| `lastCheckedAt` | Date | Last status poll timestamp |
| `refunded` | Boolean | Idempotency guard for refunds. Default `false` |

### Dynamic Customer Input

| Field | Type | Notes |
|-------|------|-------|
| `customerInput.values` | Mixed | Key→value map of submitted field values. e.g. `{ player_id: "hero_123" }` |
| `customerInput.fieldsSnapshot` | [Mixed] | Simplified copy of active `orderFields` at time of order |

`customerInput` is `null` when the product has no `orderFields`.

**Indexes:**
```
userId + createdAt        compound
status                    1
groupIdSnapshot           1
userId + idempotencyKey   unique sparse  (name: unique_user_idempotency_key)
status + providerOrderId + lastCheckedAt  (name: processing_orders_poll)
```

---

## WalletTransaction

**Collection:** `wallettransactions`

Immutable audit record for every wallet balance change. Never updated or deleted after creation.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `userId` | ObjectId → User | ✅ | |
| `type` | String | ✅ | `CREDIT` \| `DEBIT` \| `REFUND` |
| `amount` | Number | ✅ | Min 0.01 |
| `balanceBefore` | Number | ✅ | Balance before this transaction |
| `balanceAfter` | Number | ✅ | Balance after this transaction |
| `reference` | ObjectId → Order | ❌ | Source order or deposit |
| `sourceType` | String | ❌ | Source domain, e.g. `DEPOSIT` |
| `sourceId` | ObjectId | ❌ | Source document id |
| `operation` | String | ❌ | Source operation, e.g. `CREDIT`, `DEBIT`, `REFUND` |
| `idempotencyKey` | String | ❌ | Operation idempotency key, e.g. `deposit:<id>:credit` |
| `status` | String | — | `PENDING` \| `COMPLETED` \| `FAILED`. Default `COMPLETED` |
| `description` | String | ❌ | Max 255 chars |

**Indexes:**
```
userId + createdAt   compound
reference            1
unique_wallet_source_operation  partial unique on userId + sourceType + sourceId + operation
```

`unique_wallet_source_operation` only applies when `sourceType`, `sourceId`, and `operation` are all present with the expected types. Legacy ledger rows without complete source identity remain possible and must be reconciled before they are treated as idempotent deposit credits.

---

## DepositRequest

**Collection:** `depositrequests`

Manual funding requests submitted by customers and reviewed by admins.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `userId` | ObjectId → User | ✅ | |
| `status` | String | — | `PENDING` \| `APPROVED` \| `REJECTED`. Default `PENDING` |
| `paymentMethodId` | String | ✅ | Active payment method id from runtime payment settings |
| `requestedAmount` | Number | ✅ | Local-currency amount, > 0 |
| `currency` | String | ✅ | ISO 4217 code, e.g. `USD`, `EGP`, `SAR` |
| `exchangeRate` | Number | ✅ | Snapshotted `platformRate`; convention is 1 USD = rate units |
| `amountUsd` | Number | ✅ | USD equivalent credited on approval |
| `receiptImage` | String | ✅ | Relative receipt upload path (max 2048 chars) |
| `senderDetails` | Object | ❌ | Normalized sender account/phone/address metadata |
| `reviewedBy` | ObjectId → User | ❌ | Admin who reviewed |
| `reviewedAt` | Date | ❌ | Timestamp of review |
| `referralCommissionEvaluation` | Object | ❌ | Hidden by default; Phase 2C approval-time commission evaluation snapshot |

**Virtuals:** `isApproved`, `isRejected`, `isPending`

**State machine:** `PENDING → APPROVED` or `PENDING → REJECTED`. Both transitions are one-way.

`referralCommissionEvaluation` is written inside the same approval transaction for newly approved deposits. It contains `version`, `outcome` (`CREATED`, `NOT_ELIGIBLE`, `DISABLED`), `reason`, `commissionId`, `referrerId`, `ratePercent`, `amountUsd`, and `evaluatedAt`. Legacy approved deposits may have no snapshot and are not retroactively commissioned.

**Indexes:**
```
status + createdAt      (admin pending queue)
userId + createdAt -1   (customer history)
```

---

## ReferralCommission

**Collection:** `referralcommissions`

Immutable commission record created when an eligible referred user's deposit is approved. Phase 2C creates status `AVAILABLE`; Phase 2E payout transactions may move commissions to `LOCKED` or `PAID`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `referrerId` | ObjectId → User | ✅ | User receiving the future commission payout |
| `referredUserId` | ObjectId → User | ✅ | User whose deposit generated the commission |
| `depositId` | ObjectId → DepositRequest | ✅ | Unique financial source |
| `walletTransactionId` | ObjectId → WalletTransaction | ✅ | Wallet ledger created by the same transaction |
| `sourceAmount` | String | ✅ | Approved deposit amount snapshot |
| `sourceCurrency` | String | ✅ | Approved deposit currency |
| `sourceExchangeRate` | String | ✅ | Approved exchange-rate snapshot |
| `sourceAmountUsd` | String | ✅ | Approved USD source amount |
| `commissionRatePercent` | String | ✅ | Trusted backend config rate snapshot |
| `commissionAmountUsd` | String | ✅ | `sourceAmountUsd * rate / 100`, rounded 2dp |
| `commissionCurrency` | String | ✅ | `USD` |
| `status` | String | ✅ | `AVAILABLE`, `LOCKED`, `PAID`, `CANCELLED`; new records are `AVAILABLE` |
| `payoutRequestId` | ObjectId → ReferralPayoutRequest | ❌ | Set only while locked/paid through a payout request |
| `availableAt` | Date | ✅ | Deposit approval timestamp |
| `lockedAt` / `paidAt` / `cancelledAt` | Date | ❌ | Null on Phase 2C creation |
| `referralSource` | String | ❌ | Source copied from referred user |
| `referredAt` | Date | ✅ | Referral attribution timestamp |
| `calculationVersion` | String | ✅ | `v1` |
| `policySource` | String | ✅ | `ENV_REFERRAL_COMMISSION` |
| `idempotencyKey` | String | ✅ | `deposit:<depositId>:referral-commission:v1` |

**Indexes:**
```
unique_referral_commission_per_deposit      unique on depositId
unique_referral_commission_idempotency_key  unique on idempotencyKey
referrerId + status + createdAt -1
referredUserId + createdAt -1
walletTransactionId
payoutRequestId
```

No referrer wallet credit happens during deposit approval. Phase 2E payout request and settlement transactions are the only current workflow that locks commissions or marks them `PAID`. There is no cancellation endpoint, commission amount editing, or retroactive backfill.

---

## ReferralPayoutRequest

**Collection:** `referralpayoutrequests`

Payout request created by a referrer for an exact immutable set of own `AVAILABLE` commissions.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `referrerId` | ObjectId → User | ✅ | Owner of all selected commissions |
| `commissionIds` | ObjectId[] → ReferralCommission | ✅ | Exact immutable commission set |
| `amountUsd` | String | ✅ | Sum of persisted commission snapshots |
| `currency` | String | ✅ | `USD` |
| `method` | String | ✅ | `WALLET` or `MANUAL` |
| `status` | String | ✅ | `PENDING`, `PAID`, or `REJECTED`; default `PENDING` |
| `idempotencyKey` | String | ✅ | Server-generated key from referrer, sorted commission ids, method, and version |
| `requestedAt` | Date | ✅ | Request creation timestamp |
| `reviewedBy` / `reviewedAt` | ObjectId/Date | ❌ | Admin review metadata |
| `paidAt` / `rejectedAt` | Date | ❌ | Terminal timestamps |
| `walletTransactionId` | ObjectId → WalletTransaction | ❌ | Present only for `WALLET` settlement |
| `externalReference` | String | ❌ | Required for `MANUAL` settlement |
| `manualSettlementNote` | String | ❌ | Optional admin note for manual settlement |
| `rejectionReason` | String | ❌ | Required for rejection |
| `requestSnapshot` | Object | ✅ | Immutable commission count, ids, amount, currency, and method at request time |

**Indexes:**
```
unique_referral_payout_idempotency_key  unique on idempotencyKey
referrerId + status + requestedAt -1
status + method + requestedAt -1
```

State transitions are intentionally small: `PENDING -> REJECTED` unlocks every commission back to `AVAILABLE`; `PENDING -> PAID` marks every linked commission `PAID`. `WALLET` settlement creates one idempotent wallet ledger row with `sourceType = REFERRAL_PAYOUT`; `MANUAL` settlement does not credit the wallet.

---

## ResellerApplication

**Collection:** `resellerapplications`

Commercial reseller/sub-agent application created by an active customer and reviewed by an admin/supervisor with `MANAGE_USERS`. "Sub-Agent" is a customer-facing label for the same backend `RESELLER` commercial workflow. It is not an authentication role.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `userId` | ObjectId -> User | Yes | Applicant; one pending application per user |
| `applicationNumber` | String | Yes | Immutable generated number |
| `status` | String | Yes | `PENDING`, `APPROVED`, `REJECTED`, `SUSPENDED`; default `PENDING` |
| `businessName` | String | Yes | Applicant business/display name |
| `businessType` | String | Yes | `INDIVIDUAL`, `STORE`, `AGENCY`, `OTHER` |
| `country` / `city` | String | Yes | Normalized location strings |
| `expectedMonthlyVolume` | String | Yes | Non-negative Decimal string snapshot |
| `experienceSummary` | String | Yes | Admin review text |
| `salesChannels` | String[] | No | `ONLINE`, `OFFLINE`, `SOCIAL`, `MARKETPLACE`, `OTHER` |
| `targetMarkets` | String[] | No | Safe market labels |
| `websiteUrl` / `socialProfileUrl` | String | No | HTTP/HTTPS URLs only |
| `contactPhone` | String | Yes | Masked in admin serializers |
| `preferredContactMethod` | String | Yes | `PHONE`, `WHATSAPP`, `EMAIL` |
| `requestedGroupId` | ObjectId -> Group | No | Reserved review input; users cannot set assignment |
| `assignedGroupId` | ObjectId -> Group | No | Reseller pricing Group assigned on approval |
| `previousGroupId` | ObjectId -> Group | No | User's Group before approval |
| `submittedAt` | Date | Yes | Application submission timestamp |
| `reviewedBy` / `reviewedAt` | ObjectId/Date | No | Admin review metadata |
| `approvedAt` / `rejectedAt` | Date | No | Terminal review timestamps |
| `rejectionReason` | String | No | Safe applicant-visible reason |
| `suspendedAt` / `suspensionReason` | Date/String | No | Suspension metadata |
| `reactivatedAt` | Date | No | Latest reactivation timestamp |
| `applicationSnapshot` | Mixed | No | Point-in-time commercial/group metadata |
| `idempotencyKey` | String | Yes | Immutable server-generated key |

**Indexes:**
```
unique_reseller_application_number          unique on applicationNumber
unique_reseller_application_idempotency_key unique on idempotencyKey
unique_pending_reseller_application_per_user partial unique on userId + status where status=PENDING
status + submittedAt -1
assignedGroupId + status
```

State transitions are `PENDING -> APPROVED|REJECTED`, `APPROVED -> SUSPENDED`, and `SUSPENDED -> APPROVED`. Approval/rejection/suspension/reactivation update `ResellerApplication` and `User` together in a MongoDB transaction with bounded retry. Suspension moves the user to the explicit Default Group; reactivation restores the assigned reseller Group or an admin-selected replacement. No production index creation or legacy repair is implied by this documentation.

---

## Currency

**Collection:** `currencies`

Two-layer exchange rate system. Products are priced in USD internally; `platformRate` converts to user currency at order time.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `code` | String | ✅ | ISO 4217, e.g. `USD`, `SAR`. Unique |
| `name` | String | ✅ | e.g. `"Saudi Riyal"` |
| `symbol` | String | ✅ | e.g. `"﷼"` |
| `marketRate` | Number | ❌ | Raw rate from external exchange API. 1 USD = N units |
| `platformRate` | Number | ✅ | Admin-controlled rate used in all billing calculations |
| `markupPercentage` | Number | — | Admin spread on top of market rate. Default `0` |
| `isActive` | Boolean | — | Default `true` |
| `lastUpdatedAt` | Date | ❌ | Last time rates were synced/updated |

**Virtuals:**
- `effectiveRate` = `marketRate × (1 + markupPercentage/100)`
- `spreadPercent` = `((platformRate - marketRate) / marketRate) × 100`

---

## AuditLog

**Collection:** `auditlogs`

Immutable event records. The schema's pre-hooks block all update/delete operations at the database level.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `actorId` | ObjectId → User | ❌ | Who performed the action |
| `actorRole` | String | ❌ | `ADMIN` \| `CUSTOMER` \| `SYSTEM` |
| `action` | String | ✅ | Enum of ALL_ACTIONS constants |
| `entityType` | String | ✅ | Enum: `USER`, `ORDER`, `PRODUCT`, `WALLET`, `DEPOSIT`, `PROVIDER`, `SETTING` |
| `entityId` | ObjectId | ❌ | The affected document's ID |
| `metadata` | Mixed | ❌ | Contextual data. Sensitive keys auto-redacted |
| `ipAddress` | String | ❌ | Client IP |
| `userAgent` | String | ❌ | Client user-agent string |

**Notable audit actions:**
`USER_REGISTERED`, `USER_LOGIN`, `USER_LOGIN_BLOCKED`, `USER_APPROVED`, `USER_REJECTED`, `ORDER_CREATED`, `WALLET_DEBIT`, `WALLET_CREDIT`, `ORDER_REFUNDED`, `DEPOSIT_REQUESTED`, `DEPOSIT_APPROVED`, `DEPOSIT_REJECTED`, `PROVIDER_ORDER_PLACED`, `PROVIDER_ORDER_PLACE_FAILED`

---

## Setting

**Collection:** `settings`

Key-value store for runtime platform configuration. Seeded with defaults on startup (idempotent).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `key` | String | ✅ | Unique identifier |
| `value` | Mixed | ✅ | Boolean, number, string, or object |
| `description` | String | ❌ | Human-readable setting description |
| `updatedBy` | ObjectId → User | ❌ | Last admin who changed this setting |

---

## Indexes Summary

| Collection | Index | Type |
|-----------|-------|------|
| `users` | `email` | unique |
| `users` | `googleId` | unique sparse |
| `users` | `status`, `role`, `groupId` | single |
| `users` | `referralCode` | unique partial (`unique_referral_code`) |
| `users` | `referredBy + referredAt` | compound, supports read-only invitee history |
| `orders` | `userId + createdAt` | compound |
| `orders` | `userId + idempotencyKey` | unique sparse |
| `orders` | `orderNumber` | partial unique for non-empty strings only (`unique_order_number_non_empty`) |
| `orders` | `status + providerOrderId + lastCheckedAt` | compound (cron) |
| `providerproducts` | `provider + externalProductId` | unique |
| `wallettransactions` | `userId + createdAt` | compound |
| `wallettransactions` | `userId + sourceType + sourceId + operation` | partial unique (`unique_wallet_source_operation`) |
| `depositrequests` | `status + createdAt` | compound |
| `depositrequests` | `userId + createdAt` | compound |
| `referralcommissions` | `depositId` | unique (`unique_referral_commission_per_deposit`) |
| `referralcommissions` | `idempotencyKey` | unique (`unique_referral_commission_idempotency_key`) |
| `referralcommissions` | `referrerId + status + createdAt` | compound |
| `referralcommissions` | `referredUserId + createdAt` | compound |
| `referralcommissions` | `walletTransactionId` | single |
| `referralcommissions` | `payoutRequestId` | single |
| `referralpayoutrequests` | `idempotencyKey` | unique (`unique_referral_payout_idempotency_key`) |
| `referralpayoutrequests` | `referrerId + status + requestedAt` | compound |
| `referralpayoutrequests` | `status + method + requestedAt` | compound |
| `resellerapplications` | `applicationNumber` | unique (`unique_reseller_application_number`) |
| `resellerapplications` | `idempotencyKey` | unique (`unique_reseller_application_idempotency_key`) |
| `resellerapplications` | `userId + status` | partial unique (`unique_pending_reseller_application_per_user`) |
| `resellerapplications` | `status + submittedAt` | compound |
| `resellerapplications` | `assignedGroupId + status` | compound |

---

## Schema Relationships

```
Group ←────────── User ←────────── Order ──────────────── Product
                    │                │                        │
                    │                └──── WalletTransaction  │
                    │                                         │
                    └──────────── DepositRequest         ProviderProduct
                                                               │
                                                           Provider
```

- Every `User` belongs to one `Group`
- Every `Order` references one `User` and one `Product` (snapshot-frozen at creation)
- Every `Order` may reference one `WalletTransaction` (debit), and another on refund
- Every `Product` may link to one `ProviderProduct`
- Every `ProviderProduct` belongs to one `Provider`
- `AuditLog` references any entity by `entityId + entityType` (polymorphic, no FK)
