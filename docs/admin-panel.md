# Admin Panel

## Overview

The admin panel is a comprehensive REST API layer (prefixed `/api/admin`) for managing every aspect of the platform. All admin routes require a valid JWT with `role === 'ADMIN'`. Authentication and authorization are enforced at the router level — no individual handler needs to repeat the check.

---

## Authentication & Authorization

```js
// admin.routes.js and admin.catalog.routes.js both apply:
router.use(authenticate);       // verify JWT, attach req.user
router.use(authorize('ADMIN')); // assert role === 'ADMIN', else 403
```

Any request to `/api/admin/*` without a valid admin JWT returns:
```json
{ "success": false, "code": "AUTHORIZATION_ERROR", "statusCode": 403,
  "message": "You do not have permission to perform this action" }
```

---

## User Management

### List Users

```http
GET /api/admin/users?status=PENDING&email=john&page=1&limit=20
```

Supports pagination and filtering by `status` (`PENDING`, `ACTIVE`, `REJECTED`) and email substring search.

**Response:**
```json
{
  "data": [
    {
      "_id": "64abc...", "name": "John Doe", "email": "john@example.com",
      "status": "PENDING", "role": "CUSTOMER",
      "walletBalance": 0, "currency": "USD",
      "groupId": { "_id": "...", "name": "Default", "percentage": 20 },
      "createdAt": "2024-03-01T00:00:00Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 3, "pages": 1 }
}
```

### Get One User

```http
GET /api/admin/users/:id
```

Returns full user document with group populated.

### Update User

```http
PATCH /api/admin/users/:id
{ "name": "Updated Name", "groupId": "64xyz..." }
```

Allowed updates: `name`, `email`, `status`, `groupId`, `currency`, `walletBalance`.

### Approve User (PENDING → ACTIVE)

```http
PATCH /api/admin/users/:id/approve
```

Sets `status = ACTIVE`, `approvedBy = adminId`, `approvedAt = now`. Writes `USER_APPROVED` audit log.

### Reject User (PENDING → REJECTED)

```http
PATCH /api/admin/users/:id/reject
```

Sets `status = REJECTED`, `rejectedBy = adminId`, `rejectedAt = now`. Writes `USER_REJECTED` audit log.

### Soft-Delete User

```http
DELETE /api/admin/users/:id
```

Sets `deletedAt = now`. Fails with `422` if trying to delete an admin account.

---

## Order Management

### List All Orders

```http
GET /api/admin/orders?status=PROCESSING&userId=...&page=1&limit=50
```

Returns all orders across all users. Includes `customerInput` fields.

### Get Order Detail

```http
GET /api/admin/orders/:id
```

Full order document including `customerInput.values`, `customerInput.fieldsSnapshot`, pricing snapshots, and provider fulfillment data.

**Example response (relevant fields):**
```json
{
  "status": "PROCESSING",
  "totalPrice": 43.09,
  "currency": "SAR",
  "rateSnapshot": 3.75,
  "usdAmount": 11.49,
  "chargedAmount": 43.09,
  "providerOrderId": 8871234,
  "providerStatus": "Pending",
  "retryCount": 2,
  "lastCheckedAt": "2024-03-10T04:15:00Z",
  "customerInput": {
    "values": { "player_id": "hero_123", "server": "EU" },
    "fieldsSnapshot": [
      { "key": "player_id", "label": "Player ID", "type": "text" }
    ]
  }
}
```

### Retry a Failed Order

Re-dispatches to the provider. Does **not** re-debit the wallet.

```http
POST /api/admin/orders/:id/retry
```

Resets `retryCount = 0`, `status = PENDING`, and calls `executeOrder()` again.

### Manual Refund

Issues a wallet refund immediately and marks the order FAILED.

```http
POST /api/admin/orders/:id/refund
```

### Mark Order Failed (legacy endpoint)

```http
PATCH /api/orders/:id/fail
```

### Mark Order Completed (manual fulfillment)

```http
PATCH /api/orders/:id/complete
```

---

## Wallet Management

### List All Wallets

```http
GET /api/admin/wallets?page=1&limit=50
```

Returns user wallets sorted by walletBalance descending.

### Get User Wallet

```http
GET /api/admin/wallets/:userId
```

Returns the user's `walletBalance`, `currency`, and recent transaction summary.

### Transaction History

```http
GET /api/admin/wallets/:userId/transactions?page=1&limit=50
```

Paginated WalletTransaction history for one user.

### Add Funds

```http
POST /api/admin/wallets/:userId/add
{ "amount": 100, "reason": "Promotional credit" }
```

Calls `creditWalletDirect()` and writes a `CREDIT` WalletTransaction. If a session is supplied by a future transaction boundary, the wallet helper propagates it.

### Deduct Funds

```http
POST /api/admin/wallets/:userId/deduct
{ "amount": 50, "reason": "Correction adjustment" }
```

Calls `debitWalletAtomic()`. Fails if insufficient balance and propagates an optional session when supplied.

---

## Product & Catalog Management

### Create Standalone Product

```http
POST /api/admin/products
```

Create a product with no provider link. Requires full product details including optional `orderFields` and `providerMapping`.

**Body:**
```json
{
  "name": "Free Fire 100 Diamonds",
  "basePrice": 9.99,
  "minQty": 1,
  "maxQty": 1,
  "description": "Instant delivery. Enter your player ID below.",
  "category": "games",
  "executionType": "automatic",
  "isActive": true,
  "orderFields": [
    {
      "id": "f1",
      "key": "player_id",
      "label": "Player ID",
      "type": "text",
      "placeholder": "e.g. 123456789",
      "required": true,
      "isActive": true,
      "sortOrder": 1
    },
    {
      "id": "f2",
      "key": "server",
      "label": "Server Region",
      "type": "select",
      "options": ["NA", "EU", "AS", "ME"],
      "required": true,
      "isActive": true,
      "sortOrder": 2
    }
  ],
  "providerMapping": {
    "player_id": "link",
    "server": "server_id"
  }
}
```

### Create Product from Provider Catalogue

```http
POST /api/admin/products/from-provider
{
  "providerProductId": "64pp...",
  "name": "Netflix 1 Month Premium",
  "basePrice": 15.99,
  "pricingMode": "manual",
  "executionType": "automatic",
  "orderFields": [...],
  "providerMapping": { ... }
}
```

Links the new `Product` to the `ProviderProduct` via `product.providerProduct`.

### Update Product

```http
PATCH /api/admin/products/:id
```

Partial update. The following fields are allowed:
`name`, `description`, `basePrice`, `minQty`, `maxQty`, `category`, `image`,
`displayOrder`, `isActive`, `executionType`, `pricingMode`, `markupType`,
`markupValue`, `orderFields`, `providerMapping`

### Toggle Product Active Status

```http
PATCH /api/admin/products/:id/toggle
```

Flips `isActive`. Inactive products are invisible to customers.

### List Products

```http
GET /api/admin/products?page=1&limit=50
```

Includes all products (active and inactive).

---

## Provider Catalog Sync

### Sync All Providers

```http
POST /api/admin/catalog/sync
```

Calls `adapter.getProducts()` for every active provider and upserts `ProviderProduct` records.

**Response:**
```json
{
  "data": {
    "results": [
      { "name": "Royal Crown", "synced": 45, "new": 3, "updated": 42, "errors": 0 },
      { "name": "Torosfon Store", "synced": 120, "new": 0, "updated": 120, "errors": 0 }
    ]
  }
}
```

### Sync One Provider

```http
POST /api/admin/catalog/sync/:providerId
```

### Browse Provider Products

```http
GET /api/admin/provider-products                    ← all providers
GET /api/admin/provider-products/:providerId         ← one provider
GET /api/admin/provider-products/item/:id            ← single item
```

Returns raw ProviderProduct documents including `rawPayload`. `rawPrice` is a canonical Decimal string; admins must treat it as financial data, not a JavaScript floating-point number.

### Set Translated Name

```http
PATCH /api/admin/provider-products/item/:id/translated-name
{ "translatedName": "Free Fire 500 Diamonds" }
```

Sets a human-friendly override that is **never overwritten** by future syncs.

---

## Provider Management

### List Providers

```http
GET /api/admin/providers
```

### Create Provider

```http
POST /api/admin/providers
{
  "name": "Royal Crown",
  "baseUrl": "https://royal-croown.com",
  "apiToken": "secret123",
  "syncInterval": 60,
  "supportedFeatures": ["placeOrder", "checkOrder", "getBalance"]
}
```

The `slug` is auto-generated from `name` on first save.

### Update Provider

```http
PATCH /api/admin/providers/:id
{ "apiToken": "new-secret", "syncInterval": 120 }
```

### Toggle Provider Active

```http
PATCH /api/admin/providers/:id/toggle
```

Deactivated providers are excluded from sync jobs.

### Delete Provider (Soft)

```http
DELETE /api/admin/providers/:id
```

Sets `deletedAt`. ProviderProducts remain for historical reference.

### Live Provider Balance

```http
GET /api/admin/providers/:id/balance
```

Calls `adapter.getBalance()` on the live API. Returns current balance in provider's currency.

### Live Provider Products

```http
GET /api/admin/providers/:id/products
```

Calls `adapter.getProducts()` directly — bypasses the cached ProviderProduct collection. Use for verifying API connectivity.

---

## Deposit Management

### List Deposits

```http
GET /api/admin/deposits?status=PENDING&page=1&limit=20
```

Sorted by submission time ascending (oldest pending first).

### Get Deposit

```http
GET /api/admin/deposits/:id
```

Returns full deposit including `receiptImage` for receipt verification.

### Approve Deposit

```http
PATCH /api/admin/deposits/:id/review
{ "status": "APPROVED", "amount": 95, "currency": "EGP" }
```

`amount` and `currency` are optional correction fields. If provided, the service recalculates and snapshots `exchangeRate` and `amountUsd`; wallet credit uses the USD amount. Approval now executes inside one MongoDB transaction containing the PENDING deposit claim, final validation, approval snapshot update, wallet credit, `WalletTransaction` insert, referral commission evaluation, eligible `ReferralCommission` insert, and deposit evaluation snapshot update. Audit and notification side effects run after commit only.

MongoDB must support transactions. There is no unsafe non-transaction fallback. Repeated healthy approvals are idempotent and use the stored `referralCommissionEvaluation` snapshot rather than the current referrer state or current rate. Inconsistent legacy deposits, missing CREATED commissions, or conflicting commission snapshots return `DEPOSIT_RECONCILIATION_REQUIRED`.

Phase 2C creates commission records with status `AVAILABLE` only. Phase 2D exposes read-only user dashboard APIs. Phase 2E adds payout review under `/api/admin/referral-payouts` for admins/supervisors with the existing wallet-management permission. Admin rejection changes the payout to `REJECTED` and atomically unlocks linked commissions back to `AVAILABLE`. Admin settlement changes the payout to `PAID` and all linked commissions to `PAID`; `WALLET` settlement also credits the referrer's wallet once through one `WalletTransaction` with `sourceType = REFERRAL_PAYOUT`, while `MANUAL` settlement requires an external reference and does not credit the wallet.

No external payment provider, payout cancellation endpoint, commission amount editing, production migration, or legacy auto-repair is implemented by Phase 2E.

Phase 3A implements the reseller/sub-agent workflow as commercial account state, not as an authentication role. Review APIs are documented below.

---

## Reseller/Sub-Agent Application Review

Phase 3A treats customer-facing "Sub-Agent" and backend `RESELLER` as one commercial workflow. It does not add `RESELLER` or `SUB_AGENT` to auth roles and does not change referral attribution, commission rates, referral payouts, wallet balances, or provider behavior.

Admin review endpoints require `MANAGE_USERS`:

```http
GET  /api/admin/reseller-applications
GET  /api/admin/reseller-applications/:id
POST /api/admin/reseller-applications/:id/approve
POST /api/admin/reseller-applications/:id/reject
POST /api/admin/reseller-applications/:id/suspend
POST /api/admin/reseller-applications/:id/reactivate
```

The state machine is `NONE -> PENDING`, `PENDING -> APPROVED|REJECTED`, `APPROVED -> SUSPENDED`, and `SUSPENDED -> APPROVED`. Approval validates an active target pricing Group and updates `ResellerApplication`, `User.resellerStatus`, `User.resellerGroupId`, and `User.groupId` in one MongoDB transaction. Rejection stores a safe reason and leaves the user's Group unchanged. Suspension moves the user to the explicit active Default Group. Reactivation restores the assigned reseller Group or an admin-selected replacement Group.

Phase 3B adds a read-only admin pricing diagnostic:

```text
GET /api/admin/reseller-pricing/preview?userId=...&productId=...&quantity=1&currency=USD
```

The route requires `MANAGE_USERS`. It resolves the user's commercial reseller state, effective Group, product base price, Group markup, final unit price, line total, currency, exchange rate, and calculation version without mutating users, Groups, products, orders, wallets, referral commissions, or payouts. It does not expose provider secrets or private margin internals.

Retry is explicitly bounded by `MAX_RESELLER_TRANSACTION_ATTEMPTS = 3`. Audit logs and notifications run only after commit. There is no production migration, automatic approval/rejection, KYC provider, OCR workflow, reseller wallet/credit-limit system, multi-level referral, or commission bonus in Phase 3A.

**Errors:**
- `422 DEPOSIT_ALREADY_APPROVED` — prevent double-approval
- `422 DEPOSIT_ALREADY_REJECTED` — cannot approve a rejected deposit

### Reject Deposit

```http
PATCH /api/admin/deposits/:id/reject
```

---

## Group (Pricing Tier) Management

### List Groups

```http
GET /api/admin/groups
```

### Create Group

```http
POST /api/admin/groups
{ "name": "VIP Resellers", "percentage": 5 }
```

`percentage` is the markup applied on top of base price for all members. A value of `5` means a product priced `$10.00` costs this group `$10.50`.

Phase 3B preserves this exact formula for reseller pricing. `Group.percentage` is not a referral commission rate, payout rate, discount, or authentication permission.

### Update Group

```http
PATCH /api/admin/groups/:id
{ "name": "Premium Resellers", "percentage": 3, "isActive": true }
```

### Deactivate Group

```http
DELETE /api/admin/groups/:id
```

Sets `isActive: false`. Existing users in this group retain their reference but their pricing uses the snapshot on future orders.

---

## Currency Management

### List Currencies

```http
GET /api/admin/currencies
```

### Update Currency Rate

```http
PATCH /api/admin/currencies/:code
{
  "platformRate": 3.75,
  "markupPercentage": 2,
  "isActive": true
}
```

`platformRate` is used for all order billing calculations. `markupPercentage` controls how `effectiveRate` is displayed to the admin (not applied in billing directly).

**Example:**
```
code: SAR
marketRate: 3.71        ← auto-synced from external API
markupPercentage: 1     ← admin adds 1% spread
effectiveRate: 3.7471   ← virtual, for reference
platformRate: 3.75      ← admin sets this manually; used in all billing
```

---

## Settings Management

A key-value store for runtime platform configuration. All settings are seeded with defaults on startup.

### List All Settings

```http
GET /api/admin/settings
```

### Get One Setting

```http
GET /api/admin/settings/:key
```

### Update Setting

```http
PATCH /api/admin/settings/:key
{ "value": true }
```

The `value` field accepts any JSON type (boolean, number, string, object).

---

## Audit Log Access

### By Entity

```http
GET /api/admin/audit?entityType=ORDER&entityId=64abc...&page=1&limit=50
```

Valid `entityType` values: `USER`, `ORDER`, `PRODUCT`, `WALLET`, `DEPOSIT`, `PROVIDER`, `SETTING`

### By Actor

```http
GET /api/admin/audit/actor/:actorId?page=1&limit=50
```

Returns all actions performed by a specific admin (actorId = admin User._id).

**Example audit log entry:**
```json
{
  "_id": "64log...",
  "actorId": "64admin...",
  "actorRole": "ADMIN",
  "action": "DEPOSIT_APPROVED",
  "entityType": "DEPOSIT",
  "entityId": "64dep...",
  "metadata": {
    "amountUsd": 1.9,
    "userId": "64user...",
    "adminOverrideApplied": true,
    "exchangeRate": 50
  },
  "ipAddress": "192.168.1.1",
  "userAgent": "Mozilla/5.0...",
  "createdAt": "2024-03-10T04:00:00Z"
}
```

---

## Validation Schemas

Admin request bodies are validated with Joi or express-validator schemas defined in `admin.validation.js`.

| Endpoint | Schema |
|----------|--------|
| Create Provider | `schemas.createProvider` |
| Update Provider | `schemas.updateProvider` |
| Wallet Adjustment | `schemas.walletAdjustment` |
| Update Currency | `schemas.updateCurrency` |
| Create Group | `schemas.createGroup` |
| Update Group | `schemas.updateGroup` |
| List Users Query | `schemas.listUsersQuery` |
| List Orders Query | `schemas.listOrdersQuery` |
| Update User | `schemas.updateUser` |
| Update Setting | `schemas.updateSetting` |
| Approve Deposit | `schemas.approveDeposit` |
