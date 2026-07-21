import type {
  ChannelTier,
  NotificationAudience,
  NotificationEntityType,
  PrefCategory,
} from './types';
import { getFrontendUrl } from '../frontendUrl';
import {
  sendRfqReceivedEmail,
  sendBookingStartedEmail,
  sendProfessionalCompletedEmail,
  sendProfessionalNewBookingEmail,
  sendRfqRejectedEmail,
  sendQuotationAcceptedEmail,
  sendQuotationRejectedEmail,
  sendNotificationEmail,
} from '../emailService';

export interface NotifyBuildResult {
  title: string;
  body: string;
  clickUrl: string;
  /** Optional transactional email; return true if sent/skipped successfully */
  sendEmail?: (args: {
    email: string;
    name: string;
    userId: string;
  }) => Promise<boolean>;
}

export interface NotifyContext {
  actorName?: string;
  previewText?: string;
  conversationId?: string;
  bookingId?: string;
  projectTitle?: string;
  customerName?: string;
  professionalName?: string;
  preferredDate?: string;
  amountLabel?: string;
  levelName?: string;
  extraCostTotal?: number;
  reason?: string;
  [key: string]: unknown;
}

export interface EventDef {
  eventKey: string;
  category: PrefCategory;
  tier: ChannelTier;
  audience: NotificationAudience;
  defaultEntityType?: NotificationEntityType;
  build: (ctx: NotifyContext) => NotifyBuildResult;
}

const frontend = (path: string) => `${getFrontendUrl()}${path.startsWith('/') ? path : `/${path}`}`;

const def = (
  eventKey: string,
  category: PrefCategory,
  tier: ChannelTier,
  audience: NotificationAudience,
  build: EventDef['build'],
  defaultEntityType?: NotificationEntityType,
): EventDef => {
  const wrappedBuild: EventDef['build'] = (ctx) => {
    const result = build(ctx);
    if (result.sendEmail) return result;
    // Every event gets a real email path so email_always / always_on (and
    // configurable-when-enabled) actually deliver mail, not only inbox/push.
    return {
      ...result,
      sendEmail: async ({ email, name }) =>
        sendNotificationEmail({
          to: email,
          userName: name || 'User',
          title: result.title,
          body: result.body,
          ctaUrl: result.clickUrl,
          template: eventKey.replace(/\./g, '_'),
          relatedBooking:
            typeof ctx.bookingId === 'string' && ctx.bookingId
              ? ctx.bookingId
              : undefined,
        }),
    };
  };

  return {
    eventKey,
    category,
    tier,
    audience,
    build: wrappedBuild,
    defaultEntityType,
  };
};

/** Registry of product notification events. Handlers must use keys from this map. */
export const NOTIFICATION_REGISTRY: Record<string, EventDef> = {
  // --- Phase 0 / chat ---
  'user.chat_message': def(
    'user.chat_message',
    'messages',
    'configurable',
    'either',
    (ctx) => ({
      title: `New message from ${ctx.actorName || 'Someone'}`,
      body: String(ctx.previewText || 'You have a new message'),
      clickUrl: frontend(`/chat?conversationId=${ctx.conversationId || ''}`),
    }),
    'conversation',
  ),

  // --- Customer ---
  'customer.rfq_rejected': def(
    'customer.rfq_rejected',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Request declined',
      body: ctx.professionalName
        ? `${ctx.professionalName} declined your request${ctx.reason ? `: ${ctx.reason}` : '.'}`
        : 'Your booking request was declined.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRfqRejectedEmail(
          email,
          name,
          String(ctx.professionalName || 'the professional'),
          String(ctx.reason || ''),
        ),
    }),
    'booking',
  ),
  'customer.unfinished_checkout': def(
    'customer.unfinished_checkout',
    'booking_updates',
    'configurable',
    'customer',
    (ctx) => ({
      title: 'Finish your booking',
      body: 'You still have an unfinished checkout. Complete payment to confirm your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}/payment`),
    }),
    'booking',
  ),
  'customer.reschedule_requested': def(
    'customer.reschedule_requested',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Reschedule requested',
      body: 'A reschedule has been requested for your booking. Please review and respond.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.reschedule_reminder': def(
    'customer.reschedule_reminder',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Reminder: reschedule pending',
      body: 'A reschedule request is still waiting for a response.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.refund_negotiation': def(
    'customer.refund_negotiation',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Refund negotiation started',
      body: 'A refund negotiation is in progress for your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.refund_negotiation_reminder': def(
    'customer.refund_negotiation_reminder',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Reminder: refund negotiation',
      body: 'A refund negotiation is still awaiting a response.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.booking_cancelled_refunded': def(
    'customer.booking_cancelled_refunded',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Booking cancelled & refunded',
      body: 'Your booking was cancelled and a refund has been processed.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.dispute_started': def(
    'customer.dispute_started',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Dispute started',
      body: 'A dispute has been opened on your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.dispute_resolved': def(
    'customer.dispute_resolved',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Dispute resolved',
      body: 'The dispute on your booking has been resolved.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.booking_started': def(
    'customer.booking_started',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Work has started',
      body: ctx.professionalName
        ? `${ctx.professionalName} has started work on your booking.`
        : 'Your professional has started work on your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendBookingStartedEmail(
          email,
          name,
          String(ctx.professionalName || 'Your professional'),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'customer.completion_requested': def(
    'customer.completion_requested',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Completion request',
      body:
        typeof ctx.extraCostTotal === 'number' && ctx.extraCostTotal > 0
          ? `Your professional marked the work complete and requested extra payment of ${ctx.amountLabel || ctx.extraCostTotal}. Please review.`
          : 'Your professional marked the work complete. Please confirm.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendProfessionalCompletedEmail(
          email,
          name,
          String(ctx.professionalName || 'Your professional'),
          typeof ctx.extraCostTotal === 'number' ? ctx.extraCostTotal : 0,
          String(ctx.bookingId || ''),
          String(ctx.currency || 'EUR'),
        ),
    }),
    'booking',
  ),
  'customer.completion_reminder': def(
    'customer.completion_reminder',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Reminder: confirm completion',
      body: 'Please confirm that the work on your booking is complete.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.completion_extra_payment_due': def(
    'customer.completion_extra_payment_due',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Extra payment due',
      body: 'Extra costs on your completion request still need payment.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.completion_auto_accepted': def(
    'customer.completion_auto_accepted',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Completion auto-accepted',
      body: 'Your booking was automatically marked complete after no response.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.review_request': def(
    'customer.review_request',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'How was your experience?',
      body: 'Your booking is complete. Leave a review to help others.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.review_reminder': def(
    'customer.review_reminder',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Reminder: leave a review',
      body: 'You still have not reviewed your completed booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.review_received': def(
    'customer.review_received',
    'promotions',
    'configurable',
    'customer',
    (ctx) => ({
      title: 'You received a new review',
      body: ctx.actorName
        ? `${ctx.actorName} left you a review.`
        : 'You received a new review.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'review',
  ),
  'customer.referral_completed': def(
    'customer.referral_completed',
    'promotions',
    'configurable',
    'customer',
    (ctx) => ({
      title: 'Referral reward unlocked',
      body: 'A referral was completed and your reward has been applied.',
      clickUrl: frontend('/dashboard/benefits'),
    }),
    'referral',
  ),
  'customer.loyalty_tier_up': def(
    'customer.loyalty_tier_up',
    'promotions',
    'configurable',
    'customer',
    (ctx) => ({
      title: 'Loyalty level up!',
      body: ctx.levelName
        ? `Congratulations — you reached ${ctx.levelName}.`
        : 'Congratulations — you reached a new loyalty tier.',
      clickUrl: frontend('/dashboard/benefits'),
    }),
    'user',
  ),
  'customer.unread_chat': def(
    'customer.unread_chat',
    'messages',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Unread messages',
      body: 'You have unread chat messages waiting for you.',
      clickUrl: frontend(`/chat?conversationId=${ctx.conversationId || ''}`),
    }),
    'conversation',
  ),

  // --- Professional ---
  'professional.project_published': def(
    'professional.project_published',
    'system',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Project published',
      body: ctx.projectTitle
        ? `"${ctx.projectTitle}" is now live.`
        : 'Your project has been published.',
      clickUrl: frontend('/professional/projects'),
    }),
    'project',
  ),
  'professional.project_rejected': def(
    'professional.project_rejected',
    'system',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Project rejected',
      body: ctx.projectTitle
        ? `"${ctx.projectTitle}" was rejected${ctx.reason ? `: ${ctx.reason}` : '.'}`
        : 'Your project was rejected.',
      clickUrl: frontend('/professional/projects'),
    }),
    'project',
  ),
  'professional.project_suspended': def(
    'professional.project_suspended',
    'system',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Project suspended',
      body: ctx.projectTitle
        ? `"${ctx.projectTitle}" has been suspended.`
        : 'One of your projects was suspended.',
      clickUrl: frontend('/professional/projects'),
    }),
    'project',
  ),
  'professional.rfq_received': def(
    'professional.rfq_received',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'New booking request',
      body: ctx.customerName
        ? `${ctx.customerName} sent you a new booking request.`
        : 'You received a new booking request.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRfqReceivedEmail(
          email,
          name,
          String(ctx.customerName || 'a customer'),
          String(ctx.projectTitle || ctx.serviceType || 'your service'),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.rfq_reminder': def(
    'professional.rfq_reminder',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Reminder: respond to request',
      body: 'A booking request is still waiting for your accept or reject.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.quote_rejected': def(
    'professional.quote_rejected',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Quote rejected',
      body: 'Your quotation was rejected by the customer.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendQuotationRejectedEmail(
          email,
          name,
          String(ctx.customerName || 'the customer'),
          String(ctx.quotationNumber || ''),
          String(ctx.reason || ''),
        ),
    }),
    'booking',
  ),
  'professional.quote_accepted': def(
    'professional.quote_accepted',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Quote accepted',
      body: 'Your quotation was accepted. The customer can proceed to payment.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendQuotationAcceptedEmail(
          email,
          name,
          String(ctx.customerName || 'the customer'),
          String(ctx.quotationNumber || ''),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.booking_created': def(
    'professional.booking_created',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'New booking',
      body: ctx.customerName
        ? `${ctx.customerName} confirmed a booking with you.`
        : 'You have a new confirmed booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendProfessionalNewBookingEmail(
          email,
          name,
          String(ctx.customerName || 'A customer'),
          String(ctx.bookingId || ''),
          typeof ctx.amount === 'number' ? ctx.amount : undefined,
          String(ctx.currency || 'EUR'),
        ),
    }),
    'booking',
  ),
  'professional.booking_not_started_reminder': def(
    'professional.booking_not_started_reminder',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Start or reschedule booking',
      body: 'A booking start date has arrived but work has not started yet.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.reschedule_accepted': def(
    'professional.reschedule_accepted',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Reschedule accepted',
      body: 'A reschedule request was accepted for your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.reschedule_requested': def(
    'professional.reschedule_requested',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Reschedule requested',
      body: 'A customer requested to reschedule a booking. Please review.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.refund_request': def(
    'professional.refund_request',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Refund request received',
      body: 'A customer requested a refund / cancellation. Please respond.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.refund_request_reminder': def(
    'professional.refund_request_reminder',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Reminder: refund request',
      body: 'A refund request is still awaiting your response.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.booking_cancelled_refunded': def(
    'professional.booking_cancelled_refunded',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Booking cancelled & refunded',
      body: 'A booking was cancelled and refunded.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.dispute_started': def(
    'professional.dispute_started',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Dispute started',
      body: 'A dispute has been opened on one of your bookings.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.dispute_resolved': def(
    'professional.dispute_resolved',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Dispute resolved',
      body: 'A dispute on your booking has been resolved.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.review_request': def(
    'professional.review_request',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Leave a review',
      body: 'A booking is complete. Leave a review for the customer.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.review_reminder': def(
    'professional.review_reminder',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Reminder: leave a review',
      body: 'You still have not reviewed a completed booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.review_received': def(
    'professional.review_received',
    'promotions',
    'configurable',
    'professional',
    (ctx) => ({
      title: 'You received a new review',
      body: ctx.actorName
        ? `${ctx.actorName} left you a review.`
        : 'You received a new review.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'review',
  ),
  'professional.referral_rewarded': def(
    'professional.referral_rewarded',
    'promotions',
    'configurable',
    'professional',
    (ctx) => ({
      title: 'Referral reward unlocked',
      body: 'A referral was completed and your reward has been applied.',
      clickUrl: frontend('/dashboard/benefits'),
    }),
    'referral',
  ),
  'professional.leveling_up': def(
    'professional.leveling_up',
    'promotions',
    'configurable',
    'professional',
    (ctx) => ({
      title: 'Level up!',
      body: ctx.levelName
        ? `Congratulations — you reached ${ctx.levelName}.`
        : 'Congratulations — you reached a new professional level.',
      clickUrl: frontend('/dashboard/benefits'),
    }),
    'user',
  ),
  'professional.id_expiring': def(
    'professional.id_expiring',
    'system',
    'always_on',
    'professional',
    () => ({
      title: 'ID document expiring soon',
      body: 'Your ID document expires within 30 days. Please renew it.',
      clickUrl: frontend('/profile'),
    }),
    'user',
  ),
  'professional.id_expiry_reminder': def(
    'professional.id_expiry_reminder',
    'system',
    'always_on',
    'professional',
    () => ({
      title: 'Reminder: renew your ID',
      body: 'Your ID document is still expired or expiring. Please renew it.',
      clickUrl: frontend('/profile'),
    }),
    'user',
  ),
  'professional.unread_chat': def(
    'professional.unread_chat',
    'messages',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Unread messages',
      body: 'You have unread chat messages waiting for you.',
      clickUrl: frontend(`/chat?conversationId=${ctx.conversationId || ''}`),
    }),
    'conversation',
  ),
  'professional.completion_auto_accepted': def(
    'professional.completion_auto_accepted',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Completion auto-accepted',
      body: 'A customer completion request was automatically accepted after no response.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
};

export function getEventDef(eventKey: string): EventDef | undefined {
  return NOTIFICATION_REGISTRY[eventKey];
}

export function listRegistryEventKeys(): string[] {
  return Object.keys(NOTIFICATION_REGISTRY);
}
