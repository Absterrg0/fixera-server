import { Schema, model, Document } from "mongoose";

export type InvoiceSequenceKind = "invoice" | "credit_note";

export interface IInvoiceSequence extends Document {
  year: number;
  kind: InvoiceSequenceKind;
  value: number;
}

const InvoiceSequenceSchema = new Schema<IInvoiceSequence>(
  {
    year: { type: Number, required: true },
    kind: { type: String, enum: ["invoice", "credit_note"], required: true },
    value: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

InvoiceSequenceSchema.index({ year: 1, kind: 1 }, { unique: true });

const InvoiceSequence = model<IInvoiceSequence>("InvoiceSequence", InvoiceSequenceSchema);

export default InvoiceSequence;
