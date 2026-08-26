import { Module } from '@nestjs/common';
import { TransactionService } from '../../common/transaction';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({
  controllers: [ExpensesController],
  providers: [ExpensesService, TransactionService],
  // Claim approval creates an expense as part of one action (BR-36).
  exports: [ExpensesService],
})
export class ExpensesModule {}
