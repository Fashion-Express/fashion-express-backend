import { Type } from 'class-transformer';
import { ToBoolean } from '../../common/to-boolean';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class ListLedgerQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @IsIn(['credit', 'debit']) entryType?: string;
  @IsOptional()
  @IsIn(['sale_payment', 'expense', 'supplier_payment', 'other'])
  source?: string;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class RebuildLedgerQuery {
  /**
   * FR-08.3 — **preview defaults to true.** Rebuilding writes to the financial
   * record, so the safe reading of an ambiguous request is "tell me what you
   * would do". Writing takes an explicit `preview=false`.
   */
  @IsOptional() @ToBoolean() @IsBoolean() preview?: boolean;
}
