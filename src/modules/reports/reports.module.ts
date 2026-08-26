import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentsController, ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [ReportsController, DocumentsController],
  providers: [ReportsService, DocumentsService],
})
export class ReportsModule {}
