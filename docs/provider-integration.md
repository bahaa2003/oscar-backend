# Provider Integration

## Overview

The provider layer bridges the platform with external digital-goods supplier APIs. Three production providers are integrated: **Royal Crown**, **Torosfon Store**, and **Alkasr VIP**. A **MockProviderAdapter** serves as a safe fallback for development and testing.

---

## Architecture: Three Layers

```
Layer 1 ─ Provider document
           (DB record: name, slug, baseUrl, apiToken, syncInterval)
           ↓
Layer 2 ─ ProviderProduct document
           (raw synced catalogue: externalProductId, rawName, rawPrice)
           ↓
Layer 3 ─ Product document
           (admin-curated: name, basePrice, orderFields, providerMapping)
```

Customers only ever see Layer 3. Layer 2 is admin-only. Layer 1 is system configuration.

---

## Adapter Factory

**File:** `src/modules/providers/adapters/adapter.factory.js`

The factory resolves the correct adapter class for a given Provider document.

### Resolution Order

1. **`provider.slug`** (preferred) — lowercase, URL-safe, e.g. `"royal-crown"`
2. **`provider.name`** (fallback) — lowercased and trimmed, e.g. `"royal crown"`
3. **`MockProviderAdapter`** — if no match (non-strict mode) or **throws** `UNSUPPORTED_PROVIDER` (strict mode)

### Registry

| Key(s) | Adapter |
|--------|---------|
| `royal-crown`, `royal crown`, `royalcrown` | `RoyalCrownAdapter` |
| `toros`, `torosfon`, `torosfon store`, `toros-store` | `TorosfonAdapter` |
| `alkasr`, `alkasr-vip`, `alkasr vip`, `alkasrvip` | `AlkasrVipAdapter` |
| `mock` | `MockProviderAdapter` |

### Usage

```js
const { getProviderAdapter } = require('./adapter.factory');

// Normal (falls back to mock on unknown slug)
const adapter = getProviderAdapter(providerDocument);

// Strict (throws if unknown)
const adapter = getProviderAdapter(providerDocument, { strict: true });

// Register a new adapter at runtime (e.g., in tests / plugins)
const { registerAdapter } = require('./adapter.factory');
registerAdapter('my-provider', MyCustomAdapter);
```

---

## Base Adapter Interface

**File:** `src/modules/providers/adapters/base.adapter.js`

All adapters extend `BaseProviderAdapter`. The contract methods are:

| Method | Signature | Returns |
|--------|-----------|---------|
| `getProducts()` | `async ()` | `Array<{ externalProductId, name, price, minQty, maxQty, isActive }>` |
| `placeOrder(params)` | `async ({ externalProductId, quantity, ...fields })` | Provider order object |
| `getOrderStatus(providerOrderId)` | `async (id)` | `{ status, rawResponse }` |
| `checkOrders(orderIds)` | `async (ids[])` | Array of `{ id, status, rawResponse }` |
| `getBalance()` | `async ()` | `{ balance, currency }` |

All methods must be implemented by concrete adapters. `BaseProviderAdapter` provides `_validateDTO()` for input sanitation and common error handling.

---

## Implemented Adapters

### RoyalCrownAdapter

**Endpoint base:** `https://royal-croown.com`
**Authentication:** Query parameter `?token=<apiToken>`

| Operation | HTTP |
|-----------|------|
| `getProducts()` | `GET /api/services` |
| `placeOrder()` | `POST /api/add` |
| `getOrderStatus()` | `POST /api/status` |
| `checkOrders()` | `POST /api/status` (batch) |
| `getBalance()` | `GET /api/account/balance` (if supported) |

---

### TorosfonAdapter

**Endpoint base:** `https://torosfon.com`
**Authentication:** `Authorization: Bearer <apiToken>` header

| Operation | HTTP |
|-----------|------|
| `getProducts()` | `GET /api/services` |
| `placeOrder()` | `POST /api/add` |
| `getOrderStatus()` | `GET /api/status?order=<id>` |
| `checkOrders()` | Batch status endpoint |
| `getBalance()` | `GET /api/account/balance` |

---

### AlkasrVipAdapter

**Endpoint base:** `https://alkasr-vip.com`
**Authentication:** `X-API-Key: <apiToken>` header

| Operation | HTTP |
|-----------|------|
| `getProducts()` | `GET /v1/products` |
| `placeOrder()` | `POST /v1/orders` |
| `getOrderStatus()` | `GET /v1/orders/<id>` |
| `checkOrders()` | `POST /v1/orders/batch-status` |
| `getBalance()` | `GET /account/info` |

---

### MockProviderAdapter

A fully functional adapter that simulates all API operations without making network calls. Used in:
- Test environment (default fallback)
- Development against unknown providers
- Unit tests with injected mock behavior

---

## Provider Sync Engine

**File:** `src/modules/providers/providerCatalog.service.js`

### Sync Flow

```
syncProvidersJob runs every 6 hours
    │
    ▼
For each active Provider:
    getProviderAdapter(provider)
    adapter.getProducts()
    │
    ▼
For each product in response:
    ProviderProduct.findOneAndUpdate(
        { provider, externalProductId },
        { rawName, rawPrice, rawPayload, isActive, lastSyncedAt },
        { upsert: true }
    )
```

**Design principles:**
- Idempotent — safe to run multiple times (upsert prevents duplicates)
- Non-destructive — `translatedName` (set by admin) is never overwritten
- Per-provider isolation — sync failure on one provider does not affect others

### Triggering Manual Sync

```http
POST /api/admin/catalog/sync
-- or --
POST /api/admin/catalog/sync/:providerId
```

### Viewing Raw Products After Sync

```http
GET /api/admin/provider-products/:providerId
```

Returns the full `ProviderProduct` collection for that provider, including `rawPayload`, so admins can inspect the raw data before publishing.

---

## Provider Mapping (providerMapping)

### The Problem

The platform uses human-readable keys in `orderFields` (e.g. `player_id`, `server`). Provider APIs expect their own parameter names (e.g. `link`, `server_id`). Hardcoding this translation in adapter code would couple adapters to specific product forms.

### The Solution

Each `Product` carries a `providerMapping: Map<String, String>`:

```json
{
  "providerMapping": {
    "player_id": "link",
    "server": "server_id",
    "amount": "quantity"
  }
}
```

### Translation at Fulfillment Time

**File:** `src/modules/orders/orderFulfillment.service.js`

```js
const translatedValues = applyProviderMapping(
    order.customerInput.values,    // { player_id: "hero_123", server: "EU" }
    product.providerMapping        // Map { player_id → "link", server → "server_id" }
);
// translatedValues = { link: "hero_123", server_id: "EU" }

await adapter.placeOrder({
    externalProductId: product.providerProduct.externalProductId,
    quantity: order.quantity,
    ...translatedValues,           // spread translated fields
});
```

### Mapping Rules

1. If `providerMapping` is null or empty → `values` are passed through unchanged
2. If a key is in `providerMapping` → translated to the mapped key
3. If a key is **not** in `providerMapping` → passed through unchanged
4. Works with both plain objects and Mongoose `Map` instances

### Example — No Mapping Needed

Some providers accept the same parameter names the platform uses. In that case, `providerMapping` is left empty and values pass through directly.

---

## Fulfillment Engine

**File:** `src/modules/orders/orderFulfillment.service.js`

### `executeOrder(orderId)`

Called immediately after order creation for `executionType === 'automatic'` products.

**Flow:**

```
executeOrder(orderId)
    │
    ├─ Order.findById(orderId).populate(['productId', 'productId.providerProduct'])
    │
    ├─ getProviderAdapter(provider) → adapter
    │
    ├─ applyProviderMapping(customerInput.values, product.providerMapping)
    │
    ├─ adapter.placeOrder({ externalProductId, quantity, ...translatedFields })
    │
    ├─ Parse provider response:
    │   ├─ Terminal success (Completed/done/accept) → status = COMPLETED
    │   ├─ Terminal failure (Cancelled/failed/error) → status = FAILED + refund
    │   └─ Non-terminal (Pending/in_process/wait)   → status = PROCESSING
    │                                                   providerOrderId = <id>
    │
    └─ Save updated order
```

### Status Resolution

The fulfillment engine uses configurable status word lists to classify provider responses:

| Provider word | Mapped status |
|---------------|---------------|
| `Completed`, `success`, `done`, `accept` | `COMPLETED` |
| `Cancelled`, `canceled`, `failed`, `error`, `reject`, `rejected`, `cancel` | `FAILED` |
| `Pending`, `in_process`, `wait` | `PROCESSING` (continues polling) |

Strings are compared case-insensitively.

---

## Order Polling / Status Checking

**File:** `src/modules/orders/orderPolling.service.js`
**Cron:** `src/modules/orders/fulfillmentJob.js` (every 1 minute)

### Polling Flow

```
fulfillmentJob triggers every minute
    │
    ▼
Find orders: { status: PROCESSING, providerOrderId: { $ne: null } }
Sort by lastCheckedAt ASC (oldest-checked first)
    │
    ▼
For each order:
    adapter.getOrderStatus(providerOrderId)
    OR
    adapter.checkOrders([id1, id2, ...]) (batch, if supported)
    │
    ├─ Terminal success → COMPLETED
    ├─ Terminal failure → FAILED + atomic refund
    └─ Still pending    → increment retryCount + update lastCheckedAt
                         If retryCount >= MAX_RETRY_COUNT (5):
                             order.status = FAILED
                             atomic refund issued
```

### Retry Exhaustion

If a provider never responds with a terminal status after 5 polling attempts, the order is force-failed and the wallet refunded automatically. The `providerRawResponse` field preserves the last response received for admin inspection.

---

## Adding a New Provider

1. **Create the adapter:**
   ```js
   // src/modules/providers/adapters/myProvider.adapter.js
   const { BaseProviderAdapter } = require('./base.adapter');

   class MyProviderAdapter extends BaseProviderAdapter {
       async getProducts() { /* ... */ }
       async placeOrder(params) { /* ... */ }
       async getOrderStatus(providerOrderId) { /* ... */ }
       async checkOrders(ids) { /* ... */ }
       async getBalance() { /* ... */ }
   }

   module.exports = { MyProviderAdapter };
   ```

2. **Register in the factory:**
   ```js
   // adapter.factory.js
   const { MyProviderAdapter } = require('./myProvider.adapter');

   const registry = new Map([
       // ...existing entries...
       ['my-provider', MyProviderAdapter],
       ['my provider', MyProviderAdapter],
   ]);
   ```

3. **Create a Provider document via API:**
   ```http
   POST /api/admin/providers
   {
     "name": "My Provider",
     "slug": "my-provider",
     "baseUrl": "https://api.myprovider.com",
     "apiToken": "secret"
   }
   ```

4. **Sync and publish:**
   ```http
   POST /api/admin/catalog/sync/:providerId
   GET  /api/admin/provider-products/:providerId
   POST /api/admin/products/from-provider
   ```

---

## Error Handling in Adapters

All adapter methods wrap HTTP calls in `try/catch`. Failures are surfaced as `AppError` subclasses:

| Scenario | Error |
|----------|-------|
| Network timeout / 5xx | `BusinessRuleError('PROVIDER_API_ERROR')` |
| Authentication failure (401/403) | `BusinessRuleError('PROVIDER_AUTH_ERROR')` |
| Product not found | `NotFoundError('ProviderProduct')` |
| Place order rejected | `BusinessRuleError('PROVIDER_ORDER_REJECTED')` |

Order placement failures trigger immediate atomic refunds and set `order.status = FAILED`.
