import Booking from "../models/booking";
import { sendDisputeSlaBreachedEmail } from "./emailService";

export interface DisputeSlaCheckResult {
  scanned: number;
  notified: number;
  errors: number;
}

/**
 * Scans for disputes that have breached the SLA and notifies admin once per dispute.
 * Invoked on demand via the admin endpoint (no background scheduler).
 */
export const runDisputeSlaCheck = async (): Promise<DisputeSlaCheckResult> => {
  const now = new Date();
  const stats: DisputeSlaCheckResult = { scanned: 0, notified: 0, errors: 0 };

  const breached = await Booking.find({
    status: "dispute",
    "dispute.resolvedAt": { $exists: false },
    "dispute.slaDeadline": { $lte: now },
    "dispute.slaBreachNotifiedAt": null,
  })
    .select("_id dispute")
    .lean();

  stats.scanned = breached.length;

  for (const booking of breached) {
    try {
      const raisedAt: Date = (booking as any).dispute?.raisedAt;
      const slaDeadline: Date = (booking as any).dispute?.slaDeadline;
      if (!raisedAt || !slaDeadline) continue;
      const hoursOverdue = Math.max(0, (now.getTime() - slaDeadline.getTime()) / (1000 * 60 * 60));

      const sent = await sendDisputeSlaBreachedEmail({
        bookingId: String(booking._id),
        raisedAt,
        hoursOverdue,
      });

      if (sent) {
        await Booking.updateOne(
          { _id: booking._id },
          { $set: { "dispute.slaBreachNotifiedAt": new Date() } }
        );
        stats.notified++;
      }
    } catch (error: any) {
      console.error(`[disputeSla] Failed to notify for booking ${booking._id}:`, error?.message || error);
      stats.errors++;
    }
  }

  return stats;
};
