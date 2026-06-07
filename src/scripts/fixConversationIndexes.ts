/**
 * fixConversationIndexes
 * ----------------------
 * WHY THIS SCRIPT EXISTS (one-time DB migration, safe to re-run):
 *
 * The Conversation model declares the uniqueness constraint on
 * { customerId, professionalId } as a PARTIAL index scoped to `type: "direct"`
 * (see models/conversation.ts). Support conversations intentionally leave
 * customerId/professionalId unset, so the partial filter excludes them and they
 * never collide.
 *
 * However, an OLDER deployment created that same index WITHOUT the partial
 * filter (i.e. unique across ALL conversation types). Mongoose never drops or
 * replaces an existing index whose options changed — it only creates missing
 * ones — so on databases provisioned before the partial filter was added the
 * stale NON-partial `customerId_1_professionalId_1` index is still in place.
 *
 * Consequence: every support conversation stores customerId = professionalId =
 * null. Under the stale non-partial unique index the FIRST support chat takes
 * the (null, null) slot and EVERY subsequent support chat creation fails with a
 * duplicate-key error (E11000) — surfaced in the app as
 * "Failed to create support conversation". This is order-dependent (not
 * role-specific): the first support chat ever created works, all later ones
 * fail regardless of customer/professional.
 *
 * This cannot be fixed from application code alone because the bad index lives
 * in the database, and Mongoose will not auto-drop it. This script drops the
 * stale non-partial index so the correct partial index can be (re)created.
 *
 * Run once per affected environment:
 *   npm run migrate:fix-conversation-indexes
 * Idempotent: re-running when no stale index exists is a no-op.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import Conversation from "../models/conversation";

dotenv.config();

const LEGACY_INDEX_NAME = "customerId_1_professionalId_1";

async function fixConversationIndexes() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI or MONGODB_URI not found in environment variables");
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("MongoDB connection is missing database handle");
  }

  const collection = db.collection("conversations");
  const indexes = await collection.indexes();
  console.log("Existing conversation indexes:");
  indexes.forEach((idx) => {
    console.log(`  ${idx.name}: keys=${JSON.stringify(idx.key)} partial=${JSON.stringify((idx as any).partialFilterExpression || null)}`);
  });

  const stale = indexes.find(
    (idx) =>
      JSON.stringify(idx.key) === JSON.stringify({ customerId: 1, professionalId: 1 }) &&
      !(idx as any).partialFilterExpression
  );

  if (stale?.name) {
    console.log(`Dropping stale NON-partial unique index "${stale.name}" (collides on null support conversations)...`);
    await collection.dropIndex(stale.name);
    console.log("Dropped.");
  } else {
    const named = indexes.find((idx) => idx.name === LEGACY_INDEX_NAME);
    if (named && (named as any).partialFilterExpression) {
      console.log(`Index "${LEGACY_INDEX_NAME}" already has a partialFilterExpression — nothing to fix.`);
    } else {
      console.log("No stale non-partial customerId/professionalId index found — nothing to drop.");
    }
  }

  // Re-create any missing schema indexes (the correct partial one) WITHOUT
  // dropping other existing indexes.
  console.log("Ensuring schema indexes exist...");
  await Conversation.createIndexes();
  console.log("Schema indexes ensured.");

  const after = await collection.indexes();
  console.log("Conversation indexes after fix:");
  after.forEach((idx) => {
    console.log(`  ${idx.name}: keys=${JSON.stringify(idx.key)} partial=${JSON.stringify((idx as any).partialFilterExpression || null)}`);
  });

  await mongoose.disconnect();
  console.log("Done.");
}

fixConversationIndexes().catch((err) => {
  console.error("fixConversationIndexes failed:", err);
  process.exit(1);
});
