import { Module } from '@nestjs/common';
import { TransactionService } from '../../common/transaction';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StockHistoryService } from './stock-history.service';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, StockHistoryService, TransactionService],
  // StockHistoryService is exported for Phase 5: finalising a sale writes
  // movements through the same writer (BR-25).
  exports: [InventoryService, StockHistoryService],
})
export class InventoryModule {}
