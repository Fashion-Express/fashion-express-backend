import { Module } from '@nestjs/common';
import { TransactionService } from '../../common/transaction';
import { ExpensesModule } from '../expenses/expenses.module';
import { BillClaimsController } from './bill-claims.controller';
import { BillClaimsService } from './bill-claims.service';

@Module({
  // BR-36 — approval creates an expense through the same service the expenses
  // module uses, so the ledger posting happens once, in one place.
  imports: [ExpensesModule],
  controllers: [BillClaimsController],
  providers: [BillClaimsService, TransactionService],
})
export class BillClaimsModule {}
