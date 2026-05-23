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

Calls `creditWalletDirect()` inside a session. Writes `CREDIT` WalletTransaction.

### Deduct Funds

```http
POST /api/admin/wallets/:userId/deduct
{ "amount": 50, "reason": "Correction adjustment" }
```

Calls `debitWalletAtomic()` inside a session. Fails if insufficient balance.

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

Returns raw ProviderProduct documents including `rawPayload`.

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

Returns full deposit including `transferImageUrl` for receipt verification.

### Approve Deposit

```http
PATCH /api/admin/deposits/:id/approve
{ "overrideAmount": 95 }
```

`overrideAmount` is optional. If provided, this amount is credited rather than `amountRequested`. The deposit's `amountApproved` is set to the actual credited amount.

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
    "amountApproved": 95,
    "userId": "64user...",
    "overrideAmount": 95
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
