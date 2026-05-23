'use strict';

/**
 * category.service.js
 *
 * Business logic for category CRUD.
 * All operations are single-document writes (inherently atomic).
 */

const { Category } = require('./category.model');
const { NotFoundError, ConflictError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { CATEGORY_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

// ─── List ──────────────────────────────────────────────────────────────────────

/**
 * List categories with optional filtering.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.includeInactive=false] - include isActive: false
 * @returns {Category[]}
 */
const listCategories = async ({ includeInactive = false } = {}) => {
    const filter = includeInactive ? {} : { isActive: true };
    return Category.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
};

// ─── Get One ───────────────────────────────────────────────────────────────────

const getCategoryById = async (id) => {
    const category = await Category.findById(id).lean();
    if (!category) throw new NotFoundError('Category');
    return category;
};

// ─── Create ────────────────────────────────────────────────────────────────────

const createCategory = async (data, adminId) => {
    // Check for duplicate name
    const existing = await Category.findOne({
        $or: [
            { name: { $regex: `^${data.name.trim()}$`, $options: 'i' } },
            ...(data.nameAr ? [{ nameAr: { $regex: `^${data.nameAr.trim()}$`, $options: 'i' } }] : []),
        ],
    });
    if (existing) {
        throw new ConflictError('A category with this name already exists.');
    }

    const category = await Category.create({
        name: data.name.trim(),
        nameAr: data.nameAr?.trim() || null,
        image: data.image || null,
        sortOrder: data.sortOrder ?? 0,
        isActive: data.isActive !== false,
        parentCategory: data.parentCategory || null,
    });

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: CATEGORY_ACTIONS.CREATED,
        entityType: ENTITY_TYPES.CATEGORY,
        entityId: category._id,
        metadata: { name: category.name, nameAr: category.nameAr },
    });

    return category.toObject();
};

// ─── Update ────────────────────────────────────────────────────────────────────

const updateCategory = async (id, data, adminId) => {
    const category = await Category.findById(id);
    if (!category) throw new NotFoundError('Category');

    const before = category.toObject();

    if (data.name !== undefined) category.name = data.name.trim();
    if (data.nameAr !== undefined) category.nameAr = data.nameAr?.trim() || null;
    if (data.image !== undefined) category.image = data.image || null;
    if (data.sortOrder !== undefined) category.sortOrder = data.sortOrder;
    if (data.isActive !== undefined) category.isActive = data.isActive;
    if (data.slug !== undefined) category.slug = data.slug;
    if (data.parentCategory !== undefined) category.parentCategory = data.parentCategory || null;

    await category.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: CATEGORY_ACTIONS.UPDATED,
        entityType: ENTITY_TYPES.CATEGORY,
        entityId: category._id,
        metadata: { before, after: category.toObject() },
    });

    return category.toObject();
};

// ─── Toggle Active ─────────────────────────────────────────────────────────────

const toggleCategory = async (id, adminId) => {
    const category = await Category.findById(id);
    if (!category) throw new NotFoundError('Category');

    category.isActive = !category.isActive;
    await category.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: CATEGORY_ACTIONS.UPDATED,
        entityType: ENTITY_TYPES.CATEGORY,
        entityId: category._id,
        metadata: { toggled: true, isActive: category.isActive },
    });

    return category.toObject();
};

// ─── Delete ────────────────────────────────────────────────────────────────────

/**
 * Hard-delete a category.
 * Products referencing this category will have their category set to null.
 */
const deleteCategory = async (id, adminId) => {
    const category = await Category.findById(id);
    if (!category) throw new NotFoundError('Category');

    const { Product } = require('../products/product.model');
    // Clear category reference from all products that use this category
    await Product.updateMany(
        { category: category._id.toString() },
        { $set: { category: null } }
    );

    await category.deleteOne();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: CATEGORY_ACTIONS.DELETED,
        entityType: ENTITY_TYPES.CATEGORY,
        entityId: category._id,
        metadata: { name: category.name },
    });

    return { success: true, deletedId: id };
};

module.exports = {
    listCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    toggleCategory,
    deleteCategory,
};
