# Fixtract Server

Express + TypeScript API for authentication, user verification (email + phone OTP), and basic user endpoints.

### Stack
- Node.js, Express, TypeScript
- MongoDB (Mongoose)
- JWT (cookie-based auth)
- Brevo (Sendinblue) for email OTP
- Twilio Verify for SMS OTP

## Quick Start

1) Install dependencies
```bash
npm install
```

2) Create a .env file
```env
PORT=4000
MONGODB_URI=mongodb+srv://...
JWT_SECRET=change_me

# Email (Brevo)
BREVO_API_KEY=your_brevo_api_key
FROM_EMAIL=no-reply@your-domain.com

# SMS (Twilio Verify)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_VERIFY_SERVICE_SID=VAXxxxxxxxxxxxxxxxxxxxxxx

# Google Maps API (for address autocomplete and validation)
GOOGLE_MAPS_API_KEY=your_google_maps_api_key

# AWS S3 (for file uploads)
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=us-east-1
S3_BUCKET_NAME=your_bucket_name

# Frontend URL (for CORS)
FRONTEND_URL=http://localhost:3000
```

3) Run the server (traditional long-lived process)
```bash
npm run build && npm start
# or for dev with ts-node/ts-node-dev if configured
npm run dev
```

The server connects to MongoDB once at startup, then listens on `PORT` (default 4000).

## Architecture & Key Decisions

- Single DB connection at startup (no per-request connection middleware).
- Cookie-based auth with httpOnly cookie `auth-token`.
- CORS allows credentials and reflects the request origin.
- Signup triggers both OTP sends directly on the backend (no extra client round trips).
- Verification endpoints can be protected or public per your preference; by default they are protected via `protect` middleware.

## CORS & Cookies

- CORS: credentials enabled; origin is reflected.
- Cookies: `SameSite` is set to `none` in production and `secure` depends on `NODE_ENV === 'production'`.
- If you’re testing cross-site in production, ensure HTTPS so `secure` cookies work.

## Routes

Base path: `/api`

### Auth
- POST `/auth/signup`
  - Body: `{ name, email, phone, password, role }`
  - Creates user, generates JWT cookie, sends email OTP (Brevo) and SMS OTP (Twilio Verify).
  - Response: `{ success, user, emailOtpSent, phoneOtpSent }`

- POST `/auth/login`
  - Body: `{ email, password }`
  - Sets `auth-token` cookie on success.

- POST `/auth/logout`
  - Clears `auth-token` cookie.

- GET `/auth/me`
  - Returns `{ authenticated: true, user }` if cookie is valid; otherwise `{ authenticated: false }`.
  - Always 200 to avoid front-end exceptions on first load.

### User
- All user routes are mounted at `/user`.
- Middleware: `protect` is applied globally to `user` routes by default, meaning a valid `auth-token` is required.

- GET `/user/me` (protected)
  - Returns current user without password.

- POST `/user/verify-email/send-otp` (protected)
  - Sends email OTP (10 min expiry). Idempotent until verified.

- POST `/user/verify-email/verify-otp` (protected)
  - Verifies email OTP and marks `isEmailVerified=true`.

- POST `/user/verify-email/resend-otp` (protected)
  - Generates and sends a new email OTP.

- POST `/user/verify-phone` (protected)
  - Sends SMS OTP via Twilio Verify to `phone`.

- POST `/user/verify-phone-check` (protected)
  - Verifies the phone OTP with Twilio Verify and marks `isPhoneVerified=true` on success.

## Middleware

### `protect`
- Reads `auth-token` from cookies.
- Validates JWT, fetches user, attaches `req.user`.
- Returns 401 for missing/invalid/expired tokens.

## Error Handling

- Centralized error handler returns JSON: `{ message, stack (in dev) }`.
- Auth and verification handlers return clear `success`/`msg` or `message` fields.

## Environment Variable Setup Guide

### Google Maps API Key

The Google Maps API is used for address autocomplete and validation features.

#### How to Get Your Google Maps API Key:

1. **Create a Google Cloud Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select an existing one
   - Enable billing for the project (required for Maps APIs)

2. **Enable Required APIs**
   - Navigate to "APIs & Services" → "Library"
   - Search for and enable:
     - **Maps JavaScript API** (for address autocomplete)
     - **Geocoding API** (for address validation)

3. **Create API Key**
   - Go to "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "API Key"
   - Copy the generated API key

4. **Secure Your API Key (Recommended)**
   - Click on your API key to edit it
   - Under "API restrictions":
     - Select "Restrict key"
     - Choose "Maps JavaScript API" and "Geocoding API"
   - Under "Application restrictions":
     - For production: Add your domain
     - For development: Can leave unrestricted or add localhost

5. **Add to Backend .env**
   ```env
   GOOGLE_MAPS_API_KEY=AIzaSy...your_key_here
   ```

**Important**: The API key should ONLY be in the backend `.env` file. The frontend fetches the Maps script and validates addresses through secure backend endpoints.

## Common Issues & Tips

- CORS with credentials:
  - Ensure the frontend fetch uses `credentials: 'include'`.
  - In production, cookies require HTTPS for `secure: true`.

- OTP deliverability:
  - Check Brevo/Twilio credentials.
  - Email may land in spam; SMS may be rate-limited.

- JWT secrets:
  - Use a strong `JWT_SECRET` and rotate if needed.

- Google Maps not loading:
  - Verify `GOOGLE_MAPS_API_KEY` is set in backend `.env`
  - Restart the backend server after adding the key
  - Check that the required APIs are enabled in Google Cloud Console

## Development Notes

- Logs: only essential error logs are kept by default.
- You can add more structured logging if needed (e.g., pino/winston) without changing the flow.
