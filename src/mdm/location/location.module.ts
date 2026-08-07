import { Module } from '@nestjs/common';

import { LocationController } from './location.controller';
import { LocationService } from './location.service';
import { LocationValidator } from './location.validator';

@Module({
  controllers: [LocationController],
  providers: [LocationService, LocationValidator],
})
export class LocationModule {}
