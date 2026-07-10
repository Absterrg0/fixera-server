import { TransactionalEmailsApi, SendSmtpEmail, TransactionalEmailsApiApiKeys } from "@getbrevo/brevo";
import mongoose from "mongoose";
import { logEmail } from "./emailLogger";

interface SendEmailMeta {
  template?: string;
  relatedBooking?: string | mongoose.Types.ObjectId;
  relatedUser?: string | mongoose.Types.ObjectId;
}

// Initialize Brevo API with proper configuration
const createEmailAPI = () => {
  const api = new TransactionalEmailsApi();
  
  // Set API key using the correct method
  if (process.env.BREVO_API_KEY) {
    api.setApiKey(TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
  } else {
    console.error("BREVO_API_KEY environment variable is not set");
  }
  
  return api;
};

// Generate a 6-digit OTP
export const generateOTP = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const escapeHtml = (value: string | undefined | null): string => {
  const input = String(value ?? "");
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");
};

// Common email header template
const getEmailHeader = (title: string) => `
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 28px;">Fixtract</h1>
    <p style="color: white; margin: 10px 0 0 0; font-size: 16px;">${escapeHtml(title)}</p>
  </div>
`;

// Common email footer template
const getEmailFooter = () => `
  <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
    <p style="color: #999; font-size: 12px; margin: 0;">
      © 2025 Fixtract. All rights reserved.
    </p>
  </div>
`;

// Send OTP email using Brevo
export const sendOTPEmail = async (email: string, otp: string, userName: string): Promise<boolean> => {
  try {
    const safeUserName = escapeHtml(userName);
    const safeOtp = escapeHtml(otp);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Email Verification")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeUserName}!</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Thank you for joining Fixtract! To complete your registration, please use the verification code below:
          </p>
          
          <div style="background: #fff; border: 2px solid #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 10px 0; font-size: 18px;">Your Verification Code</h3>
            <div style="font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 8px; font-family: 'Courier New', monospace;">
              ${safeOtp}
            </div>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            This code will expire in 10 minutes for security reasons.
          </p>
          
          <div style="background: #e8f4fd; border-left: 4px solid #667eea; padding: 15px; margin: 25px 0;">
            <p style="color: #333; margin: 0; font-size: 14px;">
              <strong>Security Tip:</strong> Never share this code with anyone. Fixtract will never ask for this code via phone or email.
            </p>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            If you didn't create an account with Fixtract, please ignore this email.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;
    const emailAPI = createEmailAPI(); 
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Verify Your Fixtract Account";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixtract Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    return false;
  }
};

// Send welcome email after signup
export const sendWelcomeEmail = async (email: string, userName: string): Promise<boolean> => {
  try {
    const safeUserName = escapeHtml(userName);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Welcome to Fixtract!")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Welcome ${safeUserName}!</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Thank you for joining Fixtract! Your account has been successfully created. We're excited to have you as part of our community of homeowners and skilled professionals.
          </p>
          
          <div style="background: #e8f5e8; border: 2px solid #4CAF50; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px;">✨ Next Steps</h3>
            <p style="color: #333; margin: 0 0 15px 0; line-height: 1.6;">
              Complete your profile to get the most out of Fixtract and start connecting with our verified professionals.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/profile" 
                 style="background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Complete Your Profile
              </a>
            </div>
          </div>
          
          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">🏠 What you can do with Fixtract:</h3>
            <ul style="color: #666; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Find verified professionals for home services</li>
              <li>Get instant quotes or custom project estimates</li>
              <li>Book services with secure payment protection</li>
              <li>Enjoy up to 10-year warranty on completed work</li>
            </ul>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Questions? Our support team is here to help 24/7. Reply to this email or contact us anytime.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Welcome to Fixtract - Let's Complete Your Profile!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixtract Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

   await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

export const sendProfessionalWelcomeEmail = async (email: string, professionalName: string): Promise<boolean> => {
  try {
    const safeProfessionalName = escapeHtml(professionalName);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Welcome to Fixtract Professionals")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Welcome ${safeProfessionalName}!</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Your professional onboarding has been submitted successfully. You can now access your dashboard and profile while our team reviews your account.
          </p>

          <div style="background: #e8f5e8; border: 2px solid #4CAF50; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px;">Next Steps</h3>
            <p style="color: #333; margin: 0 0 15px 0; line-height: 1.6;">
              Review your business profile, keep your availability updated, and watch for approval from the Fixtract team.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard"
                 style="background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
                Open Dashboard
              </a>
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/profile"
                 style="background: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Open Profile
              </a>
            </div>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Once approved, you will be able to create projects and start working with customers on Fixtract.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Welcome to Fixtract Professionals";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixtract Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send professional welcome email:', error);
    return false;
  }
};

// Send ID expired email to professionals
export const sendIdExpiredEmail = async (email: string, userName: string): Promise<boolean> => {
  try {
    const safeUserName = escapeHtml(userName);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Action Required: ID Expired")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeUserName},</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Our records show that your ID document has expired. To keep your professional profile active, please upload a valid ID and update your expiration date.
          </p>
          
          <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #856404; margin: 0 0 15px 0; font-size: 18px;">Required Action</h3>
            <p style="color: #333; margin: 0; line-height: 1.6;">
              Upload a valid ID document and provide the updated expiration date.
            </p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/professional/onboarding"
               style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              Update ID Now
            </a>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            If you have questions, reply to this email and our support team will help.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixtract: Your ID Has Expired";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixtract Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    return false;
  }
};

// Send professional approval email
export const sendProfessionalApprovalEmail = async (email: string, professionalName: string): Promise<boolean> => {
  try {
    const safeProfessionalName = escapeHtml(professionalName);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Profile Approved! 🎉")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Congratulations ${safeProfessionalName}!</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Great news! Your professional profile has been approved by our team. You can now start accepting projects and connecting with customers on Fixtract.
          </p>
          
          <div style="background: #e8f5e8; border: 2px solid #4CAF50; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px;">🚀 You're All Set!</h3>
            <p style="color: #333; margin: 0 0 20px 0; line-height: 1.6;">
              Your profile is now live and customers can find you. Start by creating your first project listing or update your availability.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard" 
                 style="background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
                Go to Dashboard
              </a>
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/projects/create" 
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Create Project
              </a>
            </div>
          </div>
          
          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">💼 What's next:</h3>
            <ul style="color: #666; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Update your availability calendar</li>
              <li>Add portfolio images and certifications</li>
              <li>Set your hourly rates and service areas</li>
              <li>Start receiving project inquiries from customers</li>
            </ul>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Welcome to the Fixtract professional community! We're here to support your success.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "🎉 Your Fixtract Professional Profile is Approved!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixtract Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {

    return false;
  }
};

// Send professional rejection email
export const sendProfessionalRejectionEmail = async (email: string, professionalName: string, reason: string): Promise<boolean> => {
  try {
    const safeProfessionalName = escapeHtml(professionalName);
    const safeReason = escapeHtml(reason);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Profile Update Required")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Thank you for your interest in becoming a verified professional on Fixtract. After reviewing your profile, we need you to address some items before we can approve your account.
          </p>
          
          <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #856404; margin: 0 0 15px 0; font-size: 18px;">⚠️ Items to Address</h3>
            <div style="background: #fff; border-left: 4px solid #ffc107; padding: 15px; border-radius: 4px;">
              <p style="color: #333; margin: 0; line-height: 1.6;">
                <strong>Reason:</strong> ${safeReason}
              </p>
            </div>
          </div>
          
          <div style="background: #e8f4fd; border: 2px solid #667eea; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">🔧 How to Fix This</h3>
            <p style="color: #333; margin: 0 0 15px 0; line-height: 1.6;">
              Please update your profile with the requested information, then click "Send for Verification" to resubmit for review.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/profile" 
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Update Profile
              </a>
            </div>
          </div>
          
          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">📋 Common Requirements:</h3>
            <ul style="color: #666; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Valid government-issued ID (passport, driver's license)</li>
              <li>EU VAT number validation (for EU professionals)</li>
              <li>Complete business information and contact details</li>
              <li>Professional certifications or proof of expertise</li>
            </ul>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Once you've made the necessary updates, we'll review your profile again within 48 hours. If you have questions, feel free to reply to this email.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixtract Profile Update Required - Please Review";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixtract Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

// Send professional ID change rejection email (account remains approved)
export const sendProfessionalIdChangeRejectionEmail = async (
  email: string,
  professionalName: string,
  reason: string
): Promise<boolean> => {
  try {
    const safeProfessionalName = escapeHtml(professionalName);
    const safeReason = escapeHtml(reason);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("ID Document Update Rejected")}
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>
          
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Your recent ID document update was reviewed and could not be approved at this time.
            <strong>Your professional account remains approved and active.</strong>
          </p>

          <div style="background: #fff3cd; border: 1px solid #ffeeba; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0; color: #856404;"><strong>Reason:</strong> ${safeReason}</p>
          </div>

          <p style="color: #666; line-height: 1.6;">
            Please upload an updated document that addresses the issue above. If you have questions, reply to this email and our team will help.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "ID document rejected — account remains approved";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixtract Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

// Send professional ID change approval email (account was already approved, ID update accepted)
export const sendProfessionalIdChangeApprovalEmail = async (
  email: string,
  professionalName: string
): Promise<boolean> => {
  try {
    const safeProfessionalName = escapeHtml(professionalName);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("ID Document Update Approved")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Your recent ID document update has been reviewed and approved by our team.
            <strong>Your professional account remains approved and active.</strong>
          </p>

          <div style="background: #e8f5e8; border: 1px solid #4CAF50; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <p style="margin: 0; color: #2E7D32;"><strong>Your updated ID information is now on file.</strong></p>
          </div>

          <p style="color: #666; line-height: 1.6;">
            No further action is needed. If you have any questions, reply to this email and our team will help.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "ID document update approved — account remains approved";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixtract Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

// Send professional suspension email
export const sendProfessionalSuspensionEmail = async (email: string, name: string, reason: string): Promise<boolean> => {
  try {
    console.log(`📧 Sending suspension email to ${email}`);
    const safeName = escapeHtml(name);
    const safeReason = escapeHtml(reason);

    const emailContent = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8fafc; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          
          ${getEmailHeader("Account Suspension")}
          
          <div style="text-align: center; margin-bottom: 30px;">
            <div style="background: #fee2e2; border: 2px solid #ef4444; border-radius: 50%; width: 80px; height: 80px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
              <span style="font-size: 36px;">⏸️</span>
            </div>
            <h2 style="color: #dc2626; margin: 0; font-size: 24px; font-weight: bold;">Account Suspended</h2>
          </div>
          
          <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
            Dear <strong>${safeName}</strong>,
          </p>
          
          <p style="color: #333; line-height: 1.6; margin-bottom: 20px;">
            We're writing to inform you that your Fixtract professional account has been temporarily suspended.
          </p>
          
          <div style="background: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #92400e; margin: 0 0 15px 0; font-size: 18px;">📋 Reason for Suspension</h3>
            <p style="color: #333; margin: 0; line-height: 1.6; font-style: italic;">
              "${safeReason}"
            </p>
          </div>
          
          <div style="background: #e8f4fd; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">🔧 What This Means</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.6;">
              <li>Your account access has been temporarily disabled</li>
              <li>You cannot receive new appointments during suspension</li>
              <li>Existing appointments may be affected</li>
              <li>You can appeal this decision by contacting support</li>
            </ul>
          </div>
          
          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">📞 Need Help?</h3>
            <p style="color: #666; line-height: 1.6; margin: 0;">
              If you believe this suspension was made in error or if you'd like to discuss this decision, please contact our support team immediately. We're here to help resolve any issues.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="mailto:support@fixtract.com" 
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Contact Support
              </a>
            </div>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            We take these matters seriously and appreciate your understanding. Our team is available to assist you through this process.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixtract Account Suspended - Action Required";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixtract Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

// Send professional unsuspension/reactivation email
export const sendProfessionalReactivationEmail = async (email: string, name: string): Promise<boolean> => {
  try {
    console.log(`📧 Sending reactivation email to ${email}`);
    const safeName = escapeHtml(name);

    const emailContent = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8fafc; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          
          ${getEmailHeader("Account Reactivated")}
          
          <div style="text-align: center; margin-bottom: 30px;">
            <div style="background: #dcfce7; border: 2px solid #16a34a; border-radius: 50%; width: 80px; height: 80px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
              <span style="font-size: 36px;">✅</span>
            </div>
            <h2 style="color: #16a34a; margin: 0; font-size: 24px; font-weight: bold;">Account Reactivated!</h2>
          </div>
          
          <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
            Dear <strong>${safeName}</strong>,
          </p>
          
          <p style="color: #333; line-height: 1.6; margin-bottom: 20px;">
            Great news! Your Fixtract professional account has been reactivated and is now fully operational.
          </p>
          
          <div style="background: #dcfce7; border: 2px solid #16a34a; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #15803d; margin: 0 0 15px 0; font-size: 18px;">🎉 You Can Now</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.6;">
              <li>Access your professional dashboard</li>
              <li>Receive new appointment requests</li>
              <li>Manage your schedule and availability</li>
              <li>Update your professional profile</li>
            </ul>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard" 
               style="background: #667eea; color: white; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 16px;">
              Access Your Dashboard
            </a>
          </div>
          
          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Thank you for your patience during this process. We're excited to have you back on the platform and look forward to your continued success with Fixtract.
          </p>
          
          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixtract Account Reactivated - Welcome Back!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = { 
      name: "Fixtract Team", 
      email: process.env.FROM_EMAIL || "anafariya@gmail.com" 
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);

    return true;
  } catch (error: any) {
    return false;
  }
};

// Send team member invitation email
export const sendTeamMemberInvitationEmail = async (
  email: string,
  teamMemberName: string,
  companyName: string,
  loginEmail: string,
  temporaryPassword: string
): Promise<boolean> => {
  try {
    const emailAPI = createEmailAPI();
    const safeTeamMemberName = escapeHtml(teamMemberName);
    const safeCompanyName = escapeHtml(companyName);
    const safeLoginEmail = escapeHtml(loginEmail);
    const safeTemporaryPassword = escapeHtml(temporaryPassword);

    const htmlContent = `
      <div style="max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif; background: #f9f9f9; padding: 20px;">
        <div style="background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          ${getEmailHeader('Team Member Invitation')}

          <div style="padding: 30px;">
            <h2 style="color: #333; margin-bottom: 20px;">Welcome to the Team, ${safeTeamMemberName}!</h2>

            <p style="color: #666; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
              You have been invited to join <strong>${safeCompanyName}</strong> as a team member on the Fixtract platform.
            </p>

            <div style="background: #f8f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea;">
              <h3 style="color: #333; margin: 0 0 15px 0; font-size: 18px;">Your Login Credentials</h3>
              <p style="margin: 5px 0; color: #666;"><strong>Email:</strong> ${safeLoginEmail}</p>
              <p style="margin: 5px 0; color: #666;"><strong>Temporary Password:</strong> <code style="background: #e8e8e8; padding: 4px 8px; border-radius: 4px; font-family: monospace;">${safeTemporaryPassword}</code></p>
            </div>

            <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
              <p style="margin: 0; color: #856404; font-size: 14px;">
                <strong>Security Note:</strong> Please change your password after your first login for security purposes.
              </p>
            </div>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/login"
                 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: bold; display: inline-block;">
                Login to Your Account
              </a>
            </div>

            <div style="margin-top: 30px;">
              <h3 style="color: #333; margin-bottom: 15px; font-size: 18px;">What's Next?</h3>
              <ul style="color: #666; line-height: 1.8; padding-left: 20px;">
                <li>Log in using your provided credentials</li>
                <li>Change your password for security</li>
                <li>Set up your availability preferences</li>
                <li>Start collaborating with your team</li>
              </ul>
            </div>

            <p style="color: #999; font-size: 14px; margin-top: 30px;">
              If you have any questions or need assistance, please contact your company administrator or reach out to our support team.
            </p>
          </div>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const sendSmtpEmail: SendSmtpEmail = {
      to: [{ email: email, name: teamMemberName }],
      subject: `Welcome to ${companyName} - Team Member Invitation`,
      htmlContent: htmlContent,
      sender: {
        email: process.env.FROM_EMAIL || 'noreply@fixtract.com',
        name: 'Fixtract Team'
      },
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    return false;
  }
};

// Send project approval email
export const sendProjectApprovalEmail = async (
  email: string,
  professionalName: string,
  projectTitle: string,
  projectId: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending project approval email to ${email}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const encodedProjectId = encodeURIComponent(projectId);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Project Approved! 🎉")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Congratulations ${safeProfessionalName}!</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Great news! Your project "<strong>${safeProjectTitle}</strong>" has been approved and is now live on Fixtract.
          </p>

          <div style="background: #e8f5e8; border: 2px solid #4CAF50; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px;">🚀 Your Project is Live!</h3>
            <p style="color: #333; margin: 0 0 20px 0; line-height: 1.6;">
              Customers can now find and book your project. Start managing your bookings and connecting with clients.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/professioanl/projects/${encodedProjectId}"
                  style="background: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
                 View Project
               </a>
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard"
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Go to Dashboard
              </a>
            </div>
          </div>

          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">💼 Next Steps:</h3>
            <ul style="color: #666; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Monitor inquiries and booking requests</li>
              <li>Keep your availability calendar updated</li>
              <li>Respond promptly to customer messages</li>
              <li>Deliver quality service to earn great reviews</li>
            </ul>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Thank you for being part of the Fixtract community. We're excited to see your project succeed!
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "🎉 Your Fixtract Project is Approved!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixtract Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send project approval email:', error);
    return false;
  }
};

// Send project rejection email
export const sendProjectRejectionEmail = async (
  email: string,
  professionalName: string,
  projectTitle: string,
  feedback: string,
  projectId: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending project rejection email to ${email}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const safeFeedback = escapeHtml(feedback);
    const encodedProjectId = encodeURIComponent(projectId);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Project Update Required")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Thank you for submitting your project "<strong>${safeProjectTitle}</strong>". After reviewing it, we need you to address some items before we can approve it.
          </p>

          <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #856404; margin: 0 0 15px 0; font-size: 18px;">⚠️ Items to Address</h3>
            <div style="background: #fff; border-left: 4px solid #ffc107; padding: 15px; border-radius: 4px;">
              <p style="color: #333; margin: 0; line-height: 1.6;">
                <strong>Feedback:</strong> ${safeFeedback}
              </p>
            </div>
          </div>

          <div style="background: #e8f4fd; border: 2px solid #667eea; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">🔧 How to Fix This</h3>
            <p style="color: #333; margin: 0 0 15px 0; line-height: 1.6;">
              Please update your project with the requested changes, then resubmit it for review.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/professional/projects/${encodedProjectId}/edit"
                  style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                 Edit Project
               </a>
            </div>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Once you've made the necessary updates, we'll review your project again within 48 hours. If you have questions, feel free to reply to this email.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixtract Project Update Required - Please Review";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixtract Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send project rejection email:', error);
    return false;
  }
};

// Send project deleted email
export const sendProjectDeletedEmail = async (
  email: string,
  professionalName: string,
  projectTitle: string,
  reason: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending project deletion email to ${email}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const safeReason = escapeHtml(reason);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Project Deleted")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            We're writing to inform you that your project "<strong>${safeProjectTitle}</strong>" has been removed from Fixtract.
          </p>

          <div style="background: #fee2e2; border: 2px solid #ef4444; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #dc2626; margin: 0 0 15px 0; font-size: 18px;">❌ Reason for Deletion</h3>
            <div style="background: #fff; border-left: 4px solid #ef4444; padding: 15px; border-radius: 4px;">
              <p style="color: #333; margin: 0; line-height: 1.6;">
                ${safeReason}
              </p>
            </div>
          </div>

          <div style="background: #e8f4fd; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">🔧 What This Means</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.6;">
              <li>The project is no longer visible on the platform</li>
              <li>You can create a new project that complies with our guidelines</li>
              <li>Contact support if you have questions about this decision</li>
            </ul>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/projects/create"
               style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
              Create New Project
            </a>
            <a href="mailto:support@fixtract.com"
               style="background: #6b7280; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              Contact Support
            </a>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            We appreciate your understanding and look forward to seeing your future projects on Fixtract.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixtract Project Deleted - Important Notice";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixtract Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send project deletion email:', error);
    return false;
  }
};

// Send project deactivated email
export const sendProjectDeactivatedEmail = async (
  email: string,
  professionalName: string,
  projectTitle: string,
  reason: string,
  projectId: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending project deactivation email to ${email}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const safeReason = escapeHtml(reason);
    const encodedProjectId = encodeURIComponent(projectId);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Project Temporarily Deactivated")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${safeProfessionalName},</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            We're writing to inform you that your project "<strong>${safeProjectTitle}</strong>" has been temporarily deactivated.
          </p>

          <div style="background: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #92400e; margin: 0 0 15px 0; font-size: 18px;">⏸️ Reason for Deactivation</h3>
            <div style="background: #fff; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 4px;">
              <p style="color: #333; margin: 0; line-height: 1.6;">
                ${safeReason}
              </p>
            </div>
          </div>

          <div style="background: #e8f4fd; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">🔧 What This Means</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.6;">
              <li>The project is temporarily hidden from customers</li>
              <li>You can still access and edit the project</li>
              <li>New bookings are paused until reactivation</li>
              <li>Contact support to resolve this issue and reactivate</li>
            </ul>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/professional/projects/${encodedProjectId}/edit"
               style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
              View Project
            </a>
            <a href="mailto:support@fixtract.com"
               style="background: #6b7280; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              Contact Support
            </a>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Once the issue is resolved, your project will be reactivated and visible to customers again.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "Fixtract Project Temporarily Deactivated";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixtract Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send project deactivation email:', error);
    return false;
  }
};

// Send project reactivated email
export const sendProjectReactivatedEmail = async (
  email: string,
  professionalName: string,
  projectTitle: string,
  projectId: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending project reactivation email to ${email}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const encodedProjectId = encodeURIComponent(projectId);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("Project Reactivated! ✅")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Great News, ${safeProfessionalName}!</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            Your project "<strong>${safeProjectTitle}</strong>" has been reactivated and is now live on Fixtract again!
          </p>

          <div style="background: #dcfce7; border: 2px solid #16a34a; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
            <h3 style="color: #15803d; margin: 0 0 15px 0; font-size: 18px;">🎉 Your Project is Live!</h3>
            <p style="color: #333; margin: 0 0 20px 0; line-height: 1.6;">
              Customers can now find and book your project again. Continue managing your bookings and connecting with clients.
            </p>
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/professional/projects/${encodedProjectId}"
                  style="background: #16a34a; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; margin-right: 10px;">
                 View Project
               </a>
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard"
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                Go to Dashboard
              </a>
            </div>
          </div>

          <div style="background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #333; margin: 0 0 15px 0; font-size: 16px;">💼 Keep It Going:</h3>
            <ul style="color: #666; line-height: 1.8; margin: 0; padding-left: 20px;">
              <li>Monitor new inquiries and booking requests</li>
              <li>Keep your availability calendar updated</li>
              <li>Respond promptly to customer messages</li>
              <li>Maintain high service quality standards</li>
            </ul>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Thank you for your patience. We're excited to have your project back on the platform!
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.subject = "🎉 Your Fixtract Project is Reactivated!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixtract Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send project reactivation email:', error);
    return false;
  }
};

// Send booking request notification to professional
export const sendBookingNotificationEmail = async (
  professionalEmail: string,
  professionalName: string,
  customerName: string,
  projectTitle: string,
  preferredDate: string,
  bookingId: string
): Promise<boolean> => {
  try {
    console.log(`📧 Sending booking notification email to ${professionalEmail}`);
    const safeProfessionalName = escapeHtml(professionalName);
    const safeCustomerName = escapeHtml(customerName);
    const safeProjectTitle = escapeHtml(projectTitle);
    const safePreferredDate = escapeHtml(preferredDate);

    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader("New Booking Request! 🎉")}

        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Congratulations ${safeProfessionalName}!</h2>

          <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
            You've received a new booking request for your project "<strong>${safeProjectTitle}</strong>"!
          </p>

          <div style="background: #e8f5e8; border: 2px solid #4CAF50; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px;">📋 Booking Details</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.8;">
              <li><strong>Customer:</strong> ${safeCustomerName}</li>
              <li><strong>Project:</strong> ${safeProjectTitle}</li>
              <li><strong>Preferred Start Date:</strong> ${safePreferredDate}</li>
              <li><strong>Status:</strong> Awaiting Your Quote</li>
            </ul>
          </div>

          <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 20px; margin: 25px 0;">
            <h3 style="color: #856404; margin: 0 0 15px 0; font-size: 18px;">⏰ What's Next?</h3>
            <p style="color: #333; margin: 0; line-height: 1.6;">
              Review the booking details and customer requirements, then provide your quote. We'll notify you when the customer responds and guide you through the payment process.
            </p>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard"
               style="background: #667eea; color: white; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; font-size: 16px;">
              View Booking Request
            </a>
          </div>

          <div style="background: #e8f4fd; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; margin: 25px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px;">💡 Tips for Success</h3>
            <ul style="color: #333; margin: 0; padding-left: 20px; line-height: 1.8;">
              <li>Respond within 24 hours for better conversion rates</li>
              <li>Provide a detailed, professional quote</li>
              <li>Include timeline and any relevant terms</li>
              <li>Be transparent about pricing and expectations</li>
            </ul>
          </div>

          <p style="color: #666; line-height: 1.6; margin-top: 30px;">
            Good luck with your new booking! We're here to support you throughout the process.
          </p>

          ${getEmailFooter()}
        </div>
      </div>
    `;

    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email: professionalEmail }];
    sendSmtpEmail.subject = "🎉 New Booking Request for Your Project!";
    sendSmtpEmail.htmlContent = emailContent;
    sendSmtpEmail.sender = {
      name: "Fixtract Team",
      email: process.env.FROM_EMAIL || "anafariya@gmail.com"
    };

    const response = await emailAPI.sendTransacEmail(sendSmtpEmail);
    return true;
  } catch (error: any) {
    console.error('Failed to send booking notification email:', error);
    return false;
  }
};

// ============================================================
// RFQ & Quotation Emails
// ============================================================

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const buildBookingLink = (bookingId: string) =>
  `${FRONTEND_URL}/bookings/${escapeHtml(bookingId)}`;

const buildEmailButton = (href: string, label: string, color = '#667eea') => `
  <div style="text-align: center; margin: 25px 0;">
    <a href="${href}" style="background: ${color}; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
      ${escapeHtml(label)}
    </a>
  </div>
`;

const EMAIL_DEV_NO_SEND = process.env.EMAIL_DEV_NO_SEND === 'true';
const IS_DEV = process.env.NODE_ENV !== 'production';

const logDevEmail = (outcome: string, to: string, subject: string, template: string, htmlContent: string, errorMessage?: string) => {
  if (!IS_DEV) return;
  const banner = '='.repeat(80);
  console.log(`\n${banner}\n[EMAIL ${outcome}] template=${template}\n  to:      ${to}\n  subject: ${subject}${errorMessage ? `\n  error:   ${errorMessage}` : ''}\n--- BODY ---\n${htmlContent}\n--- END ---\n${banner}`);
};

const sendEmail = async (
  to: string,
  subject: string,
  htmlContent: string,
  meta: SendEmailMeta = {}
): Promise<boolean> => {
  const template = meta.template || 'unknown';

  if (EMAIL_DEV_NO_SEND) {
    logDevEmail('SKIPPED', to, subject, template, htmlContent);
    logEmail({
      to,
      subject,
      template,
      status: 'skipped',
      relatedBooking: meta.relatedBooking,
      relatedUser: meta.relatedUser,
    }).catch(err => console.error('Failed to write EmailLog:', { to, subject, template }, err));
    return true;
  }

  if (!process.env.BREVO_API_KEY) {
    const errorMessage = 'BREVO_API_KEY is not set';
    console.error(`Cannot send email "${subject}" to ${to}: ${errorMessage}`);
    logDevEmail('FAILED', to, subject, template, htmlContent, errorMessage);
    logEmail({
      to,
      subject,
      template,
      status: 'failed',
      errorMessage,
      relatedBooking: meta.relatedBooking,
      relatedUser: meta.relatedUser,
    }).catch(err => console.error('Failed to write EmailLog:', { to, subject, template }, err));
    return false;
  }

  try {
    const emailAPI = createEmailAPI();
    const sendSmtpEmail = new SendSmtpEmail();
    sendSmtpEmail.to = [{ email: to }];
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;
    sendSmtpEmail.sender = {
      name: 'Fixtract Team',
      email: process.env.FROM_EMAIL || 'noreply@fixtract.com',
    };
    await emailAPI.sendTransacEmail(sendSmtpEmail);
    logDevEmail('SENT', to, subject, template, htmlContent);
    logEmail({
      to,
      subject,
      template,
      status: 'sent',
      relatedBooking: meta.relatedBooking,
      relatedUser: meta.relatedUser,
    }).catch(err => console.error('Failed to write EmailLog:', { to, subject, template }, err));
    return true;
  } catch (error: any) {
    console.error(`Failed to send email "${subject}" to ${to}:`, error);
    logDevEmail('FAILED', to, subject, template, htmlContent, error?.message || String(error));
    logEmail({
      to,
      subject,
      template,
      status: 'failed',
      errorMessage: error?.message || String(error),
      relatedBooking: meta.relatedBooking,
      relatedUser: meta.relatedUser,
    }).catch(err => console.error('Failed to write EmailLog:', { to, subject, template }, err));
    return false;
  }
};

// Professional receives RFQ notification
export const sendRfqReceivedEmail = async (
  profEmail: string, profName: string, customerName: string, serviceType: string, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('New Request for Quote')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          You have received a new Request for Quote from <strong>${escapeHtml(customerName)}</strong> for <strong>${escapeHtml(serviceType)}</strong>.
        </p>
        <p style="color: #666; line-height: 1.6;">
          Please review the details and respond within a reasonable timeframe.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'View Request')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(profEmail, 'New Request for Quote - Fixtract', content, {
    template: 'rfq_received',
    relatedBooking: bookingId,
  });
};

// Customer notified that professional accepted RFQ
export const sendRfqAcceptedEmail = async (
  custEmail: string, custName: string, profName: string, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Your Request Has Been Accepted')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          Great news! <strong>${escapeHtml(profName)}</strong> has accepted your request and is preparing a detailed quotation for you.
        </p>
        <p style="color: #666; line-height: 1.6;">
          You will receive the quotation within 4 working days. We'll notify you as soon as it's ready.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'View Booking')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, 'Your Request Has Been Accepted - Fixtract', content, {
    template: 'rfq_accepted',
    relatedBooking: bookingId,
  });
};

// Customer notified that professional rejected RFQ
export const sendRfqRejectedEmail = async (
  custEmail: string, custName: string, profName: string, reason: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Request Update')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          Unfortunately, <strong>${escapeHtml(profName)}</strong> is unable to take on your request at this time.
        </p>
        <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          Don't worry — you can search for other professionals on Fixtract who can help with your project.
        </p>
        ${buildEmailButton(`${FRONTEND_URL}/search`, 'Find Other Professionals')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, 'Request Update - Fixtract', content, {
    template: 'rfq_rejected',
  });
};

// Customer receives quotation
export const sendQuotationReceivedEmail = async (
  custEmail: string, custName: string, profName: string, quotationNumber: string, amount: number, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('New Quotation Received')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(profName)}</strong> has submitted a detailed quotation for your request.
        </p>
        <div style="background: #fff; border: 2px solid #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
          <p style="color: #666; margin: 0 0 5px 0; font-size: 14px;">Quotation ${escapeHtml(quotationNumber)}</p>
          <p style="font-size: 28px; font-weight: bold; color: #667eea; margin: 0;">&euro;${amount.toFixed(2)}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          Review the full details including scope, warranty, materials, and payment schedule.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'Review Quotation')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, `Quotation ${quotationNumber} Received - Fixtract`, content, {
    template: 'quotation_received',
    relatedBooking: bookingId,
  });
};

// Customer receives updated quotation
export const sendQuotationUpdatedEmail = async (
  custEmail: string, custName: string, profName: string, quotationNumber: string, version: number, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Quotation Updated')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(profName)}</strong> has updated quotation <strong>${escapeHtml(quotationNumber)}</strong> (version ${version}).
        </p>
        <p style="color: #666; line-height: 1.6;">
          Please review the updated details and changes.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'Review Updated Quotation')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, `Quotation ${quotationNumber} Updated - Fixtract`, content, {
    template: 'quotation_updated',
    relatedBooking: bookingId,
  });
};

// Professional notified that customer accepted quotation
export const sendQuotationAcceptedEmail = async (
  profEmail: string, profName: string, custName: string, quotationNumber: string, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Quotation Accepted!')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Congratulations ${escapeHtml(profName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(custName)}</strong> has accepted your quotation <strong>${escapeHtml(quotationNumber)}</strong>. Payment is being processed.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'View Booking', '#4CAF50')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(profEmail, `Quotation ${quotationNumber} Accepted - Fixtract`, content, {
    template: 'quotation_accepted',
    relatedBooking: bookingId,
  });
};

// Professional notified that customer rejected quotation
export const sendQuotationRejectedEmail = async (
  profEmail: string, profName: string, custName: string, quotationNumber: string, reason: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Quotation Feedback')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(custName)}</strong> has requested changes to quotation <strong>${escapeHtml(quotationNumber)}</strong>.
        </p>
        <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Feedback:</strong> ${escapeHtml(reason)}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          You can revise and resubmit your quotation based on the customer's feedback.
        </p>
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(profEmail, `Quotation Feedback - ${quotationNumber} - Fixtract`, content, {
    template: 'quotation_rejected',
  });
};

// Professional receives RFQ deadline reminder
export const sendRfqDeadlineReminderEmail = async (
  profEmail: string, profName: string, daysRemaining: number, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Quotation Deadline Reminder')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          This is a reminder that you have <strong>${daysRemaining} working day${daysRemaining !== 1 ? 's' : ''}</strong> remaining to submit your quotation.
        </p>
        <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;">
            If no quotation is submitted by the deadline, the request will be automatically cancelled.
          </p>
        </div>
        ${buildEmailButton(buildBookingLink(bookingId), 'Submit Quotation')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(profEmail, 'Quotation Deadline Reminder - Fixtract', content, {
    template: 'rfq_deadline_reminder',
    relatedBooking: bookingId,
  });
};

// Both parties notified about expired RFQ deadline
export const sendRfqDeadlineExpiredEmail = async (
  profEmail: string, profName: string, custEmail: string, custName: string, bookingId: string
): Promise<boolean> => {
  // Send to professional
  const profContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Quotation Deadline Expired')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          The deadline to submit your quotation has passed and the request has been automatically cancelled.
        </p>
        ${getEmailFooter()}
      </div>
    </div>
  `;
  // Send to customer
  const custContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Request Update')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          Unfortunately, the professional did not submit a quotation within the required timeframe. Your request has been cancelled.
        </p>
        <p style="color: #666; line-height: 1.6;">
          You can search for other professionals on Fixtract who can help with your project.
        </p>
        ${buildEmailButton(`${FRONTEND_URL}/search`, 'Find Other Professionals')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  const meta = { template: 'rfq_deadline_expired', relatedBooking: bookingId };
  const [profResult, custResult] = await Promise.all([
    sendEmail(profEmail, 'Quotation Deadline Expired - Fixtract', profContent, meta),
    sendEmail(custEmail, 'Request Update - Fixtract', custContent, meta),
  ]);
  if (!profResult) {
    console.error(`[Email] Failed to send RFQ deadline expired email to professional: ${profEmail}`);
  }
  if (!custResult) {
    console.error(`[Email] Failed to send RFQ deadline expired email to customer: ${custEmail}`);
  }
  return profResult && custResult;
};

// Customer receives direct quotation from professional
export const sendDirectQuotationEmail = async (
  custEmail: string, custName: string, profName: string, quotationNumber: string, amount: number, bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('You Received a Quotation')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(profName)}</strong> has sent you a quotation.
        </p>
        <div style="background: #fff; border: 2px solid #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
          <p style="color: #666; margin: 0 0 5px 0; font-size: 14px;">Quotation ${escapeHtml(quotationNumber)}</p>
          <p style="font-size: 28px; font-weight: bold; color: #667eea; margin: 0;">&euro;${amount.toFixed(2)}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          Review the full details and accept or request changes.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'Review Quotation')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, `Quotation from ${profName} - Fixtract`, content, {
    template: 'direct_quotation',
    relatedBooking: bookingId,
  });
};

// ============================================================
// Booking Lifecycle Emails
// ============================================================

const formatCurrency = (amount: number, currency = 'EUR'): string => {
  const safe = Number.isFinite(amount) ? amount : 0;
  const code = String(currency).trim().toUpperCase();
  if (code === 'EUR') return `&euro;${safe.toFixed(2)}`;
  return `${escapeHtml(code)} ${safe.toFixed(2)}`;
};

const formatDateTime = (value: Date | string | null | undefined): string => {
  if (!value) return 'TBD';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return 'TBD';
  return d.toLocaleString('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

// Payment confirmed → both parties
export const sendPaymentConfirmedEmail = async (
  custEmail: string,
  profEmail: string,
  custName: string,
  profName: string,
  amount: number,
  bookingId: string,
  currency: string = 'EUR'
): Promise<boolean> => {
  const link = buildBookingLink(bookingId);
  const custContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Payment Confirmed')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          Your payment for the booking with <strong>${escapeHtml(profName)}</strong> has been confirmed.
        </p>
        <div style="background: #fff; border: 2px solid #16a34a; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
          <p style="color: #666; margin: 0 0 5px 0; font-size: 14px;">Amount Paid</p>
          <p style="font-size: 28px; font-weight: bold; color: #16a34a; margin: 0;">${formatCurrency(amount, currency)}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          You can track the booking, message the professional, and view the schedule in your bookings dashboard.
        </p>
        ${buildEmailButton(link, 'View Booking', '#16a34a')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  const profContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Booking Payment Received')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(custName)}</strong> has paid for the booking. The booking is now confirmed and ready to schedule.
        </p>
        <div style="background: #fff; border: 2px solid #16a34a; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
          <p style="color: #666; margin: 0 0 5px 0; font-size: 14px;">Amount</p>
          <p style="font-size: 28px; font-weight: bold; color: #16a34a; margin: 0;">${formatCurrency(amount, currency)}</p>
        </div>
        ${buildEmailButton(link, 'View Booking', '#16a34a')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  const meta = { template: 'payment_confirmed', relatedBooking: bookingId };
  const [custOk, profOk] = await Promise.all([
    sendEmail(custEmail, 'Payment Confirmed - Fixtract', custContent, meta),
    sendEmail(profEmail, 'Booking Payment Received - Fixtract', profContent, meta),
  ]);
  return custOk && profOk;
};

// Booking scheduled → customer
export const sendBookingScheduledEmail = async (
  custEmail: string,
  custName: string,
  profName: string,
  scheduledStart: Date | string | null | undefined,
  bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Your Booking Is Scheduled')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(profName)}</strong> has scheduled your booking.
        </p>
        <div style="background: #e8f4fd; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Scheduled Start:</strong> ${escapeHtml(formatDateTime(scheduledStart))}</p>
        </div>
        ${buildEmailButton(buildBookingLink(bookingId), 'View Booking')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, 'Your Booking Is Scheduled - Fixtract', content, {
    template: 'booking_scheduled',
    relatedBooking: bookingId,
  });
};

// Reschedule requested → customer
export const sendRescheduleRequestedEmail = async (
  custEmail: string,
  custName: string,
  profName: string,
  oldDate: Date | string | null | undefined,
  newDate: Date | string | null | undefined,
  reason: string,
  bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Rescheduling Request')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(profName)}</strong> has requested to reschedule your booking.
        </p>
        <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0 0 8px 0;"><strong>Original Start:</strong> ${escapeHtml(formatDateTime(oldDate))}</p>
          <p style="color: #333; margin: 0 0 8px 0;"><strong>Proposed Start:</strong> ${escapeHtml(formatDateTime(newDate))}</p>
          <p style="color: #333; margin: 0;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          Please review and accept or decline this request from your booking page.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'Review Request', '#ffc107')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, 'Rescheduling Request - Fixtract', content, {
    template: 'reschedule_requested',
    relatedBooking: bookingId,
  });
};

// Reschedule accepted/declined → professional (the requester)
export const sendRescheduleResolvedEmail = async (
  profEmail: string,
  profName: string,
  action: 'accept' | 'decline',
  responseNote: string | undefined,
  bookingId: string
): Promise<boolean> => {
  const accepted = action === 'accept';
  const title = accepted ? 'Reschedule Accepted' : 'Reschedule Declined';
  const color = accepted ? '#16a34a' : '#dc2626';
  const safeNote = responseNote ? escapeHtml(responseNote) : '';
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader(title)}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          The customer has <strong>${accepted ? 'accepted' : 'declined'}</strong> your rescheduling request.
        </p>
        ${safeNote ? `<div style="background: #fff; border-left: 4px solid ${color}; padding: 15px; margin: 20px 0;"><p style="color: #333; margin: 0;"><strong>Customer note:</strong> ${safeNote}</p></div>` : ''}
        ${buildEmailButton(buildBookingLink(bookingId), 'View Booking', color)}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(profEmail, `${title} - Fixtract`, content, {
    template: accepted ? 'reschedule_accepted' : 'reschedule_declined',
    relatedBooking: bookingId,
  });
};

// Booking cancelled → both parties
export const sendBookingCancelledEmail = async (
  custEmail: string,
  profEmail: string,
  custName: string,
  profName: string,
  reason: string,
  cancelledBy: 'customer' | 'professional' | 'admin',
  bookingId: string
): Promise<boolean> => {
  const link = buildBookingLink(bookingId);
  const safeReason = escapeHtml(reason || 'No reason provided');
  const cancelledByLabel = cancelledBy === 'customer' ? 'the customer' : cancelledBy === 'professional' ? 'the professional' : 'an administrator';
  const buildContent = (greeting: string, body: string) => `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Booking Cancelled')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">${greeting}</h2>
        <p style="color: #666; line-height: 1.6;">${body}</p>
        <div style="background: #fee2e2; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Reason:</strong> ${safeReason}</p>
        </div>
        ${buildEmailButton(link, 'View Booking', '#dc2626')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  const custContent = buildContent(
    `Hello ${escapeHtml(custName)},`,
    `Your booking with <strong>${escapeHtml(profName)}</strong> has been cancelled by ${cancelledByLabel}.`
  );
  const profContent = buildContent(
    `Hello ${escapeHtml(profName)},`,
    `The booking with <strong>${escapeHtml(custName)}</strong> has been cancelled by ${cancelledByLabel}.`
  );
  const meta = { template: 'booking_cancelled', relatedBooking: bookingId };
  const [custOk, profOk] = await Promise.all([
    sendEmail(custEmail, 'Booking Cancelled - Fixtract', custContent, meta),
    sendEmail(profEmail, 'Booking Cancelled - Fixtract', profContent, meta),
  ]);
  return custOk && profOk;
};

// Refund processed → customer
export const sendRefundProcessedEmail = async (
  custEmail: string,
  custName: string,
  refundAmount: number,
  currency: string,
  isPartial: boolean,
  bookingId: string
): Promise<boolean> => {
  const title = isPartial ? 'Partial Refund Processed' : 'Refund Processed';
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader(title)}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          A ${isPartial ? 'partial ' : ''}refund has been processed for your booking.
        </p>
        <div style="background: #fff; border: 2px solid #16a34a; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
          <p style="color: #666; margin: 0 0 5px 0; font-size: 14px;">Refund Amount</p>
          <p style="font-size: 28px; font-weight: bold; color: #16a34a; margin: 0;">${formatCurrency(refundAmount, currency)}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          The refund should appear on your original payment method within 5-10 business days, depending on your bank.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'View Booking', '#16a34a')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, `${title} - Fixtract`, content, {
    template: isPartial ? 'refund_partial' : 'refund_processed',
    relatedBooking: bookingId,
  });
};

// Professional marked completion → customer
export const sendProfessionalCompletedEmail = async (
  custEmail: string,
  custName: string,
  profName: string,
  extraCostTotal: number,
  bookingId: string,
  currency: string = 'EUR'
): Promise<boolean> => {
  const hasExtras = extraCostTotal > 0;
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Work Completed — Please Confirm')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(profName)}</strong> has marked the work as complete and is awaiting your confirmation.
        </p>
        ${hasExtras ? `
        <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Extra costs declared:</strong> ${formatCurrency(extraCostTotal, currency)}</p>
          <p style="color: #666; margin: 8px 0 0 0; font-size: 14px;">You can review the breakdown and accept or dispute it on your booking page.</p>
        </div>` : ''}
        <p style="color: #666; line-height: 1.6;">
          Please review the work and confirm completion so that the professional can be paid.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'Review & Confirm', '#16a34a')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, 'Work Completed — Please Confirm - Fixtract', content, {
    template: 'professional_completed',
    relatedBooking: bookingId,
  });
};

// Customer confirmed completion → professional
export const sendCustomerConfirmedCompletionEmail = async (
  profEmail: string,
  profName: string,
  custName: string,
  bookingId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Booking Confirmed Complete')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(custName)}</strong> has confirmed the work is complete. Great job!
        </p>
        <p style="color: #666; line-height: 1.6;">
          Payout will be released according to your payout schedule.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'View Booking', '#16a34a')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(profEmail, 'Booking Confirmed Complete - Fixtract', content, {
    template: 'customer_confirmed_completion',
    relatedBooking: bookingId,
  });
};

// Dispute raised → professional + admin
export const sendDisputeRaisedEmail = async (
  profEmail: string,
  adminEmail: string,
  profName: string,
  custName: string,
  reason: string,
  bookingId: string
): Promise<boolean> => {
  const link = buildBookingLink(bookingId);
  const safeReason = escapeHtml(reason || 'No reason provided');
  const profContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Dispute Raised')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(custName)}</strong> has raised a dispute on your booking.
        </p>
        <div style="background: #fee2e2; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Reason:</strong> ${safeReason}</p>
        </div>
        <p style="color: #666; line-height: 1.6;">
          Our admin team will review the dispute and may reach out for additional information.
        </p>
        ${buildEmailButton(link, 'View Booking', '#dc2626')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  const adminContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('New Dispute — Action Required')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">A new dispute has been raised.</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(custName)}</strong> raised a dispute against <strong>${escapeHtml(profName)}</strong>.
        </p>
        <div style="background: #fee2e2; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Reason:</strong> ${safeReason}</p>
        </div>
        ${buildEmailButton(link, 'Review Dispute', '#dc2626')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  const meta = { template: 'dispute_raised', relatedBooking: bookingId };
  const [profOk, adminOk] = await Promise.all([
    sendEmail(profEmail, 'Dispute Raised - Fixtract', profContent, meta),
    sendEmail(adminEmail, 'New Dispute — Action Required - Fixtract', adminContent, meta),
  ]);
  return profOk && adminOk;
};

// Dispute resolved → both parties
export const sendDisputeResolvedEmail = async (
  custEmail: string,
  profEmail: string,
  custName: string,
  profName: string,
  resolution: string,
  adjustedAmount: number | undefined,
  bookingId: string,
  currency: string = 'EUR'
): Promise<boolean> => {
  const link = buildBookingLink(bookingId);
  const safeResolution = escapeHtml(resolution || 'Closed by admin');
  const buildContent = (name: string) => `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Dispute Resolved')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(name)},</h2>
        <p style="color: #666; line-height: 1.6;">
          The dispute on the booking has been resolved by our admin team.
        </p>
        <div style="background: #e8f5e8; border-left: 4px solid #16a34a; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0 0 8px 0;"><strong>Resolution:</strong> ${safeResolution}</p>
          ${typeof adjustedAmount === 'number' && Number.isFinite(adjustedAmount) ? `<p style="color: #333; margin: 0;"><strong>Adjusted amount:</strong> ${formatCurrency(adjustedAmount, currency)}</p>` : ''}
        </div>
        ${buildEmailButton(link, 'View Booking', '#16a34a')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  const meta = { template: 'dispute_resolved', relatedBooking: bookingId };
  const [custOk, profOk] = await Promise.all([
    sendEmail(custEmail, 'Dispute Resolved - Fixtract', buildContent(custName), meta),
    sendEmail(profEmail, 'Dispute Resolved - Fixtract', buildContent(profName), meta),
  ]);
  return custOk && profOk;
};

// Warranty claim opened → professional + admin
export const sendWarrantyClaimOpenedEmail = async (
  profEmail: string,
  adminEmail: string,
  profName: string,
  custName: string,
  bookingId: string,
  claimId: string
): Promise<boolean> => {
  const link = buildBookingLink(bookingId);
  const profContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Warranty Claim Opened')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(profName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(custName)}</strong> has opened a warranty claim on a completed booking. Please review the claim details and submit a proposal as soon as possible.
        </p>
        <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Claim ID:</strong> ${escapeHtml(claimId)}</p>
        </div>
        ${buildEmailButton(link, 'Review Claim', '#ffc107')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  const adminContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('New Warranty Claim')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">A new warranty claim was opened.</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(custName)}</strong> opened a claim against <strong>${escapeHtml(profName)}</strong>.
        </p>
        <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Claim ID:</strong> ${escapeHtml(claimId)}</p>
        </div>
        ${buildEmailButton(link, 'View Claim', '#ffc107')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  const meta = { template: 'warranty_opened', relatedBooking: bookingId };
  const [profOk, adminOk] = await Promise.all([
    sendEmail(profEmail, 'Warranty Claim Opened - Fixtract', profContent, meta),
    sendEmail(adminEmail, 'New Warranty Claim - Fixtract', adminContent, meta),
  ]);
  return profOk && adminOk;
};

// Warranty proposal sent → customer
export const sendWarrantyProposalSentEmail = async (
  custEmail: string,
  custName: string,
  profName: string,
  proposalSummary: string,
  bookingId: string,
  claimId: string
): Promise<boolean> => {
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Warranty Proposal Received')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(custName)}!</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(profName)}</strong> has submitted a proposal for your warranty claim <strong>${escapeHtml(claimId)}</strong>.
        </p>
        <div style="background: #e8f4fd; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Proposal:</strong> ${escapeHtml(proposalSummary)}</p>
        </div>
        ${buildEmailButton(buildBookingLink(bookingId), 'Review Proposal')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(custEmail, 'Warranty Proposal Received - Fixtract', content, {
    template: 'warranty_proposal_sent',
    relatedBooking: bookingId,
  });
};

const ADMIN_EMAIL_FALLBACK = (): string =>
  process.env.ADMIN_NOTIFICATIONS_EMAIL || process.env.FROM_EMAIL || '';

// Cancellation request raised → admin + other party
export const sendCancellationRequestRaisedEmail = async (params: {
  bookingId: string;
  requesterName: string;
  requesterRole: 'customer' | 'professional';
  reason: string;
  otherPartyEmail?: string;
  otherPartyName?: string;
}): Promise<boolean> => {
  const { bookingId, requesterName, requesterRole, reason, otherPartyEmail, otherPartyName } = params;
  const link = buildBookingLink(bookingId);
  const safeReason = escapeHtml(reason || 'No reason provided');
  const adminEmail = ADMIN_EMAIL_FALLBACK();

  const buildContent = (greeting: string, body: string) => `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Cancellation Request')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">${greeting}</h2>
        <p style="color: #666; line-height: 1.6;">${body}</p>
        <div style="background: #fff3cd; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Reason:</strong> ${safeReason}</p>
        </div>
        ${buildEmailButton(link, 'View Booking', '#f59e0b')}
        ${getEmailFooter()}
      </div>
    </div>
  `;

  const meta = { template: 'cancellation_request_raised', relatedBooking: bookingId };

  if (!adminEmail) {
    console.error(
      '[cancellation_request_raised] ADMIN_NOTIFICATIONS_EMAIL/FROM_EMAIL not configured — admin will not be notified'
    );
    return false;
  }

  const adminContent = buildContent(
    'A cancellation request needs review',
    `<strong>${escapeHtml(requesterName)}</strong> (${escapeHtml(requesterRole)}) has requested cancellation of a booking. Please review and approve or deny.`
  );
  const adminSent = await sendEmail(
    adminEmail,
    'Cancellation Request - Fixtract Admin Review',
    adminContent,
    meta
  );

  let otherSent = true;
  if (otherPartyEmail) {
    const otherContent = buildContent(
      `Hello ${escapeHtml(otherPartyName || '')},`,
      `<strong>${escapeHtml(requesterName)}</strong> has requested cancellation of your shared booking. Our team is reviewing the request.`
    );
    otherSent = await sendEmail(
      otherPartyEmail,
      'Cancellation Request Submitted - Fixtract',
      otherContent,
      meta
    );
  }

  return adminSent && otherSent;
};

// Professional counter-offered a refund amount → customer
export const sendRefundCounterOfferEmail = async (params: {
  customerEmail: string;
  customerName: string;
  professionalName: string;
  amount: number;
  note?: string;
  bookingId: string;
  currency?: string;
}): Promise<boolean> => {
  const { customerEmail, customerName, professionalName, amount, note, bookingId, currency } = params;
  const link = buildBookingLink(bookingId);
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Refund Counter-Offer')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(customerName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          <strong>${escapeHtml(professionalName)}</strong> has proposed a refund of
          <strong>${formatCurrency(amount, currency || 'EUR')}</strong> for your booking.
        </p>
        ${note ? `<div style="background: #eef2ff; border-left: 4px solid #6366f1; padding: 15px; margin: 20px 0;"><p style="color: #333; margin: 0;">${escapeHtml(note)}</p></div>` : ''}
        <p style="color: #666; line-height: 1.6;">Open your booking to accept the offer or refuse and escalate to Fixtract.</p>
        ${buildEmailButton(link, 'Review Offer', '#6366f1')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(customerEmail, 'Refund Counter-Offer - Fixtract', content, {
    template: 'refund_counter_offer',
    relatedBooking: bookingId,
  });
};

// Refund negotiation escalated → admin (and customer notice)
export const sendRefundEscalatedEmail = async (params: {
  bookingId: string;
  reason: 'rejected' | 'refused' | 'no_response';
  customerEmail?: string;
  customerName?: string;
}): Promise<boolean> => {
  const { bookingId, reason, customerEmail, customerName } = params;
  const link = buildBookingLink(bookingId);
  const adminEmail = ADMIN_EMAIL_FALLBACK();
  const reasonText =
    reason === 'rejected' ? 'the professional rejected the refund request'
    : reason === 'refused' ? 'the customer refused the counter-offer'
    : 'the professional did not respond within 5 business days';

  const adminContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Refund Escalated')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">A refund needs Fixtract review</h2>
        <p style="color: #666; line-height: 1.6;">A refund request has been escalated because ${reasonText}.</p>
        ${buildEmailButton(link, 'View Booking', '#dc2626')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  let adminSent = true;
  if (adminEmail) {
    adminSent = await sendEmail(adminEmail, 'Refund Escalated - Fixtract Admin Review', adminContent, {
      template: 'refund_escalated',
      relatedBooking: bookingId,
    });
  } else {
    console.error('[refund_escalated] ADMIN_NOTIFICATIONS_EMAIL/FROM_EMAIL not configured — admin will not be notified');
    adminSent = false;
  }

  if (customerEmail) {
    const customerContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        ${getEmailHeader('Refund Escalated to Fixtract')}
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(customerName || 'Customer')},</h2>
          <p style="color: #666; line-height: 1.6;">Your refund request has been escalated to Fixtract for review. We'll be in touch shortly.</p>
          ${buildEmailButton(link, 'View Booking', '#dc2626')}
          ${getEmailFooter()}
        </div>
      </div>
    `;
    await sendEmail(customerEmail, 'Refund Escalated to Fixtract', customerContent, {
      template: 'refund_escalated_customer',
      relatedBooking: bookingId,
    });
  }

  return adminSent;
};

// Refund denied → requester
export const sendRefundDeniedEmail = async (params: {
  requesterEmail: string;
  requesterName: string;
  bookingId: string;
  denyReason: string;
}): Promise<boolean> => {
  const { requesterEmail, requesterName, bookingId, denyReason } = params;
  const safeReason = escapeHtml(denyReason || 'No reason provided');
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Refund Request Denied')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Hello ${escapeHtml(requesterName)},</h2>
        <p style="color: #666; line-height: 1.6;">
          After review, your cancellation/refund request has been denied. Your booking remains active.
        </p>
        <div style="background: #fee2e2; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0;">
          <p style="color: #333; margin: 0;"><strong>Reason:</strong> ${safeReason}</p>
        </div>
        ${buildEmailButton(buildBookingLink(bookingId), 'View Booking', '#dc2626')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(requesterEmail, 'Refund Request Denied - Fixtract', content, {
    template: 'refund_denied',
    relatedBooking: bookingId,
  });
};

// Dispute SLA breached → admin only
export const sendDisputeSlaBreachedEmail = async (params: {
  bookingId: string;
  raisedAt: Date;
  hoursOverdue: number;
}): Promise<boolean> => {
  const { bookingId, raisedAt, hoursOverdue } = params;
  const adminEmail = ADMIN_EMAIL_FALLBACK();
  if (!adminEmail) return false;
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader('Dispute SLA Breached')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">A dispute has missed its SLA</h2>
        <p style="color: #666; line-height: 1.6;">
          A dispute raised on <strong>${escapeHtml(raisedAt.toISOString())}</strong> is now <strong>${escapeHtml(String(Math.floor(hoursOverdue)))}</strong> hour(s) past its resolution SLA and still unresolved.
        </p>
        ${buildEmailButton(buildBookingLink(bookingId), 'Resolve Dispute', '#dc2626')}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(adminEmail, 'Dispute SLA Breached - Fixtract Admin', content, {
    template: 'dispute_sla_breached',
    relatedBooking: bookingId,
  });
};

export const sendKpiReportEmail = async (
  adminEmail: string,
  params: { from: Date; to: Date; reportUrl?: string; error?: string }
): Promise<boolean> => {
  const { from, to, reportUrl, error } = params;
  const rangeLabel = `${from.toISOString().slice(0, 10)} – ${to.toISOString().slice(0, 10)}`;
  const isError = !reportUrl;
  const subject = isError
    ? `KPI Report Failed (${rangeLabel}) - Fixtract Admin`
    : `KPI Report Ready (${rangeLabel}) - Fixtract Admin`;
  const body = isError
    ? `<p style="color: #666; line-height: 1.6;">We were unable to generate your KPI report for <strong>${escapeHtml(rangeLabel)}</strong>.</p>
       <p style="color: #666; line-height: 1.6;">Error: ${escapeHtml(error || 'Unknown error')}</p>
       <p style="color: #666; line-height: 1.6;">Please retry from the admin dashboard or contact engineering if the issue persists.</p>`
    : `<p style="color: #666; line-height: 1.6;">Your KPI report for <strong>${escapeHtml(rangeLabel)}</strong> is ready.</p>
       ${buildEmailButton(reportUrl!, 'Download Report')}
       <p style="color: #999; font-size: 12px; line-height: 1.6;">If the button doesn't work, copy this link: ${escapeHtml(reportUrl!)}</p>`;
  const content = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${getEmailHeader(isError ? 'KPI Report Failed' : 'KPI Report Ready')}
      <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2 style="color: #333; margin: 0 0 20px 0;">Fixtract KPI Report</h2>
        ${body}
        ${getEmailFooter()}
      </div>
    </div>
  `;
  return sendEmail(adminEmail, subject, content, {
    template: isError ? 'kpi_report_failed' : 'kpi_report_ready',
  });
};

