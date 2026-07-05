import { Request, Response, NextFunction } from "express";

import mongoose from "mongoose";
import CmsContent, {
  CMS_CONTENT_TYPES,
  CMS_CONTENT_STATUSES,
  CmsContentType,
  CmsContentStatus,
  FAQ_CATEGORIES,
  FAQ_CATEGORY_SLUGS,
} from "../../models/cmsContent";
import ServiceConfiguration from "../../models/serviceConfiguration";
import connecToDatabase from "../../config/db";
import { IUser } from "../../models/user";
import {
  uploadToS3,
  generateFileName,
  validateImageFileBuffer,
  parseS3KeyFromUrl,
  deleteFromS3,
  presignS3Url,
} from "../../utils/s3Upload";
import { presignCmsDoc, presignCmsDocs } from "../../utils/cmsPresign";
import { toSlug } from "../../utils/slug";
import { param, params } from "../../utils/requestParams";

const isValidObjectId = (id: string): boolean => mongoose.Types.ObjectId.isValid(id);

const sanitizeStringArray = (input: unknown, max = 20): string[] => {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
        .filter((v) => v.length > 0 && v.length <= 60)
    )
  ).slice(0, max);
};

const sanitizeObjectIdArray = (input: unknown, max = 20): mongoose.Types.ObjectId[] => {
  if (!Array.isArray(input)) return [];
  const out: mongoose.Types.ObjectId[] = [];
  for (const v of input) {
    if (typeof v === "string" && isValidObjectId(v)) {
      out.push(new mongoose.Types.ObjectId(v));
    }
    if (out.length >= max) break;
  }
  return out;
};

const pickSeo = (input: any) => {
  if (!input || typeof input !== "object") return {};
  const seo: Record<string, unknown> = {};
  if (typeof input.titleTag === "string") seo.titleTag = input.titleTag.trim().slice(0, 120);
  if (typeof input.metaDescription === "string")
    seo.metaDescription = input.metaDescription.trim().slice(0, 300);
  if (typeof input.ogTitle === "string") seo.ogTitle = input.ogTitle.trim().slice(0, 120);
  if (typeof input.ogImage === "string") seo.ogImage = input.ogImage.trim();
  if (typeof input.canonical === "string") seo.canonical = input.canonical.trim();
  if (typeof input.noindex === "boolean") seo.noindex = input.noindex;
  return seo;
};

export const listFaqCategories = async (_req: Request, res: Response) => {
  return res.status(200).json({ success: true, data: FAQ_CATEGORIES });
};

async function loadServiceSlugOptions(): Promise<Array<{ slug: string; label: string }>> {
  const configs = await ServiceConfiguration.find({}).select("service").lean();
  const seen = new Set<string>();
  const items: Array<{ slug: string; label: string }> = [];
  for (const c of configs) {
    const name = (c.service || "").trim();
    if (!name) continue;
    const slug = toSlug(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    items.push({ slug, label: name });
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

export const listCmsServiceOptions = async (_req: Request, res: Response) => {
  try {
    await connecToDatabase();
    const items = await loadServiceSlugOptions();
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    console.error("List CMS service options error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load service options" });
  }
};

const RESERVED_LANDING_SLOTS: Array<{ slug: string; label: string; usedFor: string }> = [
  { slug: "about", label: "About", usedFor: "About page (overrides hardcoded content)" },
];

async function buildLandingSlotDefs() {
  const configs = await ServiceConfiguration.find({}).select("service category").lean();
  const seen = new Set<string>();
  const services: Array<{ slug: string; label: string; category?: string }> = [];
  for (const c of configs) {
    const name = (c.service || "").trim();
    if (!name) continue;
    const slug = toSlug(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    services.push({ slug, label: name, category: (c.category || "").trim() || undefined });
  }
  services.sort((a, b) => a.label.localeCompare(b.label));

  const reservedSlugs = new Set(RESERVED_LANDING_SLOTS.map((r) => r.slug));
  return [
    ...RESERVED_LANDING_SLOTS.map((r) => ({ ...r, category: undefined as string | undefined, reserved: true })),
    ...services
      .filter((s) => !reservedSlugs.has(s.slug))
      .map((s) => ({
        slug: s.slug,
        label: s.label,
        usedFor: s.category ? `Service · ${s.category}` : "Service",
        category: s.category,
        reserved: false,
      })),
  ];
}

export const listCmsLandingSlots = async (_req: Request, res: Response) => {
  try {
    await connecToDatabase();
    const slotDefs = await buildLandingSlotDefs();
    const slugs = slotDefs.map((s) => s.slug);
    const existing = await CmsContent.find({ type: "landing", slug: { $in: slugs }, locale: "en" }).lean();
    const bySlug = new Map(existing.map((doc) => [doc.slug, doc]));

    const slots = slotDefs.map((s) => {
      const item = bySlug.get(s.slug);
      return {
        slug: s.slug,
        label: s.label,
        usedFor: s.usedFor,
        category: s.category,
        reserved: s.reserved,
        item: item
          ? {
              _id: String(item._id),
              status: item.status,
              title: item.title,
              updatedAt: item.updatedAt,
            }
          : null,
      };
    });

    return res.status(200).json({ success: true, data: { slots } });
  } catch (error) {
    console.error("List CMS landing slots error:", error);
    return res.status(500).json({ success: false, msg: "Failed to list landing slots" });
  }
};

export const syncCmsLandingSlots = async (req: Request, res: Response) => {
  try {
    const admin = (req as Request & { admin?: IUser }).admin;
    await connecToDatabase();
    const slotDefs = await buildLandingSlotDefs();
    const slugs = slotDefs.map((s) => s.slug);
    const existing = await CmsContent.find({ type: "landing", slug: { $in: slugs }, locale: "en" }).select("slug").lean();
    const existingSlugs = new Set(existing.map((d) => d.slug));
    const missing = slotDefs.filter((s) => !existingSlugs.has(s.slug));

    const attempted = missing.length;
    if (attempted === 0) {
      return res.status(200).json({ success: true, data: { attempted: 0, created: 0 } });
    }

    const docsToCreate = missing.map((s) => ({
      type: "landing" as const,
      title: s.label,
      slug: s.slug,
      locale: "en",
      body: "",
      status: "draft" as const,
      author: admin?._id,
      tags: [],
      seo: {},
    }));

    let created = 0;
    try {
      const result = await CmsContent.insertMany(docsToCreate, { ordered: false });
      created = Array.isArray(result) ? result.length : 0;
    } catch (err: any) {
      const writeErrors: any[] | undefined = Array.isArray(err?.writeErrors) ? err.writeErrors : undefined;
      const allDuplicates = writeErrors && writeErrors.length > 0
        ? writeErrors.every((e: any) => (e?.code ?? e?.err?.code) === 11000)
        : err?.code === 11000;
      if (!allDuplicates) {
        console.error("[syncCmsLandingSlots] insertMany failed with non-duplicate errors:", err);
        throw err;
      }
      const insertedCount = typeof err?.result?.insertedCount === "number"
        ? err.result.insertedCount
        : typeof err?.insertedDocs?.length === "number"
          ? err.insertedDocs.length
          : Math.max(0, attempted - (writeErrors?.length ?? 0));
      created = insertedCount;
    }

    return res.status(200).json({ success: true, data: { attempted, created } });
  } catch (error) {
    console.error("Sync CMS landing slots error:", error);
    return res.status(500).json({ success: false, msg: "Failed to sync landing slots" });
  }
};

export const listCmsContent = async (req: Request, res: Response) => {
  try {
    await connecToDatabase();

    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "20", 10)));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    const { type, status, search, category, tag, locale } = req.query as Record<string, string>;

    if (type && CMS_CONTENT_TYPES.includes(type as CmsContentType)) filter.type = type;
    if (status && CMS_CONTENT_STATUSES.includes(status as CmsContentStatus)) filter.status = status;
    if (category) filter.category = category.toLowerCase();
    if (tag) filter.tags = tag.toLowerCase();
    if (locale) filter.locale = locale.toLowerCase();
    if (search && search.trim()) {
      const term = search.trim();
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { $text: { $search: term } },
        { slug: new RegExp("^" + escaped, "i") },
      ];
    }

    const [items, total] = await Promise.all([
      CmsContent.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("author", "name email")
        .lean(),
      CmsContent.countDocuments(filter),
    ]);

    const presigned = await presignCmsDocs(items);

    return res.status(200).json({
      success: true,
      data: {
        items: presigned,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error("List CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to list CMS content" });
  }
};

export const getCmsContentById = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, msg: "Invalid content ID" });
    }

    await connecToDatabase();
    const doc = await CmsContent.findById(id)
      .populate("author", "name email")
      .populate("relatedContent", "title slug type")
      .populate("relatedServices", "name slug")
      .lean();

    if (!doc) {
      return res.status(404).json({ success: false, msg: "Content not found" });
    }

    const presigned = await presignCmsDoc(doc);
    return res.status(200).json({ success: true, data: presigned });
  } catch (error) {
    console.error("Get CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to fetch content" });
  }
};

export const createCmsContent = async (req: Request, res: Response) => {
  try {
    const admin = req.admin as IUser;
    const body = req.body || {};

    const type = body.type as CmsContentType;
    if (!CMS_CONTENT_TYPES.includes(type)) {
      return res.status(400).json({ success: false, msg: "Invalid or missing type" });
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return res.status(400).json({ success: false, msg: "Title is required" });
    }

    const slug = toSlug(typeof body.slug === "string" && body.slug.trim() ? body.slug : title);
    if (!slug) {
      return res.status(400).json({ success: false, msg: "Slug is required" });
    }

    const locale = typeof body.locale === "string" && body.locale.trim() ? body.locale.trim().toLowerCase() : "en";
    const status: CmsContentStatus = CMS_CONTENT_STATUSES.includes(body.status)
      ? body.status
      : "draft";

    const coverImage = typeof body.coverImage === "string" ? body.coverImage.trim() : "";
    if ((type === "blog" || type === "news") && !coverImage) {
      return res.status(400).json({ success: false, msg: "Cover image is required for blog and news" });
    }

    let category: string | undefined;
    if (type === "faq") {
      const cat = typeof body.category === "string" ? body.category.trim().toLowerCase() : "";
      if (!cat || !FAQ_CATEGORY_SLUGS.includes(cat)) {
        return res.status(400).json({ success: false, msg: "FAQ category is required and must be valid" });
      }
      category = cat;
    }

    await connecToDatabase();

    const existing = await CmsContent.findOne({ type, slug, locale });
    if (existing) {
      return res.status(409).json({ success: false, msg: "Slug already exists for this type and locale" });
    }

    const authorOverride =
      typeof body.authorOverride === "string" && body.authorOverride.trim()
        ? body.authorOverride.trim().slice(0, 120)
        : undefined;

    let relatedServiceSlug: string | undefined;
    if ((type === "blog" || type === "news") && typeof body.relatedServiceSlug === "string") {
      const candidate = toSlug(body.relatedServiceSlug);
      if (candidate) {
        const allowed = new Set((await loadServiceSlugOptions()).map((s) => s.slug));
        if (!allowed.has(candidate)) {
          return res.status(400).json({ success: false, msg: "Invalid related service" });
        }
        relatedServiceSlug = candidate;
      }
    }

    const doc = await CmsContent.create({
      type,
      title,
      slug,
      locale,
      body: typeof body.body === "string" ? body.body : "",
      excerpt: typeof body.excerpt === "string" ? body.excerpt.trim().slice(0, 500) : undefined,
      coverImage: coverImage || undefined,
      category,
      tags: type === "blog" || type === "news" ? sanitizeStringArray(body.tags) : [],
      status,
      author: admin._id,
      authorOverride,
      seo: pickSeo(body.seo),
      relatedContent: sanitizeObjectIdArray(body.relatedContent),
      relatedServices: sanitizeObjectIdArray(body.relatedServices),
      relatedServiceSlug,
    });

    const presigned = await presignCmsDoc(doc.toObject());
    return res.status(201).json({ success: true, data: presigned });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, msg: "Slug already exists for this type and locale" });
    }
    console.error("Create CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to create content" });
  }
};

export const updateCmsContent = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, msg: "Invalid content ID" });
    }

    await connecToDatabase();
    const doc = await CmsContent.findById(id);
    if (!doc) {
      return res.status(404).json({ success: false, msg: "Content not found" });
    }

    const body = req.body || {};

    if (typeof body.title === "string" && body.title.trim()) doc.title = body.title.trim();

    const finalSlug =
      typeof body.slug === "string" && body.slug.trim() ? toSlug(body.slug) : doc.slug;
    const finalLocale =
      typeof body.locale === "string" && body.locale.trim()
        ? body.locale.trim().toLowerCase()
        : doc.locale;

    if (!finalSlug) {
      return res.status(400).json({ success: false, msg: "Slug is required" });
    }

    if (finalSlug !== doc.slug || finalLocale !== doc.locale) {
      const clash = await CmsContent.findOne({
        type: doc.type,
        slug: finalSlug,
        locale: finalLocale,
        _id: { $ne: doc._id },
      });
      if (clash) {
        const slugChanged = finalSlug !== doc.slug;
        const localeChanged = finalLocale !== doc.locale;
        const detail = slugChanged && localeChanged ? "slug and locale" : slugChanged ? "slug" : "locale";
        return res.status(409).json({
          success: false,
          msg: `Another ${doc.type} already uses this ${detail} (${finalSlug} / ${finalLocale})`,
        });
      }
      doc.slug = finalSlug;
      doc.locale = finalLocale;
    }

    if (typeof body.body === "string") doc.body = body.body;
    if (typeof body.excerpt === "string") doc.excerpt = body.excerpt.trim().slice(0, 500);

    let previousCoverToCleanup: string | undefined;
    if (typeof body.coverImage === "string") {
      const cover = body.coverImage.trim();
      if ((doc.type === "blog" || doc.type === "news") && !cover) {
        return res.status(400).json({ success: false, msg: "Cover image is required for blog and news" });
      }
      const nextCover = cover || undefined;
      if (doc.coverImage && doc.coverImage !== nextCover) {
        previousCoverToCleanup = doc.coverImage;
      }
      doc.coverImage = nextCover;
    }

    if (doc.type === "faq" && typeof body.category === "string") {
      const cat = body.category.trim().toLowerCase();
      if (!FAQ_CATEGORY_SLUGS.includes(cat)) {
        return res.status(400).json({ success: false, msg: "Invalid FAQ category" });
      }
      doc.category = cat;
    }

    if (Array.isArray(body.tags) && (doc.type === "blog" || doc.type === "news")) {
      doc.tags = sanitizeStringArray(body.tags);
    }

    if (body.status && CMS_CONTENT_STATUSES.includes(body.status)) {
      doc.status = body.status;
    }

    if (body.seo !== undefined) {
      doc.seo = { ...(doc.seo || {}), ...pickSeo(body.seo) };
    }

    if (Array.isArray(body.relatedContent)) doc.relatedContent = sanitizeObjectIdArray(body.relatedContent);
    if (Array.isArray(body.relatedServices)) doc.relatedServices = sanitizeObjectIdArray(body.relatedServices);

    if (typeof body.authorOverride === "string") {
      const v = body.authorOverride.trim().slice(0, 120);
      doc.authorOverride = v || undefined;
    }

    if (body.relatedServiceSlug === null) {
      doc.relatedServiceSlug = undefined;
    } else if (typeof body.relatedServiceSlug === "string") {
      if (doc.type === "blog" || doc.type === "news") {
        const trimmed = body.relatedServiceSlug.trim();
        if (!trimmed) {
          doc.relatedServiceSlug = undefined;
        } else {
          const candidate = toSlug(trimmed);
          if (!candidate) {
            doc.relatedServiceSlug = undefined;
          } else {
            const allowed = new Set((await loadServiceSlugOptions()).map((s) => s.slug));
            if (!allowed.has(candidate)) {
              return res.status(400).json({ success: false, msg: "Invalid related service" });
            }
            doc.relatedServiceSlug = candidate;
          }
        }
      } else {
        doc.relatedServiceSlug = undefined;
      }
    }

    await doc.save();

    if (previousCoverToCleanup) {
      const key = parseS3KeyFromUrl(previousCoverToCleanup);
      if (key && key.startsWith("cms/")) {
        deleteFromS3(key).catch((err) =>
          console.error("Failed to delete replaced CMS cover image:", err)
        );
      }
    }

    const presigned = await presignCmsDoc(doc.toObject());
    return res.status(200).json({ success: true, data: presigned });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, msg: "Slug already exists for this type and locale" });
    }
    console.error("Update CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to update content" });
  }
};

export const deleteCmsContent = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, msg: "Invalid content ID" });
    }

    await connecToDatabase();
    const doc = await CmsContent.findByIdAndDelete(id);
    if (!doc) {
      return res.status(404).json({ success: false, msg: "Content not found" });
    }

    if (doc.coverImage) {
      const key = parseS3KeyFromUrl(doc.coverImage);
      if (key && key.startsWith("cms/")) {
        try { await deleteFromS3(key); } catch (err) {
          console.error("Failed to delete CMS cover image:", err);
        }
      }
    }

    return res.status(200).json({ success: true, msg: "Content deleted" });
  } catch (error) {
    console.error("Delete CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to delete content" });
  }
};

export const getCmsPreviewBySlug = async (req: Request, res: Response) => {
  try {
    const type = param(req.params.type) as CmsContentType;
    if (!CMS_CONTENT_TYPES.includes(type)) {
      return res.status(404).json({ success: false, msg: "Unknown content type" });
    }
    const slug = param(req.params.slug).toLowerCase();
    if (!slug) return res.status(404).json({ success: false, msg: "Not found" });

    const locale = typeof req.query.locale === "string" ? req.query.locale.toLowerCase() : "en";

    await connecToDatabase();
    const doc = await CmsContent.findOne({ type, slug, locale })
      .populate("author", "name email")
      .populate({ path: "relatedContent", select: "title slug type excerpt coverImage publishedAt" })
      .populate("relatedServices", "name slug")
      .lean();

    if (!doc) return res.status(404).json({ success: false, msg: "Not found" });

    const presigned = await presignCmsDoc(doc);
    return res.status(200).json({ success: true, data: presigned });
  } catch (error) {
    console.error("Admin CMS preview error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load preview" });
  }
};

export const uploadCmsImage = async (req: Request, res: Response) => {
  try {
    const admin = req.admin as IUser;
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, msg: "No image file provided" });
    }

    const validation = await validateImageFileBuffer(file, 5 * 1024 * 1024);
    if (!validation.valid) {
      return res.status(400).json({ success: false, msg: validation.error });
    }
    if (validation.detectedMime) file.mimetype = validation.detectedMime;

    const fileName = generateFileName(file.originalname, admin._id.toString(), "cms");
    const result = await uploadToS3(file, fileName);

    let signedUrl: string | null = null;
    try {
      signedUrl = await presignS3Url(result.url);
    } catch (presignError) {
      console.error("Upload CMS image presign error:", { url: result.url, error: presignError });
      return res.status(500).json({ success: false, msg: "Failed to generate signed URL" });
    }
    if (!signedUrl) {
      console.error("Upload CMS image presign error: presignS3Url returned null", { url: result.url });
      return res.status(500).json({ success: false, msg: "Failed to generate signed URL" });
    }

    return res.status(200).json({ success: true, data: { url: signedUrl, key: result.key } });
  } catch (error) {
    console.error("Upload CMS image error:", error);
    return res.status(500).json({ success: false, msg: "Failed to upload image" });
  }
};
