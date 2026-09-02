import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';

/**
 * FR-00.6 — a staff account carries login credentials plus employment details.
 *
 * Job position and department are chosen from managed lists (FR-12.2) and are
 * optional (FR-12.2.2); the user type is required (BR-57). Note what is *not*
 * here: `employeeId` is generated and never editable (FR-00.8), and there is no
 * privilege flag — privilege comes from the type alone (BR-56).
 */
export class CreateUserDto {
  @IsString()
  @Length(3, 30)
  // Matches better-auth's username plugin defaults; normalised to lower case on
  // write, with the typed form kept in `display_username`.
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message:
      'Username may contain only letters, numbers, dot, underscore and hyphen.',
  })
  username!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional() @IsString() @Length(0, 254) email?: string;
  @IsOptional() @IsString() @Length(0, 150) firstName?: string;
  @IsOptional() @IsString() @Length(0, 150) lastName?: string;
  @IsOptional() @IsString() @Length(0, 20) phone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() notes?: string;

  // Money as a string: NFR-01 forbids floating point anywhere in the stack, and
  // a JSON number is a float.
  @IsOptional()
  @IsNumberString(
    { no_symbols: false },
    { message: 'Salary must be a decimal string.' },
  )
  salary?: string;

  @IsOptional() @IsDateString() joinDate?: string;

  @IsNumberString() userTypeId!: string;

  @IsOptional() @IsNumberString() jobPositionId?: string;
  @IsOptional() @IsNumberString() departmentId?: string;
  @IsOptional() @IsNumberString() shopId?: string;

  /** FR-00.7 — one of the staff-scoped statuses. Defaults to `active`. */
  @IsOptional()
  @IsIn(['active', 'inactive', 'on_leave'])
  statusCode?: string;
}

/** Everything on create except the credential, which has its own endpoint. */
export class UpdateUserDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsString() @Length(0, 254) email?: string;
  @IsOptional() @IsString() @Length(0, 150) firstName?: string;
  @IsOptional() @IsString() @Length(0, 150) lastName?: string;
  @IsOptional() @IsString() @Length(0, 20) phone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsNumberString() salary?: string;
  @IsOptional() @IsDateString() joinDate?: string;
  @IsOptional() @IsNumberString() userTypeId?: string;
  @IsOptional() @IsNumberString() jobPositionId?: string;
  @IsOptional() @IsNumberString() departmentId?: string;
  @IsOptional() @IsNumberString() shopId?: string;
  @IsOptional() @IsIn(['active', 'inactive', 'on_leave']) statusCode?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class SetPasswordDto {
  @IsString() @MinLength(8) password!: string;
}

/**
 * FR-00.4 — what a role grants, replaced whole.
 *
 * The whole set is sent rather than a list of additions and removals: the
 * screen submits a complete picture of what the role should confer, so two
 * administrators editing at once cannot silently merge into a state neither of
 * them chose. Sending an empty array is legitimate — it strips the role.
 *
 * The shape check mirrors the database's own `permissions_codename_shape`
 * constraint, so a malformed codename fails with a readable message. Whether
 * each name actually EXISTS is checked in the service against the catalogue,
 * because a typo that is silently dropped would quietly under-grant a role.
 */
export class SetGrantsDto {
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[a-z][a-z0-9_]*$/, {
    each: true,
    message:
      'each permission must be a codename: lower-case letters, digits and underscores',
  })
  permissions!: string[];
}

export class ListUsersQuery {
  @IsOptional() @Type(() => Number) @IsInt() page?: number;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(['active', 'inactive', 'on_leave']) statusCode?: string;
  @IsOptional() @IsNumberString() userTypeId?: string;
  @IsOptional() @IsNumberString() shopId?: string;
}
