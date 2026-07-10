```markdown
# Project Environment Setup

This guide provides detailed instructions on how to obtain and configure the necessary environment variables for this project. These variables are essential for connecting to databases, third-party services, and for the overall application to function correctly.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Variables Overview](#environment-variables-overview)
3. [Setting up the .env file](#setting-up-the-env-file)
4. [Step-by-Step Instructions](#step-by-step-instructions)
   - [MongoDB Atlas (MONGODB_URI)](#mongodb-atlas-mongodb_uri)
   - [JSON Web Token (JWT_SECRET)](#json-web-token-jwt_secret)
   - [Twilio (TWILIO_... variables)](#twilio-twilio-variables)
   - [Brevo (BREVO_... and SMTP_... variables)](#brevo-brevo-and-smtp-variables)
   - [AWS S3 (AWS_... and S3_... variables)](#aws-s3-aws-and-s3-variables)
   - [General Variables (PORT, FROM_EMAIL)](#general-variables-port-from_email)
5. [Using Environment Variables](#using-environment-variables)

## Prerequisites

Before you begin, ensure you have the following:

- A code editor (like VS Code).
- Node.js and npm (or yarn) installed on your machine.
- An account for each of the following services (free tiers are available):
  - MongoDB Atlas
  - Twilio
  - Brevo (formerly Sendinblue)
  - AWS (Amazon Web Services)

## Environment Variables Overview

Here is a list of all the environment variables you will need to configure:

- `MONGODB_URI`: Your connection string for the MongoDB database.
- `PORT`: The port on which your application server will run.
- `JWT_SECRET`: A secret key for signing and verifying JSON Web Tokens.
- `TWILIO_ACCOUNT_SID`: Your main Twilio account identifier.
- `TWILIO_AUTH_TOKEN`: Your Twilio account's secret authentication token.
- `TWILIO_VERIFY_SERVICE_SID`: The SID for a specific Twilio Verify service.
- `BREVO_API_KEY`: Your API key for the Brevo email service.
- `SMTP_SERVER`: The SMTP server address provided by Brevo.
- `SMTP_PORT`: The SMTP port number provided by Brevo.
- `SMTP_LOGIN`: The SMTP login username provided by Brevo.
- `FROM_EMAIL`: The email address you will use to send emails from.
- `AWS_ACCESS_KEY_ID`: Your AWS IAM user access key ID.
- `AWS_SECRET_ACCESS_KEY`: Your AWS IAM user secret access key.
- `AWS_REGION`: The AWS region where your S3 bucket is located.
- `S3_BUCKET_NAME`: The name of your AWS S3 bucket for file storage.

## Setting up the .env file

1. In the root directory of your project, create a new file named `.env`.

2. Copy the following template into your `.env` file. You will replace the placeholder values with the actual credentials you obtain in the next steps.

```env
MONGODB_URI=
PORT=4000
JWT_SECRET=

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_VERIFY_SERVICE_SID=

BREVO_API_KEY=
SMTP_SERVER=
SMTP_PORT=
SMTP_LOGIN=
FROM_EMAIL=

AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
S3_BUCKET_NAME=
```

**Important**: Remember to add `.env` to your `.gitignore` file to prevent your secret keys from being committed to version control.

## Step-by-Step Instructions

### MongoDB Atlas (MONGODB_URI)

1. Sign in to your MongoDB Atlas account.

2. Create a new project and then build a new cluster. The free M0 tier is sufficient for development.

3. Once the cluster is deployed, navigate to **Database Access** under the "Security" section in the left-hand menu.

4. Click **Add New Database User**.

5. Create a username and password. Save these credentials securely, as you will need them for the connection string.

6. Next, go to **Network Access**.

7. Click **Add IP Address**.

8. Select "Allow Access from Anywhere" (0.0.0.0/0) for development purposes. For production, you should restrict this to your server's IP.

9. Finally, go back to your Database dashboard and click the **Connect** button for your cluster.

10. Select "Connect your application".

11. Choose the Node.js driver and the latest version.

12. Copy the provided connection string. It will look something like this:
    ```
    mongodb+srv://<username>:<password>@cluster0.kh0hojp.mongodb.net/?retryWrites=true&w=majority
    ```

13. Replace `<username>` and `<password>` with the database user credentials you created in step 5.

14. Paste this complete string into your `.env` file as the value for `MONGODB_URI`.

### JSON Web Token (JWT_SECRET)

1. This is a secret key that you create yourself. It should be a long, random, and complex string to ensure your application's security.

2. You can use an online generator like [Random Keygen](https://randomkeygen.com/) to create a strong secret.

3. Copy the generated string and paste it as the value for `JWT_SECRET` in your `.env` file.

**Example**: `JWT_SECRET=aVeryLongAndRandomSecretStringForMyProject123!@#`

### Twilio (TWILIO_... variables)

1. Sign in to your [Twilio Console](https://console.twilio.com/).

2. On the main dashboard, you will find your **Account SID** and **Auth Token**.

3. Copy the **Account SID** and paste it as the value for `TWILIO_ACCOUNT_SID`.

4. Click "Show" to reveal your **Auth Token**, copy it, and paste it as the value for `TWILIO_AUTH_TOKEN`.

5. To get the `TWILIO_VERIFY_SERVICE_SID`:
   - In the left-hand navigation pane, go to **Verify > Services**.
   - Click "Create new service".
   - Give it a friendly name (e.g., "My App Verification").
   - Once created, you will be taken to the service's settings page. Copy the **Service SID** (it starts with `VA...`) and paste it as the value for `TWILIO_VERIFY_SERVICE_SID`.

### Brevo (BREVO_... and SMTP_... variables)

1. Sign in to your [Brevo account](https://www.brevo.com/).

2. To get the `BREVO_API_KEY`:
   - Click on your profile name in the top-right corner and select "SMTP & API".
   - Navigate to the "API Keys" tab.
   - Click "Generate a new API key".
   - Name your key and click Generate.
   - Copy the API key immediately (it will only be shown once) and paste it as the value for `BREVO_API_KEY`.

3. To get the SMTP variables:
   - On the same "SMTP & API" page, stay on the "SMTP" tab.
   - You will find the SMTP Server, Port, and Login details listed there.
   - Copy `smtp-relay.brevo.com` and paste it for `SMTP_SERVER`.
   - Copy `587` and paste it for `SMTP_PORT`.
   - Copy your login email and paste it for `SMTP_LOGIN`.

### AWS S3 (AWS_... and S3_... variables)

AWS S3 is used for secure file storage, particularly for user-uploaded documents like ID proofs.

1. **Create an AWS Account**:
   - Sign up at [AWS Console](https://aws.amazon.com/console/) if you don't have an account.
   - Note: AWS requires a valid credit card, but offers a generous free tier.

2. **Create an IAM User for S3 Access**:
   - Go to the [IAM Console](https://console.aws.amazon.com/iam/).
   - Click **Users** → **Create User**.
   - Enter a username (e.g., `fixera-s3-user`).
   - Select **Attach policies directly**.
   - Search for and select `AmazonS3FullAccess` policy (or create a custom policy for better security).
   - Click **Create user**.

3. **Generate Access Keys**:
   - Select the user you just created.
   - Go to the **Security credentials** tab.
   - Click **Create access key**.
   - Choose **Application running outside AWS**.
   - Click **Create access key**.
   - **Important**: Copy both the **Access Key ID** and **Secret Access Key** immediately:
     - Copy **Access Key ID** → paste as `AWS_ACCESS_KEY_ID`
     - Copy **Secret Access Key** → paste as `AWS_SECRET_ACCESS_KEY`
   - Click **Done** (you won't be able to see the secret key again).

4. **Create an S3 Bucket**:
   - Go to the [S3 Console](https://s3.console.aws.amazon.com/).
   - Click **Create bucket**.
   - Choose a unique bucket name (e.g., `my-fixera-uploads`) → copy this for `S3_BUCKET_NAME`.
   - Choose an AWS region (e.g., `us-east-1`, `eu-west-1`) → copy this for `AWS_REGION`.
   - **Bucket settings** (recommended for security):
     - Keep **Block Public Access** enabled.
     - Enable **Bucket Versioning**.
     - Enable **Default Encryption** with SSE-S3.
   - Click **Create bucket**.

5. **Test Your Configuration** (optional):
   ```javascript
   // You can test your S3 connection with this code snippet
   const AWS = require('aws-sdk');
   const s3 = new AWS.S3({
     accessKeyId: process.env.AWS_ACCESS_KEY_ID,
     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
     region: process.env.AWS_REGION
   });
   
   s3.listBuckets((err, data) => {
     if (err) console.log('Error:', err);
     else console.log('Success! Buckets:', data.Buckets);
   });
   ```

**Security Best Practices**:
- Never commit your AWS credentials to version control.
- Consider using IAM roles in production instead of access keys.
- Create bucket policies to restrict access to specific operations if needed.
- Enable CloudTrail logging for audit purposes in production.

### General Variables (PORT, FROM_EMAIL)

- **PORT**: This is the port your application will listen on. `4000` is a common choice for development, but you can change it if needed.
- **FROM_EMAIL**: This should be the email address associated with your Brevo account or an email you have verified with Brevo to send emails from.

## Using Environment Variables

To use these variables in your Node.js application, you will need a package like `dotenv`.

1. Install dotenv:
   ```bash
   npm install dotenv
   ```

2. Load the variables at the very beginning of your main application file (e.g., `index.js` or `app.js`):
   ```javascript
   require('dotenv').config();
   ```

3. You can now access your variables anywhere in your application using `process.env`:
   ```javascript
   const port = process.env.PORT;
   const mongoURI = process.env.MONGODB_URI;

   console.log(`Server is running on port ${port}`);
   ```
```