'use strict';

const mongoose = require('mongoose');

/**
 * Generic auto-increment counter collection.
 *
 * Each document represents a named counter (e.g. "orderNumber").
 * Use `getNextSequence(name)` to atomically increment and return
 * the next value, initialising the counter at a given start value
 * if it doesn't yet exist.
 *
 * ─── IMPORTANT: MongoDB Transaction Limitation ────────────────────────────────
 * MongoDB does NOT allow `upsert: true` inside a multi-document transaction
 * if the document doesn't already exist (it would implicitly create the
 * collection, which is forbidden inside txns).
 *
 * Solution: The first call (upsert) runs OUTSIDE the session.
 * Subsequent calls (document already exists) run INSIDE the session
 * for transactional consistency.
 */
const counterSchema = new mongoose.Schema({
    _id: {
        type: String,
        required: true,
    },
    seq: {
        type: Number,
        required: true,
        default: 0,
    },
});

const Counter = mongoose.model('Counter', counterSchema);

/**
 * Atomically get the next value for a named sequence.
 *
 * @param {string}  name       - Unique counter name (e.g. "orderNumber")
 * @param {number}  [startAt]  - Initial value when the counter is first created
 *                                (the FIRST returned value will be startAt + 1)
 * @param {import('mongoose').ClientSession} [session] - optional transaction session
 * @returns {Promise<number>}  The next sequential value
 */
const getNextSequence = async (name, startAt = 9999, session = null) => {
    // ── Step 1: Ensure the counter document exists (OUTSIDE any txn) ──────────
    // This is a no-op if the document already exists (99.99% of calls).
    // The very first call will create it with seq = startAt.
    const exists = await Counter.findById(name);
    if (!exists) {
        try {
            await Counter.create({ _id: name, seq: startAt });
        } catch (err) {
            // E11000 duplicate key — another concurrent request beat us to it.
            // Totally fine, we'll just increment below.
            if (err.code !== 11000) throw err;
        }
    }

    // ── Step 2: Atomically increment (INSIDE the txn session if provided) ────
    const opts = session ? { session } : {};
    const counter = await Counter.findByIdAndUpdate(
        name,
        { $inc: { seq: 1 } },
        {
            new: true,                // return the updated document
            ...opts,
        }
    );

    return counter.seq;
};

module.exports = { Counter, getNextSequence };
