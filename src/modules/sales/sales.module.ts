import { Module } from '@nestjs/common';
import { TransactionService } from '../../common/transaction';
import { InventoryModule } from '../inventory/inventory.module';
import { CustomerPaymentsService } from './customer-payments.service';
import { FinalisationService } from './finalisation.service';
import { SalePaymentsService } from './sale-payments.service';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  // Finalisation writes stock movements through the same service inventory
  // edits use, so BR-25's "only the system writes movements" stays true of one
  // writer rather than two.
  imports: [InventoryModule],
  controllers: [SalesController],
  providers: [
    SalesService,
    SalePaymentsService,
    FinalisationService,
    CustomerPaymentsService,
    TransactionService,
  ],
  exports: [SalesService],
})
export class SalesModule {}
