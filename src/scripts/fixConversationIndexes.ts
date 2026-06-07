import dotenv from "dotenv";
import mongoose from "mongoose";
import Conversation from "../models/conversation";

dotenv.config();

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

  const legacy = indexes.find(
    (idx) =>
      JSON.stringify(idx.key) === JSON.stringify({ customerId: 1, professionalId: 1 }) &&
      !(idx as any).partialFilterExpression
  );

  if (legacy?.name) {
    console.log(`Dropping legacy non-partial index "${legacy.name}" that collides on null support conversations...`);
    await collection.dropIndex(legacy.name);
    console.log("Dropped.");
  } else {
    console.log("No legacy non-partial customerId/professionalId unique index found.");
  }

  console.log("Syncing Conversation indexes from schema...");
  await Conversation.syncIndexes();
  console.log("Indexes synced.");

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
