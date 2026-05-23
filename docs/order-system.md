# Order System

## Overview

The order system orchestrates the complete lifecycle of a customer purchase: validation, pricing, wallet debit, persistence, and provider fulfillment. Every order is a point-in-time snapshot — price, group membership, currency rate, and customer inputs are all frozen at creation and never modified retroactively.

---

## Order Statuses

```
PENDING ──────────────────────────────────────────┐
   │                                              │
   │  executionType = automatic                   │
   ▼                                              │
PROCESSING ──┬─── provider returns terminal ──────┤
             │    success                         │
             │         ▼                          │
             │    COMPLETED                       │
             │                                    │
             └─── provider returns terminal ──────┤
                  failure or retry count exhausted│
                       ▼                          │
                    FAILED + atomic refund         │
                                                  │
          executionType = manual                  │
          or admin PATCH /:id/complete ←──────────┘
               ▼
          COMPLETED

  Any status + admin PATCH /:id/fail → FAILED + atomic refund
```

| Status | Meaning |
|--------|---------|
| `PENDING` | Order created; wallet debited; awaiting manual completion or automatic dispatch |
| `PROCESSING` | Automatic order dispatched; provider has acknowledged; awaiting terminal status |
| `COMPLETED` | Successfully fulfilled |
| `FAILED` | Failed; wallet refunded |

---

## Execution Types

| Type | Behavior |
|------|----------|
| `manual` | Admin marks as COMPLETED or FAILED manually |
| `automatic` | Immediately dispatched to the provider after creation; cron job polls until terminal |

---

## Full Order Flow

### 1. HTTP Request

```http
POST /api/me/orders
Authorization: Bearer <active-customer-token>

{
  "productId": "64abc...",
  "quantity": 1,
  "orderFieldsValues": { "player_id": "hero_123", "server": "EU" },
  "idempotencyKey": "client-uuid-v4"
}
```

### 2. Middleware Chain

```
authenticate         → decode JWT, attach req.user
requireActiveUser    → assert user.status === ACTIVE
authorize('CUSTOMER')→ assert user.role === CUSTOMER
createOrderValidation→ express-validator: productId (mongoId), quantity (int >= 1)
validate             → collect and throw validation errors
me.placeOrder        → me.controller → order.service.createOrder
```

### 3. order.service.createOrder()

**File:** `src/modules/orders/order.service.js`

#### Step 1 — Product Validation

```js
const product = await Product.findById(productId)
    .populate('providerProduct');

if (!product || !product.isActive) throw NotFoundError('Product');
if (quantity < product.minQty || quantity > product.maxQty)
    throw BusinessRuleError('Quantity out of bounds');
```

#### Step 2 — Dynamic Field Validation

Only executed when `product.orderFields.length > 0` and the product has active fields.

```js
const { values, fieldsSnapshot } = validateOrderFields(
    product.orderFields,
    orderFieldsValues ?? {}
);
```

Throws `BusinessRuleError('INVALID_ORDER_FIELDS')` on any field violation. This runs **before** the MongoDB transaction, so no wallet debit occurs on validation failure.

#### Step 3 — Pricing Calculation

```js
const { basePrice, markupPercentage, finalPrice, groupId } =
    await calculateUserPrice(userId, product.basePrice);

// Currency conversion
const currency = await Currency.findOne({ code: user.currency, isActive: true });
const rateSnapshot = currency ? currency.platformRate : 1;
const usdAmount    = parseFloat((finalPrice * quantity).toFixed(2));
const chargedAmount = parseFloat((usdAmount * rateSnapshot).toFixed(2));
```

#### Step 4 — MongoDB Transaction

All subsequent writes happen inside a single MongoDB session:

```js
const session = await mongoose.startSession();
session.startTransaction();
try {
    // Step 5 — Idempotency check
    // Step 6 — Debit wallet
    // Step 7 — Create order
    await session.commitTransaction();
} catch (err) {
    await session.abortTransaction();
    throw err;
} finally {
    await session.endSession();
}
```

#### Step 5 — Idempotency Check

```js
// Sparse unique index: (userId, idempotencyKey)
// Duplicate key error → 409 CONFLICT
```

If the same `idempotencyKey` is submitted twice by the same user, the second request returns a `409 CONFLICT` rather than creating a duplicate order.

#### Step 6 — Atomic Wallet Debit

```js
const { walletDeducted } = await debitWalletAtomic({
    userId,
    amount: chargedAmount,
    session,
});
// MongoDB aggregation pipeline: single atomic operation
// walletBalance -= amount only if walletBalance >= amount
// Throws InsufficientFundsError if balance too low
```

#### Step 7 — Order Creation

```js
const order = await Order.create([{
    userId,
    productId,
    quantity,
    unitPrice:                finalPrice,
    totalPrice:               finalPrice * quantity,
    basePriceSnapshot:        basePrice,
    markupPercentageSnapshot: markupPercentage,
    finalPriceCharged:        finalPrice,
    groupIdSnapshot:          groupId,
    walletDeducted:           chargedAmount,
    creditUsedAmount:         0,
    currency:                 user.currency,
    rateSnapshot,
    usdAmount,
    chargedAmount,
    idempotencyKey:           idempotencyKey ?? null,
    status:                   ORDER_STATUS.PENDING,
    executionType:            product.executionType,
    customerInput:            fieldsSnapshot.length > 0
                                ? { values, fieldsSnapshot }
                                : null,
}], { session });
```

#### Step 8 — Post-Commit: Fulfillment Dispatch

For automatic products, fulfillment is triggered after the transaction commits (not inside it):

```js
if (order.executionType === 'automatic') {
    executeOrder(order._id).catch(logger.error);
    // fire-and-forget — does not affect the HTTP response
}
```

---

## Pricing Calculation

**File:** `src/modules/orders/pricing.service.js`

### `calculateFinalPrice(basePrice, percentage)`

Pure function, no DB access. Used by tests directly.

```
finalPrice = basePrice + (basePrice × percentage / 100)
           = parseFloat( (...).toFixed(2) )
```

Example: `basePrice=9.99, percentage=15 → 9.99 + 1.50 = 11.49`

### `calculateUserPrice(userId, basePrice)`

Loads the user's group (populated), gets `percentage`, applies `calculateFinalPrice`.

Returns: `{ basePrice, markupPercentage, finalPrice, groupId }`

---

## Idempotency

The `idempotencyKey` field is optional. When supplied:

- A sparse unique index on `(userId, idempotencyKey)` prevents duplicate processing
- The same request re-submitted returns `409 CONFLICT` immediately — the wallet is **not** debited again
- A different user can reuse the same key without conflict (the uniqueness is per-user)
- If no key is supplied, idempotency is not enforced

**Frontend recommendation:** Generate a UUID v4 per order attempt and persist it locally. On network failure/timeout, retry with the same key.

---

## Refund Logic

### Automatic Refund (Fulfillment Failure)

Triggered when:
- Provider returns a terminal failure status
- Retry count reaches `MAX_RETRY_COUNT` (5)

```js
await refundWalletAtomic({
    userId: order.userId,
    walletDeducted: order.walletDeducted,
    creditUsedAmount: 0,
    reference: order._id,
    description: `Refund for failed order`,
    session,
});
order.refunded = true;   // idempotency guard
order.refundedAt = new Date();
order.status = ORDER_STATUS.FAILED;
```

The `refunded` boolean flag prevents double-refunds if the same failure handler is accidentally called twice.

### Manual Refund (Admin)

```http
POST /api/admin/orders/:id/refund
POST /api/admin/orders/:id/retry   ← re-dispatches, does not refund
PATCH /api/orders/:id/fail         ← sets FAILED + issues refund
```

---

## Admin Order Operations

### List Orders

```http
GET /api/admin/orders?status=PROCESSING&userId=...&page=1&limit=50
```

### Get Order Detail

Returns the full order document including `customerInput.values` and `customerInput.fieldsSnapshot`.

### Retry a Failed Order

Re-dispatches the order to the provider (does not modify wallet — the original debit still stands).

```http
POST /api/admin/orders/:id/retry
```

### Manual Fail

Marks as FAILED and issues a wallet refund.

```http
POST /api/admin/orders/:id/refund
PATCH /api/orders/:id/fail
```

---

## Customer Order Operations

### Place Order

```http
POST /api/me/orders
```

### View My Orders

```http
GET /api/me/orders?status=COMPLETED&page=1&limit=20
```

Filters: `status`, `page`, `limit`

### View Order Detail

```http
GET /api/me/orders/:id
```

Ownership enforced — returns `403` if the order belongs to another user.

---

## Edge Cases

### Concurrent Orders / Race Conditions

The atomic `findOneAndUpdate` aggregation pipeline for wallet debit (`walletBalance: { $gte: amount }`) is a single MongoDB operation. Even if two requests arrive simultaneously for the same user, only one will succeed — there is no TOCTOU window.

### Product Price Changes After Order Placement

`basePriceSnapshot` and `markupPercentageSnapshot` are written at creation time. Later price changes to the product or group do **not** affect any existing order.

### Group Assignment Changes

`groupIdSnapshot` captures the group at order time. If an admin reassigns the user to a different group, only future orders are affected.

### User Currency Changes

`rateSnapshot` and `chargedAmount` are frozen at order time. If the admin later updates the `platformRate` for a currency, historical orders remain accurate.

### Order Fields Changes

`customerInput.fieldsSnapshot` freezes the active field definitions at order time. Admin changes to `product.orderFields` do not alter historical field context.

### Provider Down

If the provider API is unreachable when `executeOrder()` is called:
1. The order remains `PENDING` or moves to `FAILED`
2. An automatic wallet refund is issued
3. The full error response is stored in `providerRawResponse`
4. The admin can later use `POST /admin/orders/:id/retry` once the provider recovers

### `MAX_RETRY_COUNT` Exhausted

After 5 failed polling attempts (`retryCount >= 5`):
1. `order.status = FAILED`
2. `order.refunded = true`
3. Atomic wallet refund
4. `order.providerRawResponse` holds the last known provider payload

The admin will see the order in the FAILED state and can inspect the raw provider response.
