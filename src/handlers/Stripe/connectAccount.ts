/**
 * Stripe Connect Account Handlers
 * Handles professional Stripe account creation and onboarding
 */

import { Request, Response } from 'express';
import { stripe, STRIPE_CONFIG } from '../../services/stripe';
import User from '../../models/user';
import { StripeAccountStatusResponse } from '../../Types/stripe';
import { mapStripeAccountStatus } from '../../utils/stripeAccountStatus';

// Map country names to ISO 3166-1 alpha-2 codes for Stripe
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'austria': 'AT', 'belgium': 'BE', 'bulgaria': 'BG', 'croatia': 'HR',
  'cyprus': 'CY', 'czech republic': 'CZ', 'denmark': 'DK', 'estonia': 'EE',
  'finland': 'FI', 'france': 'FR', 'germany': 'DE', 'greece': 'GR',
  'hungary': 'HU', 'ireland': 'IE', 'italy': 'IT', 'latvia': 'LV',
  'lithuania': 'LT', 'luxembourg': 'LU', 'malta': 'MT', 'netherlands': 'NL',
  'poland': 'PL', 'portugal': 'PT', 'romania': 'RO', 'slovakia': 'SK',
  'slovenia': 'SI', 'spain': 'ES', 'sweden': 'SE',
  'united kingdom': 'GB', 'united states': 'US', 'canada': 'CA', 'australia': 'AU',
  'switzerland': 'CH', 'norway': 'NO',
};

const DEFAULT_ONBOARDING_THROTTLE_MS = 60_000;
const parsedOnboardingThrottleMs = Number.parseInt(
  process.env.STRIPE_ONBOARDING_THROTTLE_MS || `${DEFAULT_ONBOARDING_THROTTLE_MS}`,
  10
);
const ONBOARDING_THROTTLE_MS =
  Number.isFinite(parsedOnboardingThrottleMs) && parsedOnboardingThrottleMs > 0
    ? parsedOnboardingThrottleMs
    : DEFAULT_ONBOARDING_THROTTLE_MS;

/**
 * Convert a country value to a 2-letter ISO code.
 * Accepts either a name ("Belgium") or already a code ("BE").
 */
function toCountryCode(value: string | undefined): string | null {
  if (!value) {
    console.warn('[STRIPE CONNECT] Missing country value, cannot derive Stripe country code');
    return null;
  }

  const trimmed = value.trim();
  // Already a 2-letter code
  if (/^[A-Z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
  // Look up by name
  const mapped = COUNTRY_NAME_TO_CODE[trimmed.toLowerCase()];
  if (!mapped) {
    console.warn(
      `[STRIPE CONNECT] Unknown country value "${value}", refusing to default silently`
    );
    return null;
  }
  return mapped;
}

/**
 * Create Stripe Connect Express account for professional
 * POST /api/stripe/connect/create-account
 */
export const createConnectAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id?.toString();
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthenticated' }
      });
    }

    // Get user and verify they're a professional
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' }
      });
    }

    if (user.role !== 'professional') {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_PROFESSIONAL', message: 'Only professionals can create Stripe accounts' }
      });
    }

    // Check if account already exists
    if (user.stripe?.accountId) {
      // Return existing account status
      try {
        const account = await stripe.accounts.retrieve(user.stripe.accountId);

        return res.json({
          success: true,
          data: {
            accountId: account.id,
            onboardingCompleted: account.details_submitted || false,
            chargesEnabled: account.charges_enabled || false,
            payoutsEnabled: account.payouts_enabled || false,
            detailsSubmitted: account.details_submitted || false,
            accountStatus: mapStripeAccountStatus(
              account.charges_enabled,
              account.details_submitted
            ),
            message: 'Stripe account already exists'
          }
        });
      } catch (error) {
        // If account doesn't exist in Stripe, create new one
        console.log('Existing account not found in Stripe, creating new one');
      }
    }

    const countryCode = toCountryCode(user.businessInfo?.country || user.location?.country);
    if (!countryCode) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_COUNTRY',
          message: 'Unable to determine a valid country code for Stripe account creation'
        }
      });
    }

    const isCompany =
      Boolean((user as any).isCompany) ||
      Boolean(user.businessInfo?.companyName?.trim());
    const businessType: 'company' | 'individual' = isCompany ? 'company' : 'individual';

    // Create new Stripe Connect Express account
    const account = await stripe.accounts.create({
      type: 'express',
      country: countryCode,
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: businessType,
      ...(businessType === 'company'
        ? {
            company: {
              name: user.businessInfo?.companyName || user.name,
              ...(user.vatNumber ? { tax_id: user.vatNumber } : {}),
            },
          }
        : {}),
      metadata: {
        userId: user._id.toString(),
        professionalId: user.professionalId || user._id.toString(),
        platform: 'fixtract',
        environment: STRIPE_CONFIG.environment,
      },
    });

    // Update user with Stripe account info
    user.stripe = {
      accountId: account.id,
      onboardingCompleted: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      chargesEnabled: false,
      accountStatus: 'pending',
      createdAt: new Date(),
    };
    await user.save();

    console.log(`✅ Stripe Connect account created for user ${user._id}: ${account.id}`);

    res.json({
      success: true,
      data: {
        accountId: account.id,
        onboardingCompleted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        accountStatus: 'pending',
        requiresOnboarding: true,
      }
    });

  } catch (error: any) {
    console.error('Error creating Stripe Connect account:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: 'Failed to create Stripe account'
      }
    });
  }
};

/**
 * Generate Stripe onboarding link
 * POST /api/stripe/connect/create-onboarding-link
 */
export const createOnboardingLink = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id?.toString();
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthenticated' }
      });
    }

    const user = await User.findById(userId);
    if (!user || !user.stripe?.accountId) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_STRIPE_ACCOUNT', message: 'Stripe account not found. Create one first.' }
      });
    }

    const lastRefreshMs = user.stripe.lastOnboardingRefresh
      ? user.stripe.lastOnboardingRefresh.getTime()
      : null;
    if (lastRefreshMs && Number.isFinite(lastRefreshMs)) {
      const elapsedMs = Date.now() - lastRefreshMs;
      if (elapsedMs < ONBOARDING_THROTTLE_MS) {
        const retryAfterMs = ONBOARDING_THROTTLE_MS - elapsedMs;
        return res.status(429).json({
          success: false,
          error: {
            code: 'ONBOARDING_LINK_THROTTLED',
            message: 'Please wait before requesting another onboarding link.'
          },
          retryAfterMs,
        });
      }
    }

    // Generate account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: user.stripe.accountId,
      refresh_url: `${STRIPE_CONFIG.frontendUrl}/professional/stripe/refresh`,
      return_url: `${STRIPE_CONFIG.frontendUrl}/professional/stripe/complete`,
      type: 'account_onboarding',
    });

    // Update last onboarding refresh time
    user.stripe.lastOnboardingRefresh = new Date();
    await user.save();

    res.json({
      success: true,
      data: {
        url: accountLink.url,
        expiresAt: accountLink.expires_at,
      }
    });

  } catch (error: any) {
    console.error('Error creating onboarding link:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: 'Failed to create onboarding link'
      }
    });
  }
};

/**
 * Get Stripe account status
 * GET /api/stripe/connect/account-status
 */
export const getAccountStatus = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id?.toString();
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthenticated' }
      });
    }

    const user = await User.findById(userId);
    if (!user || !user.stripe?.accountId) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_STRIPE_ACCOUNT', message: 'Stripe account not found' }
      });
    }

    // Retrieve account from Stripe
    const account = await stripe.accounts.retrieve(user.stripe.accountId);

    // Update user's Stripe info in database
    user.stripe.onboardingCompleted = account.details_submitted || false;
    user.stripe.chargesEnabled = account.charges_enabled || false;
    user.stripe.payoutsEnabled = account.payouts_enabled || false;
    user.stripe.detailsSubmitted = account.details_submitted || false;
    user.stripe.accountStatus = mapStripeAccountStatus(
      account.charges_enabled,
      account.details_submitted
    );
    await user.save();

    const statusResponse: StripeAccountStatusResponse = {
      accountId: account.id,
      onboardingCompleted: account.details_submitted || false,
      chargesEnabled: account.charges_enabled || false,
      payoutsEnabled: account.payouts_enabled || false,
      detailsSubmitted: account.details_submitted || false,
      accountStatus: user.stripe.accountStatus,
      requirements: {
        currentlyDue: account.requirements?.currently_due || [],
        pendingVerification: account.requirements?.pending_verification || [],
      }
    };

    res.json({
      success: true,
      data: statusResponse
    });

  } catch (error: any) {
    console.error('Error fetching account status:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: 'Failed to fetch account status'
      }
    });
  }
};

/**
 * Generate Stripe Express dashboard link
 * GET /api/stripe/connect/dashboard-link
 */
export const createDashboardLink = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id?.toString();
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthenticated' }
      });
    }

    const user = await User.findById(userId);
    if (!user || !user.stripe?.accountId) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_STRIPE_ACCOUNT', message: 'Stripe account not found' }
      });
    }

    const account = await stripe.accounts.retrieve(user.stripe.accountId);
    if (!account.details_submitted) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'ONBOARDING_INCOMPLETE',
          message: 'Stripe onboarding is incomplete. Please complete onboarding before opening the dashboard.',
        },
      });
    }

    // Create login link to Stripe Express dashboard
    const loginLink = await stripe.accounts.createLoginLink(user.stripe.accountId);

    res.json({
      success: true,
      data: {
        url: loginLink.url,
      }
    });

  } catch (error: any) {
    console.error('Error creating dashboard link:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: 'Failed to create dashboard link'
      }
    });
  }
};
