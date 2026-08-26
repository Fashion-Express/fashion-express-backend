import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from './config/data-source';
import { TransactionService } from './common/transaction';
import { HealthController } from './health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { BillClaimsModule } from './modules/bill-claims/bill-claims.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { CustomersModule } from './modules/customers/customers.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { ReferenceModule } from './modules/reference/reference.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SalesModule } from './modules/sales/sales.module';
import { ShopsModule } from './modules/shops/shops.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Validation lives in config/env.ts (zod) so the CLI and the app agree.
      envFilePath: ['.env'],
    }),
    TypeOrmModule.forRootAsync({
      useFactory: () => buildDataSourceOptions(),
    }),
    AuthModule,
    LedgerModule,
    ReferenceModule,
    UsersModule,
    ShopsModule,
    CustomersModule,
    SuppliersModule,
    InventoryModule,
    SalesModule,
    ExpensesModule,
    BillClaimsModule,
    DashboardModule,
    ReportsModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [TransactionService],
  exports: [TransactionService],
})
export class AppModule {}
