import { Module } from '@nestjs/common';
import { TestSupportController } from './test-support.controller';

// TB-12.1: test-server-only routes - every one answers 404 unless the
// process was started with E2E_TEST_SUPPORT=1 outside production (see
// isTestSupportEnabled).
@Module({
  controllers: [TestSupportController],
})
export class TestSupportModule {}
