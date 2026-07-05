import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import DiscountCode from "../../models/discountCode";
import DiscountCodeUsage from "../../models/discountCodeUsage";
import { params } from "../../utils/requestParams";

const parseDate = (value: any): Date | null => {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
};

const validatePayload = (body: any): { ok: true; data: any } | { ok: false; error: string } => {
  const {
    code, type, value, maxDiscountAmount, minBookingAmount,
    activeCountries, applicableServices,
    validFrom, validUntil, usageLimit, perUserLimit, isActive, description
  } = body;

  if (!code || typeof code !== 'string' || code.trim().length < 3) {
    return { ok: false, error: 'Code is required (min 3 characters)' };
  }

  if (!['percentage', 'fixed'].includes(type)) {
    return { ok: false, error: 'Type must be percentage or fixed' };
  }

  if (typeof value !== 'number' || value <= 0) {
    return { ok: false, error: 'Value must be a positive number' };
  }

  if (type === 'percentage' && value > 100) {
    return { ok: false, error: 'Percentage cannot exceed 100' };
  }

  const from = parseDate(validFrom);
  const until = parseDate(validUntil);
  if (!from || !until) return { ok: false, error: 'validFrom and validUntil are required dates' };
  if (until <= from) return { ok: false, error: 'validUntil must be after validFrom' };

  if (activeCountries !== undefined && !Array.isArray(activeCountries)) {
    return { ok: false, error: 'activeCountries must be an array of strings' };
  }
  if (Array.isArray(activeCountries) && !activeCountries.every((c: any) => typeof c === 'string' && c.trim().length > 0)) {
    return { ok: false, error: 'activeCountries must contain only non-empty strings' };
  }

  if (applicableServices !== undefined && !Array.isArray(applicableServices)) {
    return { ok: false, error: 'applicableServices must be an array of strings' };
  }
  if (Array.isArray(applicableServices) && !applicableServices.every((s: any) => typeof s === 'string' && s.trim().length > 0)) {
    return { ok: false, error: 'applicableServices must contain only non-empty strings' };
  }

  return {
    ok: true,
    data: {
      code: code.trim().toUpperCase(),
      type,
      value,
      maxDiscountAmount: typeof maxDiscountAmount === 'number' && maxDiscountAmount > 0 ? maxDiscountAmount : undefined,
      minBookingAmount: typeof minBookingAmount === 'number' && minBookingAmount > 0 ? minBookingAmount : undefined,
      activeCountries: Array.isArray(activeCountries) ? activeCountries.map((c: string) => c.trim().toUpperCase()) : [],
      applicableServices: Array.isArray(applicableServices) ? applicableServices.map((s: string) => s.trim()) : [],
      validFrom: from,
      validUntil: until,
      usageLimit: Number.isInteger(usageLimit) && usageLimit > 0 ? usageLimit : undefined,
      perUserLimit: Number.isInteger(perUserLimit) && perUserLimit > 0 ? perUserLimit : 1,
      isActive: typeof isActive === 'boolean' ? isActive : true,
      description: typeof description === 'string' ? description.trim() : undefined
    }
  };
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const listDiscountCodes = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { status, search, page = '1', limit = '50' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));

    const query: Record<string, any> = {};
    const now = new Date();

    if (status === 'active') {
      query.isActive = true;
      query.validFrom = { $lte: now };
      query.validUntil = { $gte: now };
    } else if (status === 'expired') {
      query.validUntil = { $lt: now };
    } else if (status === 'scheduled') {
      query.validFrom = { $gt: now };
    } else if (status === 'disabled') {
      query.isActive = false;
    }

    if (search && search.trim()) {
      const safeSearch = escapeRegExp(search.trim().slice(0, 64).toUpperCase());
      query.code = { $regex: safeSearch, $options: 'i' };
    }

    const total = await DiscountCode.countDocuments(query);
    const codes = await DiscountCode.find(query)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    return res.status(200).json({
      success: true,
      data: { codes, total, page: pageNum, limit: limitNum }
    });
  } catch (error: any) {
    console.error('List discount codes error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to list discount codes' });
  }
};

export const getDiscountCode = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }
    const code = await DiscountCode.findById(id).lean();
    if (!code) return res.status(404).json({ success: false, msg: 'Discount code not found' });

    const usageCount = await DiscountCodeUsage.countDocuments({ code: id });
    return res.status(200).json({ success: true, data: { code, usageCount } });
  } catch (error: any) {
    console.error('Get discount code error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load discount code' });
  }
};

export const createDiscountCode = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const adminId = (req as any).admin?._id;
    if (!adminId) return res.status(401).json({ success: false, msg: 'Authentication required' });

    const result = validatePayload(req.body);
    if (!result.ok) return res.status(400).json({ success: false, msg: result.error });

    const existing = await DiscountCode.findOne({ code: result.data.code });
    if (existing) return res.status(409).json({ success: false, msg: 'A code with this value already exists' });

    const created = await DiscountCode.create({ ...result.data, createdBy: adminId });
    return res.status(201).json({ success: true, data: { code: created } });
  } catch (error: any) {
    console.error('Create discount code error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to create discount code' });
  }
};

export const updateDiscountCode = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const result = validatePayload(req.body);
    if (!result.ok) return res.status(400).json({ success: false, msg: result.error });

    const conflict = await DiscountCode.findOne({ code: result.data.code, _id: { $ne: id } });
    if (conflict) return res.status(409).json({ success: false, msg: 'Another code already uses this value' });

    const updated = await DiscountCode.findByIdAndUpdate(id, result.data, { new: true });
    if (!updated) return res.status(404).json({ success: false, msg: 'Discount code not found' });

    return res.status(200).json({ success: true, data: { code: updated } });
  } catch (error: any) {
    console.error('Update discount code error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to update discount code' });
  }
};

export const deleteDiscountCode = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }
    const updated = await DiscountCode.findByIdAndUpdate(id, { isActive: false }, { new: true });
    if (!updated) return res.status(404).json({ success: false, msg: 'Discount code not found' });
    return res.status(200).json({ success: true, data: { code: updated } });
  } catch (error: any) {
    console.error('Delete discount code error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to delete discount code' });
  }
};
