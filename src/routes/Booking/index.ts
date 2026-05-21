import express from 'express';
import {
  createBooking,
  getMyBookings,
  getMyPayments,
  getMyDisputes,
  getBookingById,
  submitPostBookingAnswers,
  submitQuote,
  updateBookingStatus,
  cancelBooking,
  uploadRFQAttachment,
} from '../../handlers/Booking';
import {
  respondToQuoteWithPayment,
  ensurePaymentIntent,
  updateBookingStatusWithPayment,
  setBookingSchedule,
  requestBookingReschedule,
  respondToBookingReschedule,
  extendBookingExecution,
} from '../../handlers/Booking/payment-integration';
import { getDiscountPreview } from '../../handlers/Booking/discountPreview';
import { submitCustomerReview, submitProfessionalReview, replyToCustomerReview } from '../../handlers/Booking/reviews';
import {
  professionalCompleteBooking,
  customerConfirmCompletion,
  createExtraCostPaymentIntent,
  customerDisputeExtraCosts,
  uploadDisputeAttachments,
} from '../../handlers/Booking/completion';
import { protect } from '../../middlewares/auth';
import { upload, rfqUpload, uploadReviewImages } from '../../utils/s3Upload';

const router = express.Router();

// All routes require authentication
router.use(protect);

// Create booking (RFQ submission) - Customer only
router.post('/create', createBooking);

// Upload RFQ attachment (10MB limit)
router.post('/rfq-upload', rfqUpload.single('file'), uploadRFQAttachment);

// Get all bookings for current user
router.get('/my-bookings', getMyBookings);

// Get payment history for current customer
router.get('/my-payments', getMyPayments);

// Get disputes for the current user (customer or professional party)
router.get('/disputes/mine', getMyDisputes);

// Get single booking by ID
router.get('/:bookingId', getBookingById);

// Submit post-booking answers (Customer only)
router.post('/:bookingId/post-booking-answers', submitPostBookingAnswers);

// Submit quote - Professional only
router.post('/:bookingId/quote', submitQuote);

// Discount preview - Customer only (before accepting quote)
router.get('/:bookingId/discount-preview', getDiscountPreview);

// Respond to quote (accept/reject) - Customer only - WITH PAYMENT INTEGRATION
router.post('/:bookingId/respond', respondToQuoteWithPayment);
router.post('/:bookingId/payment-intent', ensurePaymentIntent);
router.post('/:bookingId/schedule', setBookingSchedule);
router.post('/:bookingId/reschedule-request', requestBookingReschedule);
router.post('/:bookingId/respond-reschedule', respondToBookingReschedule);
router.post('/:bookingId/extend-execution', extendBookingExecution);

// Update booking status (with automatic payment transfer on completion)
router.put('/:bookingId/status', updateBookingStatusWithPayment);

// Completion flow
router.post('/:bookingId/professional-complete', upload.array('attachments', 10), professionalCompleteBooking);
router.post('/:bookingId/customer-confirm-completion', customerConfirmCompletion);
router.post('/:bookingId/extra-cost-payment-intent', createExtraCostPaymentIntent);
router.post('/:bookingId/dispute-extra-costs', customerDisputeExtraCosts);
router.post('/:bookingId/dispute-upload', upload.array('files', 10), uploadDisputeAttachments);

// Cancel booking
router.post('/:bookingId/cancel', cancelBooking);

// Reviews
router.post('/:bookingId/customer-review', uploadReviewImages.array('images', 2), submitCustomerReview);
router.post('/:bookingId/professional-review', submitProfessionalReview);
router.post('/:bookingId/customer-review/reply', replyToCustomerReview);

export default router;
