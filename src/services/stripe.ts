/**
 * Stripe Service - Central Stripe SDK initialization
 * Version: 2.1
 */

import Stripe from "stripe";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
  throw new Error("STRIPE_SECRET_KEY not configured");
}

// Initialize Stripe with a pinned, supported API version.
export const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2026-01-28.clover",
  typescript: true,
  appInfo: {
    name: "Fixera Platform",
    version: "2.1.0",
    url: "https://fixera.com",
  },
});

const parsedCommissionPercent = Number.parseFloat(
  process.env.STRIPE_PLATFORM_COMMISSION_PERCENT || "0"
);
const safeCommissionPercent = Number.isFinite(parsedCommissionPercent)
  ? parsedCommissionPercent
  : 0;

// Stripe configuration constants
export const STRIPE_CONFIG = {
  // Payment settings
  defaultCurrency: (process.env.STRIPE_DEFAULT_CURRENCY || "EUR").toUpperCase(),
  supportedCurrencies: (process.env.STRIPE_SUPPORTED_CURRENCIES || "EUR,USD,GBP,CAD,AUD")
    .split(",")
    .map((c) => c.trim().toUpperCase()),

  // Commission settings
  commissionPercent: safeCommissionPercent,

  // Frontend URL for redirects
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",

  // Webhook secret
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",

  // Environment
  isProduction: process.env.NODE_ENV === "production",
  environment: process.env.NODE_ENV === "production" ? "production" : "test",
};

// Log Stripe configuration on startup (without sensitive data)
console.log("Stripe Service initialized:");
console.log(`   - Environment: ${STRIPE_CONFIG.environment}`);
console.log(`   - Default Currency: ${STRIPE_CONFIG.defaultCurrency}`);
console.log(`   - Supported Currencies: ${STRIPE_CONFIG.supportedCurrencies.join(", ")}`);
console.log(`   - Platform Commission: ${STRIPE_CONFIG.commissionPercent}%`);
console.log(`   - API Key: ${process.env.STRIPE_SECRET_KEY ? "Configured" : "Missing"}`);
console.log(
  `   - Webhook Secret: ${
    STRIPE_CONFIG.webhookSecret ? "Configured" : "Not configured (webhooks will fail)"
  }`
);

// Export default for convenience
export default stripe;
