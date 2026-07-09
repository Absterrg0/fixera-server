import mongoose from "mongoose";
import connectDB from "../config/db";
import CmsContent from "../models/cmsContent";
import User from "../models/user";

interface DefaultPolicy {
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  seo: {
    titleTag: string;
    metaDescription: string;
  };
}

const DEFAULTS: DefaultPolicy[] = [
  {
    slug: "about",
    title: "About Fixtract",
    excerpt:
      "Fixtract connects homeowners with vetted professionals for reliable, transparent home services.",
    body: `<h2>Who we are</h2>
<p>Fixtract is a marketplace that connects homeowners and businesses with vetted professionals for home services — from plumbing and electrical to solar installations and renovations. We built Fixtract to make hiring trades honest, fast, and transparent.</p>

<h2>What we do</h2>
<p>We verify every professional on the platform, standardize quoting and invoicing, hold payments in escrow until work is complete, and back every job with a warranty and dispute process. Customers get reliable pros; professionals get a steady flow of serious work.</p>

<h2>How we work</h2>
<ul>
  <li><strong>Vetted professionals.</strong> Background checks, license verification, and review-gated onboarding.</li>
  <li><strong>Transparent pricing.</strong> Upfront quotes, milestone-based invoicing, no surprise fees.</li>
  <li><strong>Protected payments.</strong> Escrow until milestones are approved — both sides stay safe.</li>
  <li><strong>Real accountability.</strong> Verified reviews, warranty coverage, and a real dispute team.</li>
</ul>

<h2>Contact</h2>
<p>Questions or feedback? Reach us through the <a href="/chat">support chat</a> — we read every message.</p>`,
    seo: {
      titleTag: "About Fixtract — Vetted Home Service Professionals",
      metaDescription:
        "Learn how Fixtract connects homeowners with vetted professionals for plumbing, electrical, solar, and more — with transparent pricing and warranty-backed work.",
    },
  },
  {
    slug: "privacy-policy",
    title: "Privacy Policy",
    excerpt:
      "How Fixtract collects, uses, and protects your personal information.",
    body: `<h2>1. Information we collect</h2>
<p>We collect information you provide directly (name, email, phone, address, payment details) and information generated through your use of Fixtract (bookings, messages, reviews, device and usage data).</p>

<h2>2. How we use your information</h2>
<ul>
  <li>Operate the marketplace: match you with professionals, process bookings, and handle payments.</li>
  <li>Communicate with you about your account, bookings, and support requests.</li>
  <li>Improve safety, prevent fraud, and enforce our terms.</li>
  <li>Send service updates and, with your consent, marketing communications.</li>
</ul>

<h2>3. Sharing your information</h2>
<p>We share information with professionals you book, payment processors (Stripe), identity-verification partners, and service providers that help us run Fixtract. We do not sell your personal information.</p>

<h2>4. Your rights</h2>
<p>You can access, correct, export, or delete your personal data from your account settings, or by contacting us. If you are in the EU/UK, you also have rights under GDPR including the right to object to processing.</p>

<h2>5. Data retention</h2>
<p>We keep your data for as long as your account is active and for a reasonable period after, to comply with legal obligations, resolve disputes, and enforce our agreements.</p>

<h2>6. Security</h2>
<p>We use industry-standard measures to protect your data, including encryption in transit, access controls, and regular security reviews. No system is perfectly secure — please use a strong password and keep your credentials private.</p>

<h2>7. Contact</h2>
<p>Questions about this policy? Reach us through the <a href="/chat">support chat</a> or email <a href="mailto:privacy@fixtract.com">privacy@fixtract.com</a>.</p>`,
    seo: {
      titleTag: "Privacy Policy — Fixtract",
      metaDescription:
        "How Fixtract collects, uses, and protects your personal information, and the rights you have over your data.",
    },
  },
];

const seedCmsDefaults = async () => {
  try {
    console.log("🌱 Seeding CMS default policies...");
    await connectDB();
    console.log("✅ Connected to database");

    const admin = await User.findOne({ role: "admin" }).select("_id email");
    if (!admin) {
      console.log(
        "⚠️  No admin user found. Run `npm run seed:admin` first, then re-run this script."
      );
      process.exit(1);
    }
    console.log(`✅ Using admin author: ${admin.email}`);

    let created = 0;
    let skipped = 0;

    for (const def of DEFAULTS) {
      const existing = await CmsContent.findOne({
        type: "policy",
        slug: def.slug,
        locale: "en",
      }).select("_id status");

      if (existing) {
        console.log(
          `   ⏭️  /${def.slug} already exists (status: ${existing.status}) — skipping`
        );
        skipped++;
        continue;
      }

      await CmsContent.create({
        type: "policy",
        title: def.title,
        slug: def.slug,
        locale: "en",
        body: def.body,
        excerpt: def.excerpt,
        status: "published",
        author: admin._id,
        publishedAt: new Date(),
        seo: def.seo,
        tags: [],
        relatedContent: [],
        relatedServices: [],
      });
      console.log(`   ✅ Created and published /${def.slug}`);
      created++;
    }

    console.log("");
    console.log(`🎉 Done. Created: ${created}, Skipped: ${skipped}`);
    console.log("");
    console.log("📝 You can edit these anytime at /admin/cms → Policies tab.");

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding CMS defaults:", error);
    process.exit(1);
  }
};

if (require.main === module) {
  seedCmsDefaults();
}

export default seedCmsDefaults;
