import { Module } from '@nestjs/common';
import { TransactionService } from '../../common/transaction';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, TransactionService],
  exports: [UsersService],
})
export class UsersModule {}
