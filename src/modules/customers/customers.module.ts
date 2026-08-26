import { Module } from '@nestjs/common';
import { TransactionService } from '../../common/transaction';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService, TransactionService],
  exports: [CustomersService],
})
export class CustomersModule {}
