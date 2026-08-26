import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import {
  attachmentFilter,
  attachmentStorage,
  resolveAttachment,
} from './attachments';
import { BillClaimsService, type ClaimRow } from './bill-claims.service';
import {
  CreateBillClaimDto,
  ListBillClaimsQuery,
  ReviewBillClaimDto,
  UpdateBillClaimDto,
} from './dto';

/** Multer's file shape, without pulling the whole namespace in. */
interface UploadedAttachment {
  filename: string;
  originalname: string;
}

const upload = FileInterceptor('attachment', {
  storage: attachmentStorage,
  fileFilter: attachmentFilter,
  // A supporting document, not a data set.
  limits: { fileSize: 10 * 1024 * 1024 },
});

/**
 * FR-07 — bill claims. Staff claim money spent on the company's behalf, a
 * manager approves or rejects, and approval writes the expense automatically.
 *
 * Two different permissions gate this: `submit_bill`/`view_my_bills` for one's
 * own claims, and `review_bills` for everyone's. Which one the caller holds is
 * what decides the scope of every list and detail read.
 */
@Controller('bill-claims')
export class BillClaimsController {
  constructor(private readonly claims: BillClaimsService) {}

  /**
   * FR-07.3 and FR-07.4 in one route.
   *
   * A staff member sees their own claims; a reviewer sees every claim from
   * every employee. The scope follows the caller's permissions rather than the
   * URL, so there is no way to ask for someone else's by changing a parameter.
   */
  @Get()
  @RequirePermission('view_my_bills')
  list(@Query() query: ListBillClaimsQuery, @CurrentUser() user: AuthUser) {
    return this.claims.list(query, user);
  }

  @Get(':id')
  @RequirePermission('view_my_bills')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ClaimRow> {
    return this.claims.findOne(id, user);
  }

  /** FR-07.2 — the supporting document, streamed from outside the app path. */
  @Get(':id/attachment')
  @RequirePermission('view_my_bills')
  async attachment(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    const claim = await this.claims.findOne(id, user);
    if (!claim.attachment) {
      res.status(404).json({ statusCode: 404, message: 'No attachment.' });
      return;
    }
    res.sendFile(resolveAttachment(claim.attachment));
  }

  /**
   * Submit a claim, optionally with a document.
   *
   * `multipart/form-data`: the fields alongside a file arrive as strings, which
   * is why the DTO takes `amount` as a decimal string anyway (NFR-01).
   */
  @Post()
  @RequirePermission('submit_bill')
  @UseInterceptors(upload)
  create(
    @Body() dto: CreateBillClaimDto,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: UploadedAttachment,
  ): Promise<ClaimRow> {
    return this.claims.create(dto, file?.filename ?? null, user);
  }

  @Patch(':id')
  @RequirePermission('submit_bill')
  @UseInterceptors(upload)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBillClaimDto,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: UploadedAttachment,
  ): Promise<ClaimRow> {
    return this.claims.update(id, dto, file?.filename ?? null, user);
  }

  /**
   * BR-36 — one action: mark approved, record the reviewer and date, create the
   * expense dated to the bill date with the employee as payee, and link the two.
   */
  @Post(':id/approve')
  @RequirePermission('review_bills')
  approve(
    @Param('id') id: string,
    @Body() dto: ReviewBillClaimDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ClaimRow> {
    return this.claims.approve(id, dto, user);
  }

  /** BR-37 — records the reviewer and the date, and creates no expense. */
  @Post(':id/reject')
  @RequirePermission('review_bills')
  reject(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ClaimRow> {
    return this.claims.reject(id, user);
  }

  /** Withdrawing a claim, possible only while it is still pending. */
  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('submit_bill')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.claims.remove(id, user);
  }
}
