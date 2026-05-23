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

### POST /api/me/deposits

Submit a deposit request. Supports two content types:

**Option A — multipart/form-data (recommended):**
```
Content-Type: multipart/form-data
amountRequested: 100
transferredFromNumber: +1-555-0100
screenshotProof: <file>    ← field name must be exactly "screenshotProof"
```

The file is saved to `/uploads/` on the server. `transferImageUrl` is auto-set on the deposit record.

**Option B — application/json:**
```json
{
  "amountRequested": 100,
  "transferredFromNumber": "+1-555-0100",
  "transferImageUrl": "https://cdn.example.com/receipt.png"
}
```

**Validation:**
- `amountRequested` — required, float > 0
- `transferredFromNumber` — required, string, max 100 chars
- Either `screenshotProof` (file upload) or `transferImageUrl` (JSON) must be provided

**Response `201`:**
```json
{
  "data": {
    "deposit": {
      "_id": "64dep...",
      "status": "PENDING",
      "amountRequested": 100,
      "transferredFromNumber": "+1-555-0100",
      "transferImageUrl": "https://server.com/uploads/receipt-1709000000.jpg",
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
      "amountRequested": 100,
      "amountApproved": 95,
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
