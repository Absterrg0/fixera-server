import type { IUser } from '../models/user';

type ProfessionalLike =
  | (Pick<IUser, 'name'> & { businessInfo?: { companyName?: string } })
  | null
  | undefined;

export function getProfessionalDisplayName(
  user: ProfessionalLike,
  fallback: string = 'Professional'
): string {
  const companyName = user?.businessInfo?.companyName?.trim();
  if (companyName) return companyName;
  const name = user?.name?.trim();
  if (name) return name;
  return fallback;
}
