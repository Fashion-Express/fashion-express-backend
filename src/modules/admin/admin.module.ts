import { Module } from '@nestjs/common';
import { TransactionService } from '../../common/transaction';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  controllers: [AdminController],
  providers: [AdminService, TransactionService],
})
export class AdminModule {}
