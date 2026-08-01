# User Panel

## Overview

The User Panel (`/api/me/*`) is the self-service API for approved customer accounts. It provides access to the product catalogue, order placement, wallet overview, and deposit request submission. All routes require a valid JWT and `status === ACTIVE` (admin-approved).

---

## Access Requirements

Every `/api/me/*` route passes through two mandatory middleware guards:

```js
router.use(authenticate, requireActiveUser);
```

| Middleware | Check | Failure |
|-----------|-------|---------|
| `authenticate` | JWT present and valid | `401 AUTHENTICATION_ERROR` |
| `requireActiveUser` | `user.status === ACTIVE` | `403 AUTHORIZATION_ERROR` |

This means a user who has registered but not yet been approved by an admin will receive `403` on every user-panel request.

---

## Referral Dashboard

Phase 2D adds authenticated referral dashboard routes under `/api/referrals/me/*`. They use the same JWT and active-user requirements as the user panel, but they are mounted under the referrals module so the public client cannot submit an arbitrary referrer identity.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/referrals/me/dashboard` | Own referral code, relative invite path, referred-user count, and commission totals by status |
| `GET /api/referrals/me/commissions` | Read-only commission history with `status`, date, and pagination filters |
| `GET /api/referrals/me/invitees` | Privacy-safe referred-user history with source, date, and pagination filters |
| `POST /api/referrals/me/payouts` | Request payout for selected own `AVAILABLE` commissions |
| `GET /api/referrals/me/payouts` | Own payout history with status/method/date pagination filters |
| `GET /api/referrals/me/payouts/:id` | One own payout request |

The backend derives ownership from `req.user._id`. `referrerId`, `userId`, and `referredBy` query/body overrides are rejected. Commission totals come from immutable `ReferralCommission` rows and are returned as Decimal strings. New Phase 4C commissions include USD analytical values and payable values in the referrer's account currency. Invitee records expose display name, masked email, joined timestamp, referral source, and grouped commission summary only.

Phase 2E/4C lets the authenticated referrer request payout of selected own `AVAILABLE` commissions. The backend requires a single commission currency, calculates USD analytical total plus payable `amount/currency`, creates a `PENDING` payout request, and locks the selected commissions in one transaction. Users cannot mix currencies, submit `referrerId`, change commission amounts, mark commissions paid, reject requests, settle requests, mutate referral balances, or access another user's payout.

Admin review is separate. Rejection unlocks commissions; `WALLET` settlement credits the referrer's wallet once after admin approval only when payout currency matches the wallet/account currency; `MANUAL` settlement records an external reference without wallet credit. No browser-side conversion, user-facing payout cancellation, external payment provider, automatic legacy conversion, or retroactive commission generation exists.

---

## Reseller/Sub-Agent Applications

Phase 3A adds authenticated customer APIs under `/api/reseller-applications/me/*`. "Sub-Agent" is the customer-facing label for the same backend `RESELLER` commercial state. This is not an auth role, so users remain `CUSTOMER`, `ADMIN`, or `SUPERVISOR` for authentication/authorization.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/reseller-applications/me` | Submit one current user's reseller/sub-agent application |
| `GET /api/reseller-applications/me/current` | Current commercial reseller state, latest application, `canApply`, and safe group metadata |
| `GET /api/reseller-applications/me/history` | Current user's own application history with pagination |

Only active users can submit or read these routes. The backend derives ownership from the JWT user and ignores client-submitted commercial state, reviewer, or group assignment fields. Duplicate identical pending submissions return the existing application; different payloads while pending return a conflict. A rejected user may reapply when the configured cooldown permits.

User responses do not expose reviewer identity, full internal snapshots, group pricing internals, or other users' applications. Approval, rejection, suspension, and reactivation are admin-only workflows.

## Phase 3B Reseller Pricing

Approved reseller/sub-agent status affects future catalog, quote, and order prices only through the backend pricing resolver. Customers see backend-resolved prices in product/catalog responses and may request read-only quotes with `POST /api/pricing/me/quote`. The client submits product ids, quantities, and order fields only; it cannot submit authoritative prices, totals, Groups, percentages, reseller state, exchange rates, or another `userId`.

Suspended resellers do not continue receiving reseller pricing. Phase 4C restores the saved pre-reseller Group when valid, otherwise the current highest eligible normal Group; future orders use that effective non-reseller Group state, while old orders keep their immutable snapshots. Referral commissions, payout requests, and referrer wallet balances are not changed by reseller pricing.

---

## Profile

### GET /api/me

Returns the authenticated user's profile including wallet balance and group info.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "64abc...",
      "name": "John Doe",
      "email": "john@example.com",
      "role": "CUSTOMER",
      "status": "ACTIVE",
      "walletBalance": 150.00,
      "currency": "USD",
      "groupId": {
        "_id": "64grp...",
        "name": "Standard",
        "percentage": 15
      },
      "createdAt": "2024-01-15T00:00:00Z"
    }
  }
}
```

---

## Wallet

### GET /api/me/wallet

Returns wallet summary and 5 most recent transactions.

**Response `200`:**
```json
{
  "data": {
    "walletBalance": 150.00,
    "currency": "USD",
    "recentTransactions": [
      {
        "type": "DEBIT",
        "amount": 10.99,
        "description": "Order payment for Free Fire Diamonds",
        "createdAt": "2024-03-10T03:00:00Z"
      }
    ]
  }
}
```

### GET /api/me/wallet/transactions

Paginated transaction history (newest first).

**Query:** `?page=1&limit=20`

**Response `200`:**
```json
{
  "data": [
    {
      "_id": "64tx...",
      "type": "DEBIT",
      "amount": 10.99,
      "balanceBefore": 160.99,
      "balanceAfter": 150.00,
      "reference": { "_id": "64ord...", "status": "COMPLETED", "totalPrice": 10.99 },
      "description": "Order payment",
      "createdAt": "2024-03-10T03:00:00Z"
    },
    {
      "type": "CREDIT",
      "amount": 100.00,
      "balanceBefore": 50.00,
      "balanceAfter": 150.00,
      "description": "Deposit approved",
      "createdAt": "2024-03-09T10:00:00Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 12, "pages": 1 }
}
```

---

## Product Catalogue

### GET /api/me/products

Browse active products. Only `isActive === true` products are returned.

**Query:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `search` | string | — | Substring match on product name |
| `page` | int | 1 | Page number |
| `limit` | int | 20 | Results per page (max 100) |

**Response `200`:**
```json
{
  "data": [
    {
      "_id": "64prod...",
      "name": "Free Fire Diamonds",
      "description": "Instant delivery",
      "basePrice": 9.99,
      "category": "games",
      "minQty": 1,
      "maxQty": 1,
      "orderFields": [
        {
          "id": "f1", "key": "player_id", "label": "Player ID",
          "type": "text", "required": true, "placeholder": "e.g. 123456789"
        },
        {
          "id": "f2", "key": "server", "label": "Server Region",
          "type": "select", "options": ["NA","EU","AS","ME"], "required": true
        }
      ]
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 8, "pages": 1 }
}
```

> **Note:** `providerMapping` is **not** included in the user-facing product response. It is an internal admin-only field.

### GET /api/me/products/:id

Single product full detail.

**Params:** `:id` must be a valid MongoDB ObjectId.

**Errors:** `400` (invalid id), `404 NOT_FOUND` (inactive or missing)

---

## Orders

### POST /api/me/orders

Place an order. The full order creation flow runs synchronously before responding.

**Validation:**
- `productId` — required, valid MongoDB ObjectId
- `quantity` — optional integer ≥ 1 (defaults to 1)
- `orderFieldsValues` — free-form object; validated against `product.orderFields`

**Body:**
```json
{
  "productId": "64prod...",
  "quantity": 1,
  "orderFieldsValues": {
    "player_id": "hero_123",
    "server": "EU"
  },
  "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Success `201`:**
```json
{
  "success": true,
  "message": "Order placed successfully.",
  "data": {
    "order": {
      "_id": "64ord...",
      "status": "PROCESSING",
      "totalPrice": 10.99,
      "currency": "USD",
      "customerInput": {
        "values": { "player_id": "hero_123", "server": "EU" },
        "fieldsSnapshot": [
          { "key": "player_id", "label": "Player ID", "type": "text" },
          { "key": "server", "label": "Server Region", "type": "select", "options": ["NA","EU","AS","ME"] }
        ]
      },
      "createdAt": "2024-03-10T04:00:00Z"
    }
  }
}
```

**Possible Errors:**

| HTTP | Code | Cause |
|------|------|-------|
| 400 | `VALIDATION_ERROR` | `productId` not a valid MongoId |
| 404 | `NOT_FOUND` | Product not found or inactive |
| 422 | `INVALID_ORDER_FIELDS` | Dynamic field validation failed |
| 422 | `INSUFFICIENT_FUNDS` | `walletBalance < totalPrice` |
| 422 | `BUSINESS_RULE_VIOLATION` | Inactive product, qty out of bounds, user inactive |
| 409 | `CONFLICT` | Duplicate `idempotencyKey` |

### GET /api/me/orders

My order history with optional filters.

**Query:**
| Param | Description |
|-------|-------------|
| `status` | Filter by `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED` |
| `page` | Page number |
| `limit` | Results per page |

**Response `200`:**
```json
{
  "data": [
    {
      "_id": "64ord...",
      "status": "COMPLETED",
      "totalPrice": 10.99,
      "quantity": 1,
      "productId": { "_id": "...", "name": "Free Fire Diamonds" },
      "customerInput": { "values": { ... }, "fieldsSnapshot": [...] },
      "createdAt": "2024-03-10T04:00:00Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 5, "pages": 1 }
}
```

### GET /api/me/orders/:id

Single order detail. Ownership is enforced — a customer cannot access another user's order.

**Errors:** `403` if the order belongs to a different user, `404` if not found.

---

## Deposits

### POST /api/deposits

Submit a deposit request with a receipt upload:

**Option A — multipart/form-data (recommended):**
```
Content-Type: multipart/form-data
requestedAmount: 100
currency: EGP
paymentMethodId: vodafone-cash
senderWalletNumber: +1-555-0100
receipt: <file>
```

The file is saved under `/uploads/deposits/` on the server. `receiptImage` is stored on the deposit record.

**Validation:**
- `requestedAmount` - required, float > 0
- `currency` - required, active ISO 4217 code
- `paymentMethodId` - required, active public payment settings method
- `receipt` - required upload field
- sender detail compatibility fields are normalized into `senderDetails`

**Response `201`:**
```json
{
  "data": {
    "deposit": {
      "_id": "64dep...",
      "status": "PENDING",
      "requestedAmount": 100,
      "currency": "EGP",
      "exchangeRate": 50,
      "amountUsd": 2,
      "receiptImage": "uploads/deposits/receipt-1709000000.jpg",
      "createdAt": "2024-03-10T04:00:00Z"
    }
  }
}
```

### GET /api/me/deposits

My deposit history (newest first).

**Response `200`:** Paginated list of deposit records.

### GET /api/me/deposits/:id

Single deposit detail. Ownership enforced — customers can only view their own deposits.

**Response `200`:**
```json
{
  "data": {
    "deposit": {
      "_id": "64dep...",
      "status": "APPROVED",
      "requestedAmount": 100,
      "amountUsd": 2,
      "reviewedAt": "2024-03-10T10:00:00Z",
      "createdAt": "2024-03-10T04:00:00Z"
    }
  }
}
```

---

## User Lifecycle

### Registration → Active Flow

```
1. POST /api/auth/register
   → User created (status=PENDING, verified=false)
   → Verification email sent

2. GET /api/auth/verify-email?token=...
   → User.verified = true (status still PENDING)

3. Admin: PATCH /api/admin/users/:id/approve
   → User.status = ACTIVE

4. POST /api/auth/login
   → JWT issued (now succeeds because user is ACTIVE)

5. All /api/me/* routes now accessible
```

### Google OAuth Flow

```
1. GET /api/auth/google
   → Redirect to Google consent screen

2. Google redirects to GET /api/auth/google/callback

Phase 4C restores the Google profile-completion gate. After the PKCE handoff exchange, a new Google user missing `country` or `currency` receives `profileCompletionRequired` and `missingProfileFields`; protected application pages are blocked until `/api/me/profile-completion` stores those fields. A referral from trusted OAuth state is locked and cannot be replaced. If OAuth started without a referral, one optional referral code may be supplied during completion only while the profile is incomplete and `referredBy` is still unset.
   → If new user:
       created with verified=true, status=PENDING
       admin must still approve
   → If existing user:
       logged in normally

3. Response: { token, user }
```

---

## Error Reference

| Scenario | HTTP | Code |
|----------|------|------|
| No token / invalid JWT | 401 | `AUTHENTICATION_ERROR` |
| Valid JWT but user not active | 403 | `AUTHORIZATION_ERROR` |
| Product not found | 404 | `NOT_FOUND` |
| Invalid product ID format | 400 | `VALIDATION_ERROR` |
| Dynamic field unknown key | 422 | `INVALID_ORDER_FIELDS` |
| Dynamic field required + missing | 422 | `INVALID_ORDER_FIELDS` |
| Number field out of bounds | 422 | `INVALID_ORDER_FIELDS` |
| URL field bad format | 422 | `INVALID_ORDER_FIELDS` |
| Select field invalid option | 422 | `INVALID_ORDER_FIELDS` |
| Wallet balance insufficient | 422 | `INSUFFICIENT_FUNDS` |
| Duplicate idempotency key | 409 | `CONFLICT` |
| Deposit record not mine | 403 | `AUTHORIZATION_ERROR` |
| Order record not mine | 403 | `AUTHORIZATION_ERROR` |
