import express from 'express';
import {
  respondToRFQ,
  submitQuotation,
  editQuotation,
  customerRespondToQuotation,
  createDirectQuotation,
  getActiveCustomers,
  getActiveProjects,
  getQuotationVatRateOptions,
  getQuotationVersions,
  getMilestonePaymentStatus,
  createMilestonePaymentIntent,
  updateMilestoneWorkStatus,
} from '../../handlers/Quotation';
import { protect } from '../../middlewares/auth';

const router = express.Router();

// All routes require authentication
router.use(protect);

// Professional responds to RFQ (accept/reject)
router.post('/:bookingId/respond-rfq', respondToRFQ);

// Professional submits quotation via wizard
router.post('/:bookingId/submit', submitQuotation);

// Professional edits quotation (new version)
router.put('/:bookingId/edit', editQuotation);

// Customer accepts or rejects quotation
router.post('/:bookingId/customer-respond', customerRespondToQuotation);

// VAT rates available for quotation pricing lines
router.get('/:bookingId/vat-rates', getQuotationVatRateOptions);

// Professional creates direct quotation (entry point 1.2)
router.post('/direct', createDirectQuotation);

// Get active customers for professional (for direct quotation selector)
router.get('/active-customers', getActiveCustomers);

// Get active projects for professional (for linking direct quotes)
router.get('/active-projects', getActiveProjects);

// Get all quotation versions for a booking
router.get('/:bookingId/versions', getQuotationVersions);

// Milestone payment routes
router.get('/:bookingId/milestones', getMilestonePaymentStatus);
router.post('/:bookingId/milestones/:index/payment-intent', createMilestonePaymentIntent);
router.patch('/:bookingId/milestones/:index/work-status', updateMilestoneWorkStatus);

export default router;
