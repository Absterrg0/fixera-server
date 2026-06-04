import Booking from '../models/booking';
import { SYSTEM_USER_ID } from '../constants/system';
import { getWorkingDaysBetween } from './workingDays';
import {
  sendRfqDeadlineReminderEmail,
  sendRfqDeadlineExpiredEmail,
} from './emailService';
import { getProfessionalDisplayName } from './displayName';

export const runRfqDeadlineCheck = async () => {
  const now = new Date();
  let cancelled = 0;
  let remindersSent = 0;
  let expiredQuotationsFound = 0;
  const errors: string[] = [];

  console.log(`[RFQ Check] ⏳ Running checks at ${now.toISOString()}`);

  try {
    const expiredBookings = await Booking.find({
      status: 'rfq_accepted',
      rfqDeadline: { $exists: true, $lte: now },
    }).populate('customer', 'name email').populate('professional', 'name email businessInfo username');

    console.log(`[RFQ Check] Found ${expiredBookings.length} expired RFQ booking(s) to cancel`);

    for (const booking of expiredBookings) {
      try {
        console.log(`[RFQ Check] Cancelling booking ${(booking as any).bookingNumber || booking._id} (deadline: ${booking.rfqDeadline})`);
        booking.status = 'cancelled';
        booking.statusHistory.push({
          status: 'cancelled',
          timestamp: now,
          updatedBy: SYSTEM_USER_ID,
          note: 'Auto-cancelled: RFQ deadline expired without quotation submission',
        });
        await booking.save();

        const customer = booking.customer as any;
        const professional = booking.professional as any;

        if (professional?.email && customer?.email) {
          await sendRfqDeadlineExpiredEmail(
            professional.email,
            getProfessionalDisplayName(professional),
            customer.email,
            customer.name,
            booking._id.toString()
          );
          console.log(`[RFQ Check] ✅ Cancelled & emailed for booking ${(booking as any).bookingNumber || booking._id}`);
        } else {
          console.log(`[RFQ Check] ✅ Cancelled booking ${(booking as any).bookingNumber || booking._id} (no email — missing addresses)`);
        }
        cancelled++;
      } catch (e) {
        const msg = `Failed to process expired booking ${String(booking._id)}`;
        console.error(`[RFQ Check] ❌ ${msg}:`, e);
        errors.push(msg);
      }
    }

    const reminderBookings = await Booking.find({
      status: 'rfq_accepted',
      rfqDeadline: { $exists: true, $gt: now },
    }).populate('professional', 'name email businessInfo username');

    console.log(`[RFQ Check] Found ${reminderBookings.length} active RFQ booking(s) to check for reminders`);

    for (const booking of reminderBookings) {
      try {
        const lastReminderOrAcceptance = booking.lastReminderSentAt || booking.rfqResponse?.respondedAt;
        if (!lastReminderOrAcceptance) {
          console.log(`[RFQ Check] Skipping booking ${(booking as any).bookingNumber || booking._id} — no respondedAt date`);
          continue;
        }

        const workingDaysSince = getWorkingDaysBetween(lastReminderOrAcceptance, now);
        console.log(`[RFQ Check] Booking ${(booking as any).bookingNumber || booking._id}: ${workingDaysSince} working days since last action (need ≥2)`);

        if (workingDaysSince >= 2) {
          const professional = booking.professional as any;
          const daysRemaining = getWorkingDaysBetween(now, booking.rfqDeadline!);

          if (professional?.email) {
            const sent = await sendRfqDeadlineReminderEmail(
              professional.email,
              getProfessionalDisplayName(professional),
              daysRemaining,
              booking._id.toString()
            );

            if (sent) {
              booking.rfqRemindersSent = (booking.rfqRemindersSent || 0) + 1;
              booking.lastReminderSentAt = now;
              await booking.save();
              remindersSent++;
              console.log(`[RFQ Check] ✅ Reminder sent to ${professional.email} for booking ${(booking as any).bookingNumber || booking._id} (${daysRemaining} days remaining)`);
            }
          }
        }
      } catch (e) {
        const msg = `Failed to process reminder for booking ${String(booking._id)}`;
        console.error(`[RFQ Check] ❌ ${msg}:`, e);
        errors.push(msg);
      }
    }

    const expiredQuotations = await Booking.find({
      status: 'quoted',
      'quoteVersions.0': { $exists: true },
    });

    console.log(`[RFQ Check] Found ${expiredQuotations.length} quoted booking(s) to check validity`);

    for (const booking of expiredQuotations) {
      try {
        if (!booking.quoteVersions || booking.quoteVersions.length === 0) continue;
        const currentVersion = booking.quoteVersions.find(v => v.version === booking.currentQuoteVersion);
        if (!currentVersion) continue;

        if (currentVersion.validUntil && new Date(currentVersion.validUntil) < now) {
          expiredQuotationsFound++;
          console.log(`[RFQ Check] ⚠️ Expired quotation: ${(booking as any).quotationNumber || booking._id} (valid until: ${currentVersion.validUntil})`);
        }
      } catch (e) {
        const msg = `Failed to check quotation validity for ${String(booking._id)}`;
        console.error(`[RFQ Check] ❌ ${msg}:`, e);
        errors.push(msg);
      }
    }
  } catch (error) {
    console.error('[RFQ Deadline Check] Job failed:', error);
    errors.push('Job failed unexpectedly');
  }

  console.log(`[RFQ Check] ✅ Done — cancelled: ${cancelled}, reminders: ${remindersSent}, expired quotations: ${expiredQuotationsFound}, errors: ${errors.length}`);
  return { cancelled, remindersSent, expiredQuotationsFound, errors };
};
