import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

@Module({
  imports: [AdminModule],
  controllers: [ClientsController],
  providers: [ClientsService],
})
export class ClientsModule {}
