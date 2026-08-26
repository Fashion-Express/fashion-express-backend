import { Module } from '@nestjs/common';
import { TransactionService } from '../../common/transaction';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

@Module({
  controllers: [SuppliersController],
  providers: [SuppliersService, TransactionService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
