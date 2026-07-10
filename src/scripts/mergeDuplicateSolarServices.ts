import mongoose from "mongoose";
import { config } from "dotenv";
import ServiceConfiguration from "../models/serviceConfiguration";
import ServiceCategory from "../models/serviceCategory";
import Project from "../models/project";

config();

const DUPLICATE_NAMES = [
  "Solar PV & Battery Storage",
  "Solar panel & battery",
];

const CANONICAL_NAME = "Solar PV & Battery Storage";

async function mergeDuplicateSolarServices() {
  const mongoURI = process.env.MONGODB_URI || "mongodb://localhost:27017/fixera";
  await mongoose.connect(mongoURI);

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // 1) Normalize ServiceConfiguration entries (service field)
    const scRes = await ServiceConfiguration.updateMany(
      { service: "Solar panel & battery" },
      { $set: { service: CANONICAL_NAME } },
      { session }
    );

    // 2) Update Project documents
    //    - primary service
    const projPrimaryRes = await Project.updateMany(
      { service: "Solar panel & battery" },
      { $set: { service: CANONICAL_NAME } },
      { session }
    );

    //    - services[] embedded selections
    const projServicesArrayRes = await Project.updateMany(
      { "services.service": { $in: DUPLICATE_NAMES } },
      { $set: { "services.$[elem].service": CANONICAL_NAME } },
      {
        arrayFilters: [{ "elem.service": { $in: DUPLICATE_NAMES } }],
        session,
      }
    );

    // 3) Deduplicate ServiceConfiguration docs that are now identical by (category, service, areaOfWork)
    const normalizedConfigs = await ServiceConfiguration.find(
      { service: CANONICAL_NAME },
      undefined,
      { session }
    );

    type Key = string;
    const byKey = new Map<Key, any[]>();
    for (const doc of normalizedConfigs) {
      const key = `${doc.category}||${doc.areaOfWork || ""}`;
      const arr = byKey.get(key) || [];
      arr.push(doc);
      byKey.set(key, arr);
    }

    let duplicateConfigsRemoved = 0;
    let projectConfigRefsUpdated = 0;

    for (const [, docs] of byKey) {
      if (docs.length <= 1) continue;
      // Choose the earliest created as keeper
      docs.sort((a, b) => {
        const aTime = (a.createdAt ? new Date(a.createdAt) : a._id.getTimestamp()).getTime();
        const bTime = (b.createdAt ? new Date(b.createdAt) : b._id.getTimestamp()).getTime();
        return aTime - bTime;
      });
      const keeper = docs[0];
      const duplicates = docs.slice(1);

      const dupIds = duplicates.map((d) => d._id.toString());
      const keeperId = keeper._id.toString();

      // Update Project.serviceConfigurationId references
      const updRes = await Project.updateMany(
        { serviceConfigurationId: { $in: dupIds } },
        { $set: { serviceConfigurationId: keeperId } },
        { session }
      );
      projectConfigRefsUpdated += updRes.modifiedCount || 0;

      // Remove duplicate configs
      const delRes = await ServiceConfiguration.deleteMany(
        { _id: { $in: dupIds } },
        { session } as any
      );
      duplicateConfigsRemoved += (delRes as any).deletedCount || 0;
    }

    // 4) Update ServiceCategory embedded services (name + slug)
    //    Find all categories that contain either duplicate
    const affectedCategories = await ServiceCategory.find(
      { "services.name": { $in: DUPLICATE_NAMES } },
      undefined,
      { session }
    );

    for (const category of affectedCategories) {
      // Normalize any duplicate service name to canonical
      for (const svc of category.services as any[]) {
        if (DUPLICATE_NAMES.includes(svc.name) && svc.name !== CANONICAL_NAME) {
          svc.name = CANONICAL_NAME;
          // Keep existing slug or unify? Prefer stable canonical slug
          svc.slug = "solar-pv-battery-storage";
        }
      }
      // Deduplicate entries with same name after normalization
      const seen = new Set<string>();
      category.services = (category.services as any[]).filter((svc: any) => {
        if (seen.has(svc.name)) return false;
        seen.add(svc.name);
        return true;
      });

      await category.save({ session });
    }

    await session.commitTransaction();

    console.log("✅ Merge complete");
    console.log(
      `ServiceConfiguration updated: ${scRes.modifiedCount}, Projects (primary) updated: ${projPrimaryRes.modifiedCount}, Projects (services[]) updated: ${projServicesArrayRes.modifiedCount}`
    );
    console.log(
      `ServiceConfiguration duplicates removed: ${duplicateConfigsRemoved}, Project config refs updated: ${projectConfigRefsUpdated}`
    );
  } catch (err: any) {
    await session.abortTransaction();
    console.error("❌ Merge failed:", err.message);
    throw err;
  } finally {
    session.endSession();
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  mergeDuplicateSolarServices()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export default mergeDuplicateSolarServices;


