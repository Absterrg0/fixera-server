import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Request } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'fixera-uploads';

const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

// Configure multer for memory storage
const storage = multer.memoryStorage();

// File filter for ID proofs (images and PDFs only)
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimeTypes = [
    ...ALLOWED_IMAGE_MIMES,
    'application/pdf',
    'video/mp4',
    'video/quicktime',
    'video/x-msvideo',
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Allowed: JPEG, PNG, WebP, PDF, MP4, MOV, AVI'));
  }
};

// Multer configuration
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit (for videos)
  },
});

// Dedicated multer for review images (images only, 5MB limit)
const reviewImageFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, and WebP images are allowed for reviews'));
  }
};

const rfqFileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimeTypes = [
    ...ALLOWED_IMAGE_MIMES,
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Allowed: JPEG, PNG, WebP, PDF, TXT, DOC, DOCX, XLS, XLSX'));
  }
};

export const rfqUpload = multer({
  storage,
  fileFilter: rfqFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

export const uploadReviewImages = multer({
  storage,
  fileFilter: reviewImageFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const profileImageFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, and WebP images are allowed for profile images'));
  }
};

export const uploadProfileImage = multer({
  storage,
  fileFilter: profileImageFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

// Generate unique filename
export const generateFileName = (originalName: string, userId: string, type: string): string => {
  const ext = path.extname(originalName);
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  return `${type}/${userId}/${timestamp}-${randomString}${ext}`;
};

// Upload file to S3
export const uploadToS3 = async (
  file: Express.Multer.File,
  fileName: string
): Promise<{ url: string; key: string }> => {
  try {
    console.log(`📤 S3: Uploading file ${fileName} to S3...`);
    
    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
      ContentDisposition: 'inline', // Allow viewing in browser
    };

    const command = new PutObjectCommand(uploadParams);
    await s3Client.send(command);

    const fileUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${fileName}`;
    
    console.log(`✅ S3: File uploaded successfully - ${fileUrl}`);
    
    return {
      url: fileUrl,
      key: fileName
    };
  } catch (error) {
    console.error('❌ S3: Upload failed:', error);
    throw new Error('Failed to upload file to S3');
  }
};

// Upload an arbitrary buffer to S3 (used for generated reports, PDFs, etc.)
export const uploadBufferToS3 = async (
  buffer: Buffer,
  key: string,
  contentType: string,
  contentDisposition: string = 'inline'
): Promise<string> => {
  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ContentDisposition: contentDisposition,
    });
    await s3Client.send(command);
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${encodedKey}`;
  } catch (error) {
    console.error('S3 buffer upload failed:', error);
    throw new Error('Failed to upload buffer to S3');
  }
};

// Delete file from S3
export const deleteFromS3 = async (key: string): Promise<void> => {
  try {
    console.log(`🗑️ S3: Deleting file ${key} from S3...`);
    
    const deleteParams = {
      Bucket: BUCKET_NAME,
      Key: key,
    };

    const command = new DeleteObjectCommand(deleteParams);
    await s3Client.send(command);
    
    console.log(`✅ S3: File deleted successfully - ${key}`);
  } catch (error) {
    console.error('❌ S3: Delete failed:', error);
    throw new Error('Failed to delete file from S3');
  }
};

// Generate presigned URL for secure file viewing
export const getPresignedUrl = async (key: string, expiresIn: number = 3600): Promise<string> => {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    return signedUrl;
  } catch (error) {
    console.error('❌ S3: Failed to generate presigned URL:', error);
    throw new Error('Failed to generate file access URL');
  }
};

// Validate file before upload
export const validateFile = (file: Express.Multer.File): { valid: boolean; error?: string } => {
  // Check file size (5MB limit)
  if (file.size > 5 * 1024 * 1024) {
    return { valid: false, error: 'File size must be less than 5MB' };
  }

  // Check file type
  const allowedMimeTypes = [...ALLOWED_IMAGE_MIMES, 'application/pdf'];
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return { valid: false, error: 'Invalid file type. Only JPEG, PNG, WebP, and PDF files are allowed' };
  }

  // Check filename
  if (!file.originalname || file.originalname.length > 255) {
    return { valid: false, error: 'Invalid filename' };
  }

  return { valid: true };
};

export const validateImageFile = (file: Express.Multer.File): { valid: boolean; error?: string } => {
  if (file.size > 5 * 1024 * 1024) {
    return { valid: false, error: 'Image must be less than 5MB' };
  }
  if (!ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
    return { valid: false, error: 'Invalid image type. Only JPEG, PNG, and WebP are allowed' };
  }
  return { valid: true };
};

export const ensureFileSizeUnder = (size: number, maxBytes: number): { valid: boolean; error?: string } => {
  if (size > maxBytes) {
    return { valid: false, error: `File must be less than ${Math.round(maxBytes / (1024 * 1024))}MB` };
  }
  return { valid: true };
};

export const validateImageBuffer = async (
  buffer: Buffer
): Promise<{ valid: boolean; error?: string; detectedMime?: string }> => {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: 'Empty file buffer' };
  }

  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !ALLOWED_IMAGE_MIMES.includes(detected.mime)) {
    return { valid: false, error: 'File content does not match an allowed image type (JPEG, PNG, WebP)' };
  }

  return { valid: true, detectedMime: detected.mime };
};

export const validateImageFileBuffer = async (
  file: Express.Multer.File,
  maxBytes: number = 5 * 1024 * 1024
): Promise<{ valid: boolean; error?: string; detectedMime?: string }> => {
  const sizeCheck = ensureFileSizeUnder(file.size, maxBytes);
  if (!sizeCheck.valid) return sizeCheck;

  const bufferCheck = await validateImageBuffer(file.buffer);
  if (!bufferCheck.valid) return bufferCheck;

  file.mimetype = bufferCheck.detectedMime!;
  return { valid: true, detectedMime: bufferCheck.detectedMime };
};

// Validate video file
export const validateVideoFile = (file: Express.Multer.File): { valid: boolean; error?: string } => {
  if (file.size > 50 * 1024 * 1024) {
    return { valid: false, error: 'Video must be less than 50MB' };
  }
  const allowedVideoTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
  if (!allowedVideoTypes.includes(file.mimetype)) {
    return { valid: false, error: 'Invalid video type. Use MP4, MOV, or AVI' };
  }
  return { valid: true };
};

// Validate certification file
export const validateCertificationFile = (file: Express.Multer.File): { valid: boolean; error?: string } => {
  if (file.size > 10 * 1024 * 1024) {
    return { valid: false, error: 'Certification must be less than 10MB' };
  }
  if (file.mimetype !== 'application/pdf' && !ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
    return { valid: false, error: 'Certification must be PDF or image' };
  }
  return { valid: true };
};

// Upload project file
export const uploadProjectFile = async (
  file: Express.Multer.File,
  userId: string,
  projectId: string,
  fileType: 'image' | 'video' | 'certification' | 'attachment'
): Promise<{ url: string; key: string }> => {
  const fileName = generateFileName(file.originalname, userId, `projects/${projectId}/${fileType}`);
  return uploadToS3(file, fileName);
};

// Helper to parse S3 object key from the stored URL
export const parseS3KeyFromUrl = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname;
  } catch {
    return null;
  }
};

export const TRUSTED_S3_HOST_RE = new RegExp(
  `^${(BUCKET_NAME).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.s3\\.([a-z0-9-]+\\.)?amazonaws\\.com$`,
  'i'
);

export const ALLOWED_KEY_PREFIXES = [
  'profile-images/',
  'id-proofs/',
  'certifications/',
  'project-images/',
  'project-videos/',
  'project-attachments/',
  'projects/',
  'review-images/',
  'reviews/',
  'warranty-claims/',
  'rfq-attachments/',
  'quotation-attachments/',
  'completion-attachments/',
  'cms/',
];

export const isAllowedS3Url = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (!TRUSTED_S3_HOST_RE.test(parsed.hostname)) return false;
    const key = parseS3KeyFromUrl(url);
    if (!key) return false;
    return ALLOWED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
  } catch {
    return false;
  }
};

export const presignS3Url = async (url: string, expiresIn = 7 * 24 * 60 * 60): Promise<string | null> => {
  if (!isAllowedS3Url(url)) return null;
  const key = parseS3KeyFromUrl(url);
  if (!key) return null;
  try {
    return await getPresignedUrl(key, expiresIn);
  } catch {
    return null;
  }
};
