import { IsArray, IsIn, IsOptional, IsString, Length } from 'class-validator';

/** FR-10.1 — the business details printed on every document. */
export class UpdateBusinessSettingsDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() @Length(0, 40) phone?: string;
  @IsOptional() @IsString() @Length(0, 254) email?: string;
  @IsOptional() @IsString() @Length(0, 200) logo?: string;
  @IsOptional() @IsString() invoiceFooter?: string;
}

/** The data groups the cleanup tool can clear. */
export const CLEANABLE = [
  'sales',
  'customers',
  'inventory',
  'suppliers',
  'expenses',
  'billClaims',
  'ledger',
  'users',
] as const;

export type Cleanable = (typeof CLEANABLE)[number];

export class CleanDataDto {
  @IsArray()
  @IsIn(CLEANABLE, { each: true })
  targets!: Cleanable[];

  /**
   * BR-43 — an exact confirmation phrase, typed by hand, before anything is
   * deleted. Absent, the request is a preview.
   */
  @IsOptional() @IsString() confirmation?: string;

  /**
   * BR-44 — the *second, different* phrase required to override the protection
   * on administrator accounts and on the caller's own account.
   */
  @IsOptional() @IsString() includeAdminsConfirmation?: string;
}
