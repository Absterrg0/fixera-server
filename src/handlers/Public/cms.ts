import { Request, Response } from "express";
import CmsContent, {
  CMS_CONTENT_TYPES,
  CmsContentType,
  FAQ_CATEGORIES,
  FAQ_CATEGORY_SLUGS,
} from "../../models/cmsContent";
import connectDB from "../../config/db";
import { presignCmsDoc, presignCmsDocs } from "../../utils/cmsPresign";
import { toSlug } from "../../utils/slug";
import { param } from "../../utils/requestParams";

const LISTING_FIELDS =
  "type title slug locale excerpt coverImage tags publishedAt seo category author authorOverride updatedAt";

const BOT_UA_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegram|prerender|headlesschrome|lighthouse/i;

export const listPublicCmsContent = async (req: Request, res: Response) => {
  try {
    const type = param(req.params.type) as CmsContentType;
    if (!CMS_CONTENT_TYPES.includes(type)) {
      return res.status(404).json({ success: false, msg: "Unknown content type" });
    }

    const rawPage = Number((req.query.page as string) ?? "1");
    const page = Math.max(1, Number.isFinite(rawPage) ? Math.trunc(rawPage) : 1);
    const rawLimit = Number((req.query.limit as string) ?? "12");
    const limit = Math.min(
      50,
      Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 12)
    );
    const skip = (page - 1) * limit;

    const locale = typeof req.query.locale === "string" ? req.query.locale.toLowerCase() : "en";
    const filter: Record<string, unknown> = { type, status: "published", locale };

    const tag = typeof req.query.tag === "string" ? req.query.tag.toLowerCase() : "";
    if (tag) filter.tags = tag;

    const serviceSlug =
      typeof req.query.serviceSlug === "string" ? toSlug(req.query.serviceSlug) : "";
    if (serviceSlug && (type === "blog" || type === "news")) {
      filter.relatedServiceSlug = serviceSlug;
    }

    await connectDB();

    const [items, total] = await Promise.all([
      CmsContent.find(filter)
        .select(LISTING_FIELDS)
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("author", "name")
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
    console.error("Public list CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load content" });
  }
};

export const getPublicCmsContentBySlug = async (req: Request, res: Response) => {
  try {
    const type = param(req.params.type) as CmsContentType;
    if (!CMS_CONTENT_TYPES.includes(type)) {
      return res.status(404).json({ success: false, msg: "Unknown content type" });
    }

    const slug = param(req.params.slug).toLowerCase();
    if (!slug) return res.status(404).json({ success: false, msg: "Not found" });

    const locale = typeof req.query.locale === "string" ? req.query.locale.toLowerCase() : "en";

    await connectDB();

    const doc = await CmsContent.findOne({ type, slug, locale, status: "published" })
      .populate("author", "name")
      .populate({
        path: "relatedContent",
        match: { status: "published" },
        select: "title slug type excerpt coverImage publishedAt",
      })
      .populate("relatedServices", "name slug")
      .lean();

    if (!doc) return res.status(404).json({ success: false, msg: "Not found" });

    const ua = req.get("user-agent") || "";
    if (!BOT_UA_RE.test(ua)) {
      CmsContent.updateOne({ _id: doc._id }, { $inc: { viewCount: 1 } }).catch((err) =>
        console.error("CMS viewCount increment failed:", err)
      );
    }

    const presigned = await presignCmsDoc(doc);
    return res.status(200).json({ success: true, data: presigned });
  } catch (error) {
    console.error("Public get CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load content" });
  }
};

export const listPublicPolicyLinks = async (req: Request, res: Response) => {
  try {
    const locale = typeof req.query.locale === "string" ? req.query.locale.toLowerCase() : "en";

    await connectDB();
    const items = await CmsContent.find({ type: "policy", status: "published", locale })
      .select("title slug updatedAt publishedAt")
      .sort({ title: 1 })
      .lean();

    const RESERVED: Record<string, string> = { "privacy-policy": "/privacy-policy" };
    const payload = items.map((i) => ({
      title: i.title,
      slug: i.slug,
      path: RESERVED[i.slug] || `/pages/${i.slug}`,
    }));

    return res.status(200).json({ success: true, data: { items: payload } });
  } catch (error) {
    console.error("Public policy-links error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load policy links" });
  }
};

export const listPublicFaq = async (req: Request, res: Response) => {
  try {
    const locale = typeof req.query.locale === "string" ? req.query.locale.toLowerCase() : "en";

    await connectDB();

    const items = await CmsContent.find({ type: "faq", status: "published", locale })
      .select("title slug body category publishedAt updatedAt")
      .sort({ category: 1, publishedAt: -1 })
      .lean();

    const byCategory: Record<string, any[]> = {};
    for (const slug of FAQ_CATEGORY_SLUGS) byCategory[slug] = [];
    for (const item of items) {
      const cat = item.category && FAQ_CATEGORY_SLUGS.includes(item.category) ? item.category : "general";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(item);
    }

    const groups = FAQ_CATEGORIES.map((c) => ({
      slug: c.slug,
      name: c.name,
      items: byCategory[c.slug] || [],
    })).filter((g) => g.items.length > 0);

    return res.status(200).json({ success: true, data: { groups, categories: FAQ_CATEGORIES } });
  } catch (error) {
    console.error("Public FAQ error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load FAQ" });
  }
};

const SITEMAP_MAX_LIMIT = 50000;
const SITEMAP_DEFAULT_LIMIT = 1000;

export const listCmsSitemapEntries = async (req: Request, res: Response) => {
  try {
    await connectDB();

    const rawLimit = Number((req.query.limit as string) ?? String(SITEMAP_DEFAULT_LIMIT));
    const limit = Math.min(
      SITEMAP_MAX_LIMIT,
      Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : SITEMAP_DEFAULT_LIMIT)
    );
    const rawPage = Number((req.query.page as string) ?? "1");
    const page = Math.max(1, Number.isFinite(rawPage) ? Math.trunc(rawPage) : 1);
    const skip = (page - 1) * limit;

    const filter = { status: "published" };

    const [items, total] = await Promise.all([
      CmsContent.find(filter)
        .select("type slug locale updatedAt publishedAt")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CmsContent.countDocuments(filter),
    ]);

    if (items.length >= SITEMAP_MAX_LIMIT) {
      console.warn(
        `CMS sitemap response truncated at SITEMAP_MAX_LIMIT=${SITEMAP_MAX_LIMIT}; clients must paginate`
      );
    }

    const hasMore = skip + items.length < total;
    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page, limit, total, totalPages, hasMore },
      },
    });
  } catch (error) {
    console.error("CMS sitemap entries error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load sitemap entries" });
  }
};
