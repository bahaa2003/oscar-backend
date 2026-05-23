# Dynamic Order Fields System

## Overview

The Dynamic Order Fields system allows admins to define product-specific input forms that customers must fill out when placing an order. Every product requiring customer data (e.g. a game account ID, server region, or profile URL) can declare its own field schema. The backend fully validates, coerces, and persists these values as an immutable snapshot on each order.

---

## The Problem It Solves

Digital products are heterogeneous. A "Free Fire Diamonds" top-up needs a Player ID and Server. A "Netflix Subscription" might need an email address. A "YouTube View Boost" might need a video URL. Hardcoding these fields per-product would require backend deployments for every new product type. Dynamic Order Fields solve this at the data layer: admins define the form, the engine enforces it.

---

## Architecture

```
Admin defines orderFields on Product
         │
         ▼
Customer POSTs order with orderFieldsValues
         │
         ▼
validateOrderFields(product.orderFields, orderFieldsValues)
    ├── 1. Reject unknown keys
    ├── 2. Enforce required fields
    ├── 3. Type-validate & coerce each value
    │       text     → trim, non-empty string
    │       textarea → trim, non-empty string
    │       number   → parseFloat + min/max bounds
    │       url      → regex /^https?:\/\/.+\..+/
    │       select   → must be in field.options
    │       email    → non-empty string (format hint)
    │       tel      → non-empty string
    │       date     → non-empty string
    ├── 4. Collect all errors before throwing
    └── 5. Build immutable fieldsSnapshot
         │
         ▼
Order.customerInput = { values, fieldsSnapshot }
    (stored once, never mutated)
```

---

## Supported Field Types

| Type | Key | Validation Applied |
|------|-----|--------------------|
| Text | `text` | Non-empty string after trim |
| Textarea | `textarea` | Non-empty string after trim |
| Number | `number` | Numeric coercion via `parseFloat`; `min`/`max` bounds |
| URL | `url` | Must match `^https?://` and contain a `.` in the domain |
| Select | `select` | Value must exist in `field.options` array |
| Email | `email` | Non-empty string (format validation is a frontend concern) |
| Phone | `tel` | Non-empty string |
| Date | `date` | Non-empty string |

---

## Field Definition Schema

Each element in `product.orderFields` is a subdocument with these properties:

```json
{
  "id":          "f1",
  "key":         "player_id",
  "label":       "Player ID",
  "type":        "text",
  "placeholder": "Enter your in-game Player ID",
  "required":    true,
  "options":     [],
  "min":         null,
  "max":         null,
  "sortOrder":   0,
  "isActive":    true
}
```

| Property | Purpose |
|----------|---------|
| `id` | Stable identifier for this field. Persists even if `key` or `label` changes |
| `key` | Programmatic key used in the submitted values object and `customerInput.values`. Must be lowercase snake_case (`/^[a-z][a-z0-9_]*$/`) |
| `label` | Human-readable label displayed on the order form |
| `type` | Controls both frontend widget type and backend validation logic |
| `placeholder` | Optional hint text for the form input |
| `required` | If `true`, a missing or blank value fails validation |
| `options` | For `type=select` only — the exhaustive list of valid values |
| `min` | For `type=number` — minimum allowed value (inclusive) |
| `max` | For `type=number` — maximum allowed value (inclusive) |
| `sortOrder` | Display order in the form (ascending) |
| `isActive` | If `false`, the field is completely invisible to customers and skipped by the validator |

---

## Validation Engine

**File:** `src/modules/orders/orderFields.validator.js`

### `validateOrderFields(orderFields, orderFieldsValues)`

**Parameters:**
- `orderFields` — the product's `orderFields` array from the database
- `orderFieldsValues` — the key→value map submitted by the customer

**Returns:**
```js
{
  values: { player_id: "hero_123", server: "EU", quantity: 500 },
  fieldsSnapshot: [
    { key: "player_id", label: "Player ID", type: "text" },
    { key: "server",    label: "Server", type: "select", options: ["NA","EU","AS"] },
    { key: "quantity",  label: "Quantity", type: "number", min: 100, max: 10000 }
  ]
}
```

**Throws:** `BusinessRuleError` with code `INVALID_ORDER_FIELDS` if any rule is violated.

### Validation Algorithm

```
Step 1: Filter orderFields to active only (isActive !== false)
Step 2: Build fieldByKey Map for O(1) lookups
Step 3: Reject unknown submitted keys
Step 4: For each active field:
    a. If required && missing/blank → push error
    b. If optional && missing → skip (no entry in values)
    c. Else → type-switch:
        text/textarea/email/tel/date → trim, assert non-empty
        url    → trim, assert ^https?:// regex
        number → parseFloat, assert !isNaN, assert >= min, assert <= max
        select → assert value in options array
Step 5: If errors.length > 0 → throw BusinessRuleError with all messages joined
Step 6: Build fieldsSnapshot (active fields only, simplified shape)
Step 7: Return { values, fieldsSnapshot }
```

### Error Accumulation

The validator collects **all** errors before throwing. This means a customer with 3 invalid fields receives a single response listing all 3 problems — not just the first one.

```json
{
  "success": false,
  "code": "INVALID_ORDER_FIELDS",
  "message": "Order field validation failed: 'Player ID' is required. 'Server' must be one of: 'NA', 'EU', 'AS'. 'Quantity' must be at least 100."
}
```

---

## Immutable Snapshots

### Why Snapshots?

Product `orderFields` are admin-editable. If a field is renamed, disabled, or removed after an order is placed, the order would become historically inaccurate. To prevent this, the validator generates a **fieldsSnapshot** — a simplified copy of the active fields at order creation time — and stores it alongside the values.

### What Is Stored

On `Order.customerInput`:

```js
{
  values: {
    player_id: "hero_123",   // coerced/trimmed values
    server:    "EU",
    quantity:  500
  },
  fieldsSnapshot: [
    { key: "player_id", label: "Player ID", type: "text" },
    { key: "server",    label: "Server Region", type: "select",
      options: ["NA","EU","AS"] },
    { key: "quantity",  label: "Diamond Amount", type: "number",
      min: 100, max: 10000 }
  ]
}
```

`customerInput` is `null` when the product has no active `orderFields`.

### Immutability Guarantee

- Written once at order creation inside the MongoDB transaction
- Never overwritten by fulfillment, polling, or refund operations
- Admin product updates do **not** modify any existing order's `customerInput`

---

## Admin Configuration Guide

### Creating a Product with Order Fields

```http
POST /api/admin/products
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "Free Fire Diamonds",
  "basePrice": 9.99,
  "minQty": 1,
  "maxQty": 1,
  "category": "games",
  "executionType": "automatic",
  "orderFields": [
    {
      "id": "f1",
      "key": "player_id",
      "label": "Player ID",
      "type": "text",
      "placeholder": "e.g. 123456789",
      "required": true,
      "sortOrder": 1,
      "isActive": true
    },
    {
      "id": "f2",
      "key": "server",
      "label": "Server Region",
      "type": "select",
      "options": ["NA", "EU", "AS", "ME"],
      "required": true,
      "sortOrder": 2,
      "isActive": true
    },
    {
      "id": "f3",
      "key": "amount",
      "label": "Diamond Amount",
      "type": "number",
      "min": 100,
      "max": 10000,
      "required": true,
      "sortOrder": 3,
      "isActive": true
    }
  ],
  "providerMapping": {
    "player_id": "link",
    "server": "server_id",
    "amount": "quantity"
  }
}
```

### Updating Order Fields

```http
PATCH /api/admin/products/:id
{
  "orderFields": [
    { "id": "f1", "key": "player_id", "label": "Game UID", "type": "text", "required": true }
  ]
}
```

> **Note:** The `orderFields` array is replaced wholesale. Provide the full desired array.

### Disabling a Field Without Deleting It

Set `isActive: false`. The field will be skipped in validation and excluded from the snapshot. Historical orders retain their original snapshot.

---

## Order Placement — Customer Flow

```http
POST /api/me/orders
Authorization: Bearer <customer-token>
Content-Type: application/json

{
  "productId": "64abc123...",
  "quantity": 1,
  "orderFieldsValues": {
    "player_id": "hero_123",
    "server": "EU",
    "amount": 500
  }
}
```

**Success response `201`:**
```json
{
  "success": true,
  "message": "Order placed successfully.",
  "data": {
    "order": {
      "_id": "64def...",
      "status": "PROCESSING",
      "totalPrice": 9.99,
      "customerInput": {
        "values": { "player_id": "hero_123", "server": "EU", "amount": 500 },
        "fieldsSnapshot": [
          { "key": "player_id", "label": "Player ID", "type": "text" },
          { "key": "server", "label": "Server Region", "type": "select", "options": ["NA","EU","AS","ME"] },
          { "key": "amount", "label": "Diamond Amount", "type": "number", "min": 100, "max": 10000 }
        ]
      }
    }
  }
}
```

---

## Edge Cases

### Inactive Field in Submission

If a customer submits a key that corresponds to an inactive field, it is treated as **unknown** and rejected.

```json
// field with key "promo_code" has isActive: false
// Submission: { player_id: "123", promo_code: "SAVE10" }
// → Error: "Unknown order field(s): 'promo_code'."
```

### Optional Field Absent

An optional field (`required: false`) that is not submitted is silently skipped. No entry appears in `values`. The field **does** appear in `fieldsSnapshot`.

### Number Coercion

String `"500"` is coerced to number `500` before min/max validation:
```json
// Field: type=number, min=100, max=10000
// Submitted: { amount: "500" }   ← string
// Stored:    { amount: 500 }     ← number
```

### URL Validation

```json
// Valid:
{ "video_url": "https://youtube.com/watch?v=abc" }

// Invalid:
{ "video_url": "ftp://example.com" }   → must start with http/https
{ "video_url": "not-a-url" }           → fails regex
{ "video_url": "" }                    → empty required field
```

### Select Validation

```json
// Field: type=select, options=["NA","EU","AS"]
// Valid:    { server: "EU" }
// Invalid:  { server: "AP" }  → "'Server' must be one of: 'NA', 'EU', 'AS'."
```

### Product With No Order Fields

When `product.orderFields` is empty or all fields are inactive:
- Any submitted `orderFieldsValues` is rejected as unknown keys
- `customerInput` is stored as `null` on the order

### `applyProviderMapping` — Exported Utility

```js
const { applyProviderMapping } = require('./orderFields.validator');

const values = { player_id: "hero_123", server: "EU" };
const mapping = { player_id: "link", server: "server_id" };

applyProviderMapping(values, mapping);
// → { link: "hero_123", server_id: "EU" }

// Keys not in mapping pass through unchanged:
applyProviderMapping({ player_id: "123", ref: "abc" }, { player_id: "link" });
// → { link: "123", ref: "abc" }

// Supports both plain objects and Mongoose Map instances
```
