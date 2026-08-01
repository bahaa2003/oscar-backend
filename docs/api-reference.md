# API Reference

All endpoints are prefixed with `/api`. All request/response bodies are `application/json` unless noted.

**Authentication:** Include the JWT in the `Authorization` header:
```
Authorization: Bearer <token>
```

**Standard response envelope:**
```json
{ "success": true, "message": "...", "data": { ... } }
```
**Paginated response envelope:**
```json
{
  "success": true,
  "data": [...],
  "pagination": { "page": 1, "limit": 20, "total": 47, "pages": 3 }
}
```
**Error response:**
```json
{ "success": false, "message": "...", "code": "MACHINE_CODE", "statusCode": 422 }
```

---

## Table of Contents

- [Authentication](#authentication)
- [User Panel — /api/me](#user-panel--apime)
- [Orders](#orders)
- [Products (Public)](#products-public)
- [Wallet](#wallet)
- [Referral Dashboard](#referral-dashboard)
- [Reseller Applications](#reseller-applications)
- [Deposits](#deposits)
- [Admin — Users](#admin--users)
- [Admin — Orders](#admin--orders)
- [Admin — Wallets](#admin--wallets)
- [Admin — Products & Catalog](#admin--products--catalog)
- [Admin — Providers](#admin--providers)
- [Admin — Deposits](#admin--deposits)
- [Admin — Groups](#admin--groups)
- [Admin — Currencies](#admin--currencies)
- [Admin — Settings](#admin--settings)
- [Admin — Audit Logs](#admin--audit-logs)

---

## Authentication

### POST /api/auth/register

Create a new customer account. Sends an email verification link.

**Body:**
```json
{ "name": "John Doe", "email": "john@example.com", "password": "securepass123" }
```
**Response `201`:**
```json
{
  "success": true,
  "message": "Registration successful. Please check your email to verify your account.",
  "data": { "user": { "_id": "...", "name": "John Doe", "email": "john@example.com", "status": "PENDING" } }
}
```
**Errors:** `400 VALIDATION_ERROR`, `409 CONFLICT` (email taken)

---

### POST /api/auth/login

Authenticate and receive a JWT. Requires email verification and admin approval.

**Body:**
```json
{ "email": "john@example.com", "password": "securepass123" }
```
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGci...",
    "user": { "_id": "...", "name": "John Doe", "role": "CUSTOMER", "status": "ACTIVE" }
  }
}
```
**Errors:** `400 VALIDATION_ERROR`, `401 AUTHENTICATION_ERROR`, `403` (not verified / not approved)

---

### GET /api/auth/verify-email?token=RAW_TOKEN

Verify email address via the link in the registration email.

**Response `200`:**
```json
{ "success": true, "message": "Email verified successfully. Your account is now pending admin approval." }
```
**Errors:** `400` (invalid or expired token)

---

### POST /api/auth/resend-verification

Re-send the email verification link.

**Body:** `{ "email": "john@example.com" }`

**Response `200`:** `{ "success": true, "message": "Verification email resent." }`

---

### GET /api/auth/google

Redirect to Google consent screen. Requires `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` to be configured.

---

### GET /api/auth/google/callback

Google OAuth callback. Returns JWT + user on success.

New Google users may receive `profileCompletionRequired: true` and `missingProfileFields` after the one-time PKCE handoff is exchanged. The frontend must route those users to the existing profile-completion screen before protected application pages are used.

**Response `200`:**
```json
{ "success": true, "data": { "token": "...", "user": { ... } } }
```

---

## User Panel — /api/me

All routes require `Authorization: Bearer <token>` and `status === ACTIVE`.

### GET /api/me

Returns authenticated user's profile and wallet balance.

### PATCH /api/me/profile-completion

Authenticated active Google users with incomplete profile data complete their server-owned profile by submitting `country` and `currency`. If OAuth started from a trusted referral state, the backend preserves that inviter and the returned profile metadata marks the referral as locked; the client must not replace it. If OAuth started without referral, one optional referral code may be supplied while the profile is incomplete and `referredBy` has never been set. Existing Google users and email-linked accounts cannot acquire or replace referral attribution through this endpoint.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "...", "name": "John Doe", "email": "john@example.com",
      "walletBalance": 150.00, "currency": "USD",
      "role": "CUSTOMER", "status": "ACTIVE"
    }
  }
}
```

---

### GET /api/me/wallet

Wallet summary with 5 most recent transactions.

**Response `200`:**
```json
{
  "data": {
    "walletBalance": 150.00,
    "currency": "USD",
    "recentTransactions": [ { "type": "DEBIT", "amount": 10, "createdAt": "..." } ]
  }
}
```

---

### GET /api/me/wallet/transactions

Paginated wallet transaction history.

**Query:** `?page=1&limit=20`

**Response `200`:** Paginated list of `WalletTransaction` documents.

---

### GET /api/me/products

Browse the active product catalogue.

**Query:** `?search=diamonds&page=1&limit=20`

**Response `200`:**
```json
{
  "data": [
    {
      "_id": "...", "name": "Free Fire Diamonds", "basePrice": 9.99,
      "category": "games", "orderFields": [ ... ]
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 5, "pages": 1 }
}
```

---

### GET /api/me/products/:id

Single product detail including `orderFields`.

**Response `200`:**
```json
{
  "data": {
    "product": {
      "_id": "...", "name": "Free Fire Diamonds",
      "orderFields": [
        { "id": "f1", "key": "player_id", "label": "Player ID", "type": "text", "required": true },
        { "id": "f2", "key": "server", "label": "Server", "type": "select", "options": ["NA","EU"] }
      ]
    }
  }
}
```

**Errors:** `404 NOT_FOUND`

---

### POST /api/me/orders

Place an order. Validates dynamic fields, debits wallet, and (for automatic products) dispatches to the provider.

**Body:**
```json
{
  "productId": "64abc...",
  "quantity": 1,
  "orderFieldsValues": {
    "player_id": "hero_123",
    "server": "EU"
  },
  "idempotencyKey": "client-generated-uuid"
}
```

**Response `201`:**
```json
{
  "success": true,
  "message": "Order placed successfully.",
  "data": {
    "order": {
      "_id": "...",
      "status": "PENDING",
      "totalPrice": 10.99,
      "customerInput": {
        "values": { "player_id": "hero_123", "server": "EU" },
        "fieldsSnapshot": [ { "key": "player_id", "label": "Player ID", "type": "text" } ]
      }
    }
  }
}
```

**Errors:**
| Code | Meaning |
|------|---------|
| `400 VALIDATION_ERROR` | `productId` or `quantity` invalid |
| `404 NOT_FOUND` | Product not found or inactive |
| `422 INVALID_ORDER_FIELDS` | Dynamic field validation failed |
| `422 INSUFFICIENT_FUNDS` | Wallet balance too low |
| `422 BUSINESS_RULE_VIOLATION` | Product inactive, qty out of range, etc. |
| `409 CONFLICT` | Duplicate idempotency key |

---

### GET /api/me/orders

My order history.

**Query:** `?status=COMPLETED&page=1&limit=20`

**Response `200`:** Paginated list of orders.

---

### GET /api/me/orders/:id

Single order detail (ownership enforced — cannot view other users' orders).

**Errors:** `403 AUTHORIZATION_ERROR`, `404 NOT_FOUND`

---

### POST /api/deposits

Submit a wallet deposit request. The active route accepts multipart/form-data with a receipt file.

**Body (multipart/form-data):**
```
requestedAmount: 100
currency: EGP
paymentMethodId: vodafone-cash
senderWalletNumber: "+1-555-0100"
receipt: <file>
```

**Response `201`:**
```json
{
  "data": {
    "deposit": {
      "_id": "...", "status": "PENDING",
      "requestedAmount": 100,
      "currency": "EGP",
      "exchangeRate": 50,
      "amountUsd": 2,
      "receiptImage": "uploads/deposits/...",
      "createdAt": "..."
    }
  }
}
```

---

### GET /api/me/deposits

My deposit history (paginated).

---

### GET /api/me/deposits/:id

Single deposit detail (ownership enforced).

---

## Orders

Legacy/direct order endpoints (also covered by `/api/me/orders`).

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/orders` | Active Customer | Place order |
| `GET` | `/api/orders/my` | Active Customer | My orders |
| `GET` | `/api/orders/my/:id` | Active Customer | My order by ID |
| `GET` | `/api/orders` | Admin | All orders |
| `GET` | `/api/orders/:id` | Admin | Any order by ID |
| `PATCH` | `/api/orders/:id/fail` | Admin | Mark failed + refund |
| `PATCH` | `/api/orders/:id/complete` | Admin | Mark completed |

---

## Products (Public)

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/products` | Any | Active product list |
| `GET` | `/api/products/:id` | Any | Product detail |

---

## Admin — Users

All admin routes require `Authorization: Bearer <admin-token>`.

### GET /api/admin/users

List users with pagination and filters.

**Query:** `?status=PENDING&email=john&page=1&limit=20`

**Response `200`:** Paginated user list.

---

### GET /api/admin/users/:id

Full user detail including group population.

---

### PATCH /api/admin/users/:id

Update user profile.

**Body:** `{ "name": "Updated Name", "status": "ACTIVE" }`

**Errors:** `409 CONFLICT` (email), `400 VALIDATION_ERROR`

---

### DELETE /api/admin/users/:id

Soft-delete a user (sets `deletedAt`). Cannot delete admins.

**Errors:** `422 CANNOT_DELETE_ADMIN`

---

### PATCH /api/admin/users/:id/approve

Approve a PENDING user (allows login).

---

### PATCH /api/admin/users/:id/reject

Reject a user (blocks login).

---

## Admin — Orders

### GET /api/admin/orders

**Query:** `?status=PROCESSING&userId=...&page=1&limit=50`

---

### GET /api/admin/orders/:id

Full order detail including `customerInput`.

---

### POST /api/admin/orders/:id/retry

Retry a FAILED automatic order (re-dispatches to provider).

---

### POST /api/admin/orders/:id/refund

Manually fully refund an order.

---

## Admin — Wallets

### GET /api/admin/wallets

Paginated list of all user wallets.

---

### GET /api/admin/wallets/:userId

Single user wallet summary.

---

### GET /api/admin/wallets/:userId/transactions

Paginated transaction history for a user.

---

### POST /api/admin/wallets/:userId/add

Credit a user's wallet.

**Body:** `{ "amount": 100, "reason": "Manual top-up" }`

**Errors:** `422` (amount <= 0 or > 100000)

---

### POST /api/admin/wallets/:userId/deduct

Debit a user's wallet.

**Body:** `{ "amount": 50, "reason": "Correction" }`

**Errors:** `422 INSUFFICIENT_BALANCE`

---

## Admin — Products & Catalog

### GET /api/admin/products

All products including inactive.

**Query:** `?page=1&limit=50`

---

### POST /api/admin/products

Create a standalone platform product (no provider link required).

**Body:**
```json
{
  "name": "Free Fire Diamonds",
  "basePrice": 9.99,
  "minQty": 1,
  "maxQty": 10000,
  "description": "Instant delivery",
  "category": "games",
  "executionType": "automatic",
  "orderFields": [
    {
      "id": "f1", "key": "player_id", "label": "Player ID",
      "type": "text", "required": true, "isActive": true
    }
  ],
  "providerMapping": { "player_id": "link" }
}
```

**Response `201`:** Newly created product document.

---

### POST /api/admin/products/from-provider

Publish a provider product as a platform product.

**Body:**
```json
{
  "providerProductId": "64abc...",
  "name": "Custom Name",
  "basePrice": 9.99,
  "pricingMode": "manual",
  "executionType": "automatic"
}
```

---

### PATCH /api/admin/products/:id

Update a product. Supports partial updates.

**Body (any subset):**
```json
{
  "name": "New Name",
  "isActive": true,
  "orderFields": [ ... ],
  "providerMapping": { "player_id": "link" }
}
```

---

### PATCH /api/admin/products/:id/toggle

Toggle `isActive` flag.

---

### POST /api/admin/catalog/sync

Sync all active providers.

**Response `200`:**
```json
{
  "data": {
    "results": [
      { "providerId": "...", "name": "Royal Crown", "synced": 45, "errors": 0 }
    ]
  }
}
```

---

### POST /api/admin/catalog/sync/:providerId

Sync a single provider.

---

### GET /api/admin/provider-products

All raw provider products.

**Query:** `?page=1&limit=50`

---

### GET /api/admin/provider-products/:providerId

Raw products for one provider.

---

### GET /api/admin/provider-products/item/:id

Single raw provider product by internal ID.

---

### PATCH /api/admin/provider-products/item/:id/translated-name

Set a human-friendly name override (not overwritten by future syncs).

**Body:** `{ "translatedName": "Free Fire Diamonds 100" }`

---

## Admin — Providers

### GET /api/admin/providers

List all providers.

---

### POST /api/admin/providers

Create a new provider.

**Body:**
```json
{
  "name": "Royal Crown",
  "baseUrl": "https://royal-croown.com",
  "apiToken": "secret123",
  "syncInterval": 60
}
```

---

### GET /api/admin/providers/:id

Provider detail.

---

### PATCH /api/admin/providers/:id

Update provider.

---

### DELETE /api/admin/providers/:id

Soft-delete provider.

---

### PATCH /api/admin/providers/:id/toggle

Toggle `isActive`.

---

### GET /api/admin/providers/:id/balance

Fetch live balance from the provider API.

**Response `200`:**
```json
{ "data": { "balance": 1250.50, "currency": "USD" } }
```

---

### GET /api/admin/providers/:id/products

Fetch live product list directly from the provider API (not from cached ProviderProducts).

Provider product price fields are returned as canonical Decimal strings where exposed through admin/provider catalog serializers. Adapter credentials, raw authorization headers, and provider secrets are never returned.

---

## Admin — Deposits

### GET /api/admin/deposits

**Query:** `?status=PENDING&page=1&limit=20`

---

### GET /api/admin/deposits/:id

Single deposit detail.

---

### PATCH /api/admin/deposits/:id/approve

Approve a deposit and credit the user's wallet inside one MongoDB transaction. The transaction claims the deposit by `_id + PENDING`, reruns final financial validation, updates approval snapshots, credits `User.walletBalance`, inserts one `WalletTransaction` with `sourceType`, `sourceId`, `operation`, and `idempotencyKey`, evaluates referral commission eligibility, inserts one `ReferralCommission` when eligible, and stores `referralCommissionEvaluation` on the deposit. Audit and notification side effects run after commit only. MongoDB must support transactions; there is no unsafe non-transaction fallback.

Referral commission rate comes only from trusted backend config (`REFERRAL_COMMISSION_ENABLED`, `REFERRAL_COMMISSION_RATE_PERCENT`). Disabled, zero-rate, expired-window, or expected ineligible referrals still allow the deposit approval to succeed without a commission. Eligibility lasts exactly 30 x 24 hours from `User.referredAt`; approvals at the exact end timestamp are not eligible. Eligible commission insert or evaluation snapshot failure rolls back the deposit approval, wallet credit, and wallet ledger. Deposit approval creates commission records only; it does not credit the referrer's wallet or settle payouts. Phase 4C commission records keep USD analytical snapshots and the payable amount in the referrer's account currency.

**Body:** `{ "amount": 95, "currency": "EGP" }` (optional correction fields)

**Response `200`:**
```json
{ "message": "Deposit approved and wallet credited.", "data": { ... } }
```

**Errors:** `422 DEPOSIT_ALREADY_REJECTED`, `422 DEPOSIT_RECONCILIATION_REQUIRED`, `422 DEPOSIT_APPROVAL_RETRY_EXHAUSTED`, `422 FINANCIAL_TRANSACTION_UNAVAILABLE`, `422 INVALID_REFERRAL_COMMISSION_CONFIG`

---

### PATCH /api/admin/deposits/:id/reject

Reject a deposit (wallet not affected).

**Errors:** `422 DEPOSIT_ALREADY_REJECTED`, `422 DEPOSIT_ALREADY_APPROVED`

---

## Admin — Groups

### GET /api/admin/groups

All groups including inactive.

---

### POST /api/admin/groups

**Body:** `{ "name": "VIP", "percentage": 5 }`

---

### PATCH /api/admin/groups/:id

**Body:** `{ "percentage": 10, "isActive": true }`

---

### DELETE /api/admin/groups/:id

Deactivate a group (sets `isActive: false`).

---

## Admin — Currencies

### GET /api/admin/currencies

All currencies sorted by code.

---

### PATCH /api/admin/currencies/:code

Update a currency's platform rate and optional payable precision.

**Body:**
```json
{ "platformRate": 3.75, "decimalPlaces": 2, "markupPercentage": 2, "isActive": true }
```

`decimalPlaces` is an integer from `0` to `6`. It controls destination-currency rounding for new referral commission payable amounts and payout payable totals. It does not reprice or rewrite existing immutable snapshots.

---

## Admin — Settings

### GET /api/admin/settings

All settings.

---

### GET /api/admin/settings/:key

Single setting by key.

---

### PATCH /api/admin/settings/:key

Update a setting value.

**Body:** `{ "value": true }` or `{ "value": 42 }` or `{ "value": "some-string" }`

---

## Admin — Audit Logs

### GET /api/admin/audit

Query audit logs by entity.

**Query:** `?entityType=ORDER&entityId=64abc...&page=1&limit=50`

---

### GET /api/admin/audit/actor/:actorId

All audit logs for a specific actor (admin).

**Query:** `?page=1&limit=50`

---

## Referral Dashboard

All referral dashboard endpoints require a valid JWT for an `ACTIVE` user. User-facing APIs never accept `referrerId`, `userId`, or `referredBy` as an ownership override; the backend always derives `referrerId = req.user._id`.

### GET /api/referrals/me/dashboard

Returns the authenticated user's own referral code, a relative invite path, referred-user count, and commission totals aggregated from persisted `ReferralCommission` records.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "referral": {
      "code": "ABC12345",
      "sharePath": "/auth?mode=signup&ref=ABC12345"
    },
    "referrals": {
      "total": 12
    },
    "commissions": {
      "count": 8,
      "totals": {
        "available": "15.50",
        "locked": "0.00",
        "paid": "0.00",
        "cancelled": "0.00"
      },
      "currency": "USD"
    }
  }
}
```

Money totals are canonical Decimal strings. The API does not expose `referredBy`, private referrer metadata, wallet balance, or frontend origin. The frontend may combine `sharePath` with `window.location.origin`.

### GET /api/referrals/me/commissions

Read-only commission history for the authenticated referrer.

**Query:**
| Param | Validation |
|-------|------------|
| `status` | `AVAILABLE`, `LOCKED`, `PAID`, or `CANCELLED` |
| `page` | Integer `>= 1` |
| `limit` | Integer `1..100` |
| `dateFrom` / `dateTo` | ISO dates; `dateFrom <= dateTo` |

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "64com...",
        "status": "AVAILABLE",
        "sourceAmountUsd": "100.00",
        "commissionRatePercent": "5",
        "commissionAmountUsd": "5.00",
        "commissionCurrency": "USD",
        "availableAt": "2026-07-30T10:00:00.000Z",
        "lockedAt": null,
        "paidAt": null,
        "cancelledAt": null,
        "createdAt": "2026-07-30T10:00:00.000Z"
      }
    ],
    "pagination": { "page": 1, "limit": 10, "total": 1, "pages": 1 }
  }
}
```

This endpoint does not expose referred-user email/phone, referrer IDs, idempotency keys, policy internals, wallet metadata, deposits, receipts, or admin notes. It does not mutate commission status and does not create payouts.

### GET /api/referrals/me/invitees

Privacy-safe referred-user history for the authenticated referrer.

**Query:**
| Param | Validation |
|-------|------------|
| `source` | `EMAIL_REGISTRATION` or `GOOGLE_OAUTH` |
| `page` | Integer `>= 1` |
| `limit` | Integer `1..100` |
| `dateFrom` / `dateTo` | ISO dates; `dateFrom <= dateTo` |

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "64usr...",
        "displayName": "Invitee",
        "maskedEmail": "a***@example.com",
        "joinedAt": "2026-07-30T10:00:00.000Z",
        "referralSource": "EMAIL_REGISTRATION",
        "commissionSummary": {
          "count": 2,
          "totalAvailableUsd": "7.50"
        }
      }
    ],
    "pagination": { "page": 1, "limit": 10, "total": 1, "pages": 1 }
  }
}
```

Deleted invitees are excluded. Non-deleted invitees are included regardless of later account status, but no account-status internals, phone numbers, wallet balances, group pricing, addresses, or Google IDs are returned. Invitee commission totals are grouped in one aggregate query rather than one commission query per invitee.

### POST /api/referrals/me/payouts

Creates a payout request for selected own `AVAILABLE` commissions. The client submits commission ids and a requested method only; the backend derives `referrerId` from the JWT and calculates canonical totals from persisted commission snapshots. New currency-aware payouts require every selected commission to share the same `commissionCurrency`; mixed-currency requests are rejected. Responses include USD analytical `amountUsd` and payable `amount/currency`.

**Body:**
```json
{
  "commissionIds": ["64com..."],
  "method": "WALLET"
}
```

`method` is `WALLET` or `MANUAL`. The request transaction creates `ReferralPayoutRequest(PENDING)`, locks all selected commissions with `status = LOCKED`, sets `payoutRequestId`, and stores immutable request snapshot data. Duplicate identical requests verify persisted state rather than double-locking commissions.

**Response `201`:**
```json
{
  "success": true,
  "data": {
    "id": "64pay...",
    "status": "PENDING",
    "method": "WALLET",
    "amountUsd": "15.50",
    "amount": "775.00",
    "currency": "EGP",
    "commissionCount": 3,
    "requestedAt": "2026-07-30T10:00:00.000Z"
  }
}
```

### GET /api/referrals/me/payouts

Returns the authenticated referrer's own payout history. Supports `status`, `method`, `page`, `limit`, `dateFrom`, and `dateTo`. Decimal amounts remain strings. No wallet balance, internal idempotency key, admin notes, or foreign referrer data is returned. The browser must display the backend `currency` and must not convert or mix currencies locally.

### GET /api/referrals/me/payouts/:id

Returns one payout request owned by the authenticated referrer. Requests owned by another user are not returned.

---

## Reseller Applications

Phase 3A exposes authenticated customer reseller/sub-agent application APIs. "Sub-Agent" is a customer-facing label for the same backend `RESELLER` commercial workflow. Reseller state is not an auth role; the backend never adds `RESELLER` or `SUB_AGENT` to JWT roles.

All routes require a valid JWT and `status === ACTIVE`. The backend derives `userId = req.user._id`; client-supplied state fields such as `status`, `reviewedBy`, `assignedGroupId`, or `resellerStatus` are ignored by validation and service normalization.

### POST /api/reseller-applications/me

Submits one pending application for the current user.

**Body:**
```json
{
  "businessName": "Oscar Partner Store",
  "businessType": "STORE",
  "country": "Egypt",
  "city": "Cairo",
  "expectedMonthlyVolume": "2500",
  "experienceSummary": "We serve gaming customers and need reseller pricing.",
  "salesChannels": ["ONLINE", "SOCIAL"],
  "targetMarkets": ["Egypt"],
  "contactPhone": "+201001112223",
  "preferredContactMethod": "WHATSAPP"
}
```

Duplicate identical pending submissions return the existing pending application. A different payload while a pending application exists returns a conflict. Rejected users may reapply subject to `RESELLER_REAPPLICATION_COOLDOWN_DAYS`.

### GET /api/reseller-applications/me/current

Returns the current commercial reseller state, `canApply`, and the latest application for the authenticated user.

### GET /api/reseller-applications/me/history

Returns the current user's own reseller application history with `page` and `limit` pagination. The response is privacy-safe and does not expose reviewer identity, full internal snapshots, or group pricing internals.

---

## Admin Referral Payouts

All admin referral payout endpoints require an authenticated admin/supervisor with the existing wallet-management permission. They do not expose payout status mutation to ordinary users and do not call an external payment provider.

### GET /api/admin/referral-payouts

Lists payout requests with optional `status`, `method`, `search`, `page`, `limit`, `dateFrom`, and `dateTo` filters. Referrer email is masked in list output.

### GET /api/admin/referral-payouts/:id

Returns admin-safe payout details, including method, status, amount, commission count, and settlement metadata needed for review.

### POST /api/admin/referral-payouts/:id/reject

Rejects a `PENDING` payout transactionally: payout becomes `REJECTED`, every linked commission moves `LOCKED -> AVAILABLE`, `payoutRequestId`/`lockedAt` are cleared, and audit/notification side effects run after commit.

### POST /api/admin/referral-payouts/:id/settle

Settles a `PENDING` payout transactionally. `WALLET` settlement credits the referrer's wallet exactly once and writes one `WalletTransaction` with `sourceType = REFERRAL_PAYOUT`; `MANUAL` settlement requires `externalReference` and never credits the wallet. Both methods mark all linked commissions `PAID` and the payout `PAID`.

---

## Admin Reseller Applications

All admin reseller application endpoints require an authenticated admin/supervisor with `MANAGE_USERS`. Admin role alone does not grant cross-user access through customer endpoints; admin review uses these dedicated admin routes.

### GET /api/admin/reseller-applications

Lists applications with optional `status`, `country`, `businessType`, `search`, `page`, `limit`, `dateFrom`, and `dateTo` filters. Applicant email is masked in list output.

### GET /api/admin/reseller-applications/:id

Returns admin-safe details for one application, including masked applicant contact data and safe group references.

### POST /api/admin/reseller-applications/:id/approve

Approves a `PENDING` application and assigns an active, non-deleted pricing Group in one MongoDB transaction.

```json
{ "assignedGroupId": "64grp..." }
```

The transaction updates `ResellerApplication`, `User.resellerStatus`, `User.resellerGroupId`, and `User.groupId` together. Audit and notification side effects run after commit only.

### POST /api/admin/reseller-applications/:id/reject

Rejects a `PENDING` application, stores a safe rejection reason, sets the user's commercial state to `REJECTED`, and leaves the user's pricing Group unchanged.

```json
{ "rejectionReason": "Insufficient commercial activity." }
```

### POST /api/admin/reseller-applications/:id/suspend

Suspends an `APPROVED` reseller in one transaction. Phase 4C restores the user's saved pre-reseller Group when that Group is still active and non-deleted; otherwise the backend assigns the current highest eligible normal Group. `Group.isDefault` does not control reseller suspension fallback.

```json
{ "suspensionReason": "Paused commercial access." }
```

### POST /api/admin/reseller-applications/:id/reactivate

Reactivates a `SUSPENDED` reseller and restores the previously assigned reseller Group, or an admin-selected replacement Group.

```json
{ "assignedGroupId": "64grp..." }
```

The reseller workflow does not mutate referral attribution, referral commissions, referral payout requests, wallet balances, or authentication roles.
## Pricing — Phase 3B

### POST /api/pricing/me/quote

Authenticated active customers may request a read-only quote:

```json
{
  "items": [{ "productId": "64...", "quantity": 2 }],
  "currency": "USD"
}
```

The backend derives the current user, reseller state, Group, percentage, base product price, exchange rate, final unit price, line totals, subtotal, and total. The client must not submit `unitPrice`, `total`, `groupId`, `percentage`, `resellerStatus`, `exchangeRate`, or `userId`; those fields are rejected as price tampering. Returned money values are Decimal-safe strings.

### GET /api/admin/reseller-pricing/preview

Admins/supervisors with `MANAGE_USERS` can diagnose effective pricing with `userId`, `productId`, `quantity`, and optional `currency`. This is read-only and does not mutate users, Groups, products, orders, wallets, referral commissions, or payouts.

### Order Creation Pricing Contract

`POST /api/me/orders` and `POST /api/orders` recalculate pricing on the backend. Client totals are display previews only. Every new order stores immutable legacy snapshots plus a structured `pricingSnapshot` containing customer commercial state, currency/rate snapshot, item base unit price, Group markup, adjustment, final unit price, quantity, and line totals. Historical orders are not repriced after product, Group, currency, or reseller-state changes.
