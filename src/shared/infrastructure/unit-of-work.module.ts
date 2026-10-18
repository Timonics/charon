/**
 * UnitOfWork provider module.
 *
 * Exposes the single process-wide `UnitOfWork` (which itself
 * delegates to the lazy `getPool()` from `db.ts`) so the
 * repository modules can `imports: [UnitOfWorkModule]` instead
 * of constructing their own.
 *
 * Why a module for one provider: NestJS's DI graph needs every
 * cross-cutting dependency to be declared as a module import.
 * Wrapping the UnitOfWork in its own tiny module is the
 * conventional way to do that.
 */
import { Module } from '@nestjs/common';

import { UnitOfWork } from './unit-of-work';

@Module({
  providers: [UnitOfWork],
  exports: [UnitOfWork],
})
export class UnitOfWorkModule {}
