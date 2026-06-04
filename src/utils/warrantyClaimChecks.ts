import WarrantyClaim from "../models/warrantyClaim";
import {
  autoCloseResolvedWarrantyClaim,
  autoEscalateWarrantyClaim,
} from "../handlers/WarrantyClaim";

export const runWarrantyClaimChecks = async () => {
  const now = new Date();
  let escalated = 0;
  let closed = 0;
  const errors: string[] = [];

  console.log(`[Warranty Check] ⏳ Running checks at ${now.toISOString()}`);

  const [staleOpenClaims, overdueResolvedClaims] = await Promise.all([
    WarrantyClaim.find({
      status: "open",
      "sla.professionalResponseDueAt": { $exists: true, $lte: now },
    }),
    WarrantyClaim.find({
      status: "resolved",
      "sla.customerConfirmationDueAt": { $exists: true, $lte: now },
    }),
  ]);

  console.log(`[Warranty Check] Found ${staleOpenClaims.length} stale open claim(s) to escalate`);
  console.log(`[Warranty Check] Found ${overdueResolvedClaims.length} overdue resolved claim(s) to auto-close`);

  for (const claim of staleOpenClaims) {
    try {
      console.log(`[Warranty Check] Escalating claim ${(claim as any).claimNumber || claim._id} (professional response due: ${(claim as any).sla?.professionalResponseDueAt})`);
      await autoEscalateWarrantyClaim(claim);
      escalated++;
      console.log(`[Warranty Check] ✅ Escalated claim ${(claim as any).claimNumber || claim._id}`);
    } catch (error) {
      const msg = `Failed to auto-escalate claim ${claim._id}`;
      console.error(`[Warranty Check] ❌ ${msg}:`, error);
      errors.push(msg);
    }
  }

  for (const claim of overdueResolvedClaims) {
    try {
      console.log(`[Warranty Check] Auto-closing claim ${(claim as any).claimNumber || claim._id} (customer confirmation due: ${(claim as any).sla?.customerConfirmationDueAt})`);
      await autoCloseResolvedWarrantyClaim(claim);
      closed++;
      console.log(`[Warranty Check] ✅ Auto-closed claim ${(claim as any).claimNumber || claim._id}`);
    } catch (error) {
      const msg = `Failed to auto-close claim ${claim._id}`;
      console.error(`[Warranty Check] ❌ ${msg}:`, error);
      errors.push(msg);
    }
  }

  console.log(`[Warranty Check] ✅ Done — escalated: ${escalated}, closed: ${closed}, errors: ${errors.length}`);
  return { escalated, closed, errors };
};
