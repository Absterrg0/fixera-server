/**
 * Reverses migrateFixeraToFixtract.ts (schema / internal fields only by default).
 *
 * Default rollback:
 *   - projects.renovationPlanning.fixtractManaged → fixeraManaged
 *   - bookings.payment.fxProvider "fixtract" → "fixera"
 *   - backlinkconfigs allowedTargetDomains (fixtract domains → fixera domains)
 *
 * Platform settings (company name "Fixtract") are kept unless --revert-platform-branding
 * is passed — those are user-facing and safe to leave as Fixtract.
 *
 * Usage:
 *   npx tsx src/scripts/rollbackFixtractToFixera.ts --dry-run
 *   npx tsx src/scripts/rollbackFixtractToFixera.ts
 *   npx tsx src/scripts/rollbackFixtractToFixera.ts --revert-platform-branding
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const DRY_RUN = process.argv.includes("--dry-run");
const REVERT_PLATFORM_BRANDING = process.argv.includes("--revert-platform-branding");

/** Inverse of migrateFixeraToFixtract DOMAIN_REPLACEMENTS */
const DOMAIN_REPLACEMENTS: Record<string, string> = {
  "fixtract-rho.vercel.app": "fixera-rho.vercel.app",
  "www.fixtract-rho.vercel.app": "www.fixera-rho.vercel.app",
  "fixtract.com": "fixera.com",
  "www.fixtract.com": "www.fixera.com",
};

async function runUpdate(
  label: string,
  collection: string,
  filter: Record<string, unknown>,
  update: Record<string, unknown> | mongoose.mongo.Document[]
): Promise<number> {
  const col = mongoose.connection.collection(collection);
  const count = await col.countDocuments(filter);
  console.log(`[${label}] ${count} document(s) matched in ${collection}`);

  if (count === 0 || DRY_RUN) {
    return count;
  }

  if (Array.isArray(update)) {
    const result = await col.updateMany(filter, update);
    return result.modifiedCount;
  }

  const result = await col.updateMany(filter, update);
  return result.modifiedCount;
}

async function rollback() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("MONGODB_URI not set");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log(`Connected to ${mongoUri.replace(/\/\/[^@]+@/, "//***@")}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(
    `Platform branding: ${REVERT_PLATFORM_BRANDING ? "will revert to Fixera" : "keeping Fixtract (user-facing)"}\n`
  );

  const projectsModified = await runUpdate(
    "projects.renovationPlanning.fixtractManaged → fixeraManaged",
    "projects",
    { "renovationPlanning.fixtractManaged": { $exists: true } },
    [
      {
        $set: {
          "renovationPlanning.fixeraManaged": "$renovationPlanning.fixtractManaged",
        },
      },
      { $unset: "renovationPlanning.fixtractManaged" },
    ]
  );
  console.log(`  → modified ${projectsModified}\n`);

  const bookingsModified = await runUpdate(
    "bookings.payment.fxProvider fixtract → fixera",
    "bookings",
    { "payment.fxProvider": "fixtract" },
    { $set: { "payment.fxProvider": "fixera" } }
  );
  console.log(`  → modified ${bookingsModified}\n`);

  if (REVERT_PLATFORM_BRANDING) {
    const platformNameModified = await runUpdate(
      "platformsettings.name Fixtract → Fixera",
      "platformsettings",
      { name: "Fixtract" },
      { $set: { name: "Fixera" } }
    );
    console.log(`  → modified ${platformNameModified}\n`);

    const platformCompanyModified = await runUpdate(
      "platformsettings.companyAddress.name Fixtract → Fixera",
      "platformsettings",
      { "companyAddress.name": "Fixtract" },
      { $set: { "companyAddress.name": "Fixera" } }
    );
    console.log(`  → modified ${platformCompanyModified}\n`);
  } else {
    console.log("[platformsettings] skipped — use --revert-platform-branding to undo\n");
  }

  const backlinkCol = mongoose.connection.collection("backlinkconfigs");
  const backlinkConfigs = await backlinkCol.find({}).toArray();
  let backlinkDomainsUpdated = 0;

  for (const doc of backlinkConfigs) {
    const domains: string[] = Array.isArray(doc.allowedTargetDomains)
      ? doc.allowedTargetDomains
      : [];
    const updated = domains.map(
      (d: string) => DOMAIN_REPLACEMENTS[d.toLowerCase()] ?? d
    );
    const changed = JSON.stringify(domains) !== JSON.stringify(updated);

    if (!changed) continue;

    console.log(
      `[backlinkconfigs] ${doc._id}: ${domains.join(", ")} → ${updated.join(", ")}`
    );

    if (!DRY_RUN) {
      await backlinkCol.updateOne(
        { _id: doc._id },
        { $set: { allowedTargetDomains: updated } }
      );
    }
    backlinkDomainsUpdated += 1;
  }
  console.log(`  → updated ${backlinkDomainsUpdated} backlink config(s)\n`);

  console.log(DRY_RUN ? "Dry run complete." : "Rollback complete.");
  await mongoose.disconnect();
}

rollback().catch((err) => {
  console.error(err);
  process.exit(1);
});
