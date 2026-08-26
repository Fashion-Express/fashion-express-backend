import { Type } from 'class-transformer';
import { ToBoolean } from '../../common/to-boolean';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

/**
 * One DTO pair covers all twelve lists, because they share a shape (§23.1).
 * Which fields are *permitted* for a given list is decided by the registry and
 * enforced in the service — a `code` on a structural list, or a `scope` on an
 * unscoped one, is rejected there with a message naming the rule.
 */

export class CreateReferenceDto {
  /**
   * Coded lists only. Fixed once created (BR-59) — there is no update path for
   * it, on any list.
   *
   * The shape check mirrors the database's own `*_code_shape` constraint, so a
   * bad code fails with a readable message rather than a 422 from PostgreSQL.
   */
  @IsOptional()
  @IsString()
  @Length(1, 30)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message:
      'code must start with a letter and contain only lower-case letters, digits and underscores',
  })
  code?: string;

  /** Coded lists. What staff see; freely editable afterwards. */
  @IsOptional() @IsString() @Length(1, 60) label?: string;

  /** Named lists (job positions, departments, categories). */
  @IsOptional() @IsString() @Length(1, 100) name?: string;

  @IsOptional() @IsString() description?: string;

  /** Required on `statuses` and `payment-methods`; refused on the others. */
  @IsOptional() @IsString() @Length(1, 20) scope?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;

  @IsOptional() @IsBoolean() isActive?: boolean;

  /** `user-types` only — the privilege the type confers (FR-12.1.2). */
  @IsOptional() @IsBoolean() isSuperuser?: boolean;
  @IsOptional() @IsBoolean() isManager?: boolean;
}

/**
 * Note what is absent: `code` and `scope`. A code is fixed once created (BR-59)
 * because application logic and historical records are keyed on it, and a scope
 * is what keeps four independent vocabularies apart in one table — moving an
 * entry between scopes would silently re-file every record using it.
 *
 * `forbidNonWhitelisted` on the global pipe turns an attempt to send either
 * into a 400 rather than a silent ignore.
 */
export class UpdateReferenceDto {
  @IsOptional() @IsString() @Length(1, 60) label?: string;
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isSuperuser?: boolean;
  @IsOptional() @IsBoolean() isManager?: boolean;
}

export class ListReferenceQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() scope?: string;

  /**
   * Absent means every entry, active or not.
   *
   * §23.6 is explicit that inactive entries must be filtered out of *pickers*
   * but not out of reads: an item whose category was deactivated still has to
   * display that category. The administration screen therefore wants
   * everything, and only `/options` filters by default.
   */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  isActive?: boolean;
}
