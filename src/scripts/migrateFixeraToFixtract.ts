/**
 * One-time migration after rebranding fixera → fixtract.
 *
 * Renames MongoDB fields that were renamed in code:
 *   - projects.renovationPlanning.fixeraManaged → fixtractManaged
 *   - bookings.payment.fxProvider "fixera" → "fixtract"
 *   - platform settings company name defaults
 *   - backlink config production domain seeds
 *
 * Usage:
 *   npx tsx src/scripts/migrateFixeraToFixtract.ts --dry-run
 *   npx tsx src/scripts/migrateFixeraToFixtract.ts
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const DRY_RUN = process.argv.includes("--dry-run");

const DOMAIN_REPLACEMENTS: Record<string, string> = {
  "fixera-rho.vercel.app": "fixtract-rho.vercel.app",
  "www.fixera-rho.vercel.app": "www.fixtract-rho.vercel.app",
  "fixera.com": "fixtract.com",
  "www.fixera.com": "www.fixtract.com",
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

async function migrate() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("MONGODB_URI not set");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log(`Connected. Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

  const projectsModified = await runUpdate(
    "projects.renovationPlanning.fixeraManaged",
    "projects",
    { "renovationPlanning.fixeraManaged": { $exists: true } },
    [
      {
        $set: {
          "renovationPlanning.fixtractManaged": "$renovationPlanning.fixeraManaged",
        },
      },
      { $unset: "renovationPlanning.fixeraManaged" },
    ]
  );
  console.log(`  → modified ${projectsModified}\n`);

  const bookingsModified = await runUpdate(
    "bookings.payment.fxProvider",
    "bookings",
    { "payment.fxProvider": "fixera" },
    { $set: { "payment.fxProvider": "fixtract" } }
  );
  console.log(`  → modified ${bookingsModified}\n`);

  const platformNameModified = await runUpdate(
    "platformsettings.name",
    "platformsettings",
    { name: "Fixera" },
    { $set: { name: "Fixtract" } }
  );
  console.log(`  → modified ${platformNameModified}\n`);

  const platformCompanyModified = await runUpdate(
    "platformsettings.companyAddress.name",
    "platformsettings",
    { "companyAddress.name": "Fixera" },
    { $set: { "companyAddress.name": "Fixtract" } }
  );
  console.log(`  → modified ${platformCompanyModified}\n`);

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

  console.log(DRY_RUN ? "Dry run complete." : "Migration complete.");
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
