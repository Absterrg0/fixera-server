import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import express, { Express, Request, Response} from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import errorHandler from './handlers/error';
import connectDB from './config/db';
import BacklinkSubmission from './models/backlinkSubmission';
import { recoverStuckVerifyingSubmissions } from './utils/backlink/verifySubmission';
import authRouter from './routes/Auth';
import userRouter from './routes/User';
import adminRouter from './routes/Admin';
import projectRouter from './routes/Project';
import publicRouter from './routes/Public';
import meetingRouter from './routes/Meeting';
import serviceCategoryRouter from './routes/ServiceCategory';
import professionalRouter from './routes/Professional';
import professionalPaymentRouter from './routes/ProfessionalPayment';
import searchRouter from './routes/Search';
import bookingRouter from './routes/Booking';
import quotationRouter from './routes/Quotation';
import stripeRouter from './routes/Stripe';
import chatRouter from './routes/Chat';
import warrantyClaimRouter from './routes/WarrantyClaim';
import favoritesRouter from './routes/Favorites';

const app: Express = express();

// 🚨 Allow ALL origins but still allow credentials (cookies)
app.use(cors({
  origin: true, // Reflects the request's Origin header
  credentials: true, // Allow cookies
}));

app.use('/api/stripe/webhooks', express.raw({ type: 'application/json' }));

// Body and cookie parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Health check and root routes
app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'Fixera API Server is running',
    status: 'Up',
    version: '1.0.0',
  });
});

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: "UP" });
});

// API routes
app.use('/api/public', publicRouter);
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/admin', adminRouter);
app.use('/api/projects', projectRouter);
app.use('/api/meetings', meetingRouter);
app.use('/api/service-categories', serviceCategoryRouter);
app.use('/api/professionals', professionalRouter);
app.use('/api/search', searchRouter);
app.use('/api/bookings', bookingRouter);
app.use('/api/quotations', quotationRouter);
app.use('/api/stripe', stripeRouter);
app.use('/api/professional', professionalPaymentRouter);
app.use('/api/chat', chatRouter);
app.use('/api/warranty-claims', warrantyClaimRouter);
app.use('/api/favorites', favoritesRouter);

// Error handler (must be last)
app.use(errorHandler);

// Traditional server: connect once at startup, then listen
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const STUCK_VERIFY_SWEEP_MS = 10 * 60 * 1000;

connectDB()
  .then(async () => {
    try {
      await BacklinkSubmission.syncIndexes();
    } catch (error) {
      console.error('BacklinkSubmission.syncIndexes failed:', error);
    }
    try {
      await recoverStuckVerifyingSubmissions();
    } catch (error) {
      console.error('Initial stuck verification recovery failed:', error);
    }
    const sweepTimer = setInterval(() => {
      void recoverStuckVerifyingSubmissions().catch((error) => {
        console.error('Stuck verification sweep failed:', error);
      });
    }, STUCK_VERIFY_SWEEP_MS);
    sweepTimer.unref();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to connect to MongoDB at startup:', error);
    process.exit(1);
  });

export default app;
