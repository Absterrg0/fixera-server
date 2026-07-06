/**
 * fixInvoiceSequenceIndexes
 * -------------------------
 * One-time migration (safe to re-run): drops the legacy unique index on `year`
 * alone so the compound { year, kind } index can take effect for separate
 * invoice and credit-note counters.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import InvoiceSequence from "../models/invoiceSequence";

dotenv.config();

const LEGACY_INDEX_NAME = "year_1";

async function fixInvoiceSequenceIndexes() {
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

  const collection = db.collection("invoicesequences");
  const indexes = await collection.indexes();
  console.log("Existing invoice sequence indexes:");
  indexes.forEach((idx) => {
    console.log(`  ${idx.name}: keys=${JSON.stringify(idx.key)} unique=${Boolean((idx as any).unique)}`);
  });

  const stale = indexes.find(
    (idx) =>
      JSON.stringify(idx.key) === JSON.stringify({ year: 1 }) &&
      (idx as any).unique === true
  );

  if (stale?.name) {
    console.log(`Dropping legacy unique index "${stale.name}"...`);
    await collection.dropIndex(stale.name);
    console.log("Dropped.");
  } else {
    console.log("No legacy unique year-only index found — nothing to drop.");
  }

  console.log("Ensuring schema indexes exist...");
  await InvoiceSequence.createIndexes();
  console.log("Schema indexes ensured.");

  const after = await collection.indexes();
  console.log("Invoice sequence indexes after fix:");
  after.forEach((idx) => {
    console.log(`  ${idx.name}: keys=${JSON.stringify(idx.key)} unique=${Boolean((idx as any).unique)}`);
  });

  await mongoose.disconnect();
  console.log("Done.");
}

fixInvoiceSequenceIndexes().catch((err) => {
  console.error("fixInvoiceSequenceIndexes failed:", err);
  process.exit(1);
});
