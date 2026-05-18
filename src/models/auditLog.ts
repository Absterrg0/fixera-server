import mongoose, { Document, Schema } from 'mongoose';

export type AuditLogStatus = 'success' | 'failure';

export interface IAuditLog extends Document {
  actor?: mongoose.Types.ObjectId;
  actorRole?: string;
  actorEmail?: string;
  action: string;
  targetType?: string;
  targetId?: mongoose.Types.ObjectId;
  method: string;
  path: string;
  details?: any;
  ip?: string;
  userAgent?: string;
  status: AuditLogStatus;
  statusCode?: number;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorRole: { type: String, trim: true, maxlength: 50 },
  actorEmail: { type: String, trim: true, lowercase: true, maxlength: 320 },
  action: { type: String, required: true, trim: true, maxlength: 200, index: true },
  targetType: { type: String, trim: true, maxlength: 100 },
  targetId: { type: mongoose.Schema.Types.ObjectId },
  method: { type: String, trim: true, maxlength: 10 },
  path: { type: String, trim: true, maxlength: 500 },
  details: { type: Schema.Types.Mixed },
  ip: { type: String, trim: true, maxlength: 100 },
  userAgent: { type: String, trim: true, maxlength: 500 },
  status: { type: String, enum: ['success', 'failure'], required: true },
  statusCode: { type: Number },
  errorMessage: { type: String, trim: true, maxlength: 2000 },
}, {
  timestamps: true
});

auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ status: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);

export default AuditLog;
