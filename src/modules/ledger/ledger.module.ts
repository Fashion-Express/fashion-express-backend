import { Global, Module } from '@nestjs/common';
import { TransactionService } from '../../common/transaction';
import { ExpensesModule } from '../expenses/expenses.module';
import { LedgerController } from './ledger.controller';
import { LedgerRebuildService } from './ledger-rebuild.service';
import { LedgerService } from './ledger.service';

/**
 * Global because every money path posts to the ledger (BR-38) — threading an
 * import through each of them would be noise.
 */
@Global()
@Module({
  imports: [ExpensesModule],
  controllers: [LedgerController],
  providers: [LedgerService, LedgerRebuildService, TransactionService],
  exports: [LedgerService],
})
export class LedgerModule {}
