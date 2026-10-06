import { Schema, model, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    telegram_id: { type: Number, required: true, unique: true },
    first_name: { type: String, default: '' },
    last_name: { type: String, default: '' },
    username: { type: String },
    phone: { type: String },
    language_code: { type: String },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model('User', userSchema);
