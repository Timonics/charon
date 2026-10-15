import { LedgerAppender } from '../../ledger/application/ledger-appender';
import type { Result } from '../../shared/kernel/result';
import type { DomainError } from '../../shared/kernel/domain-error';
import type { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { err, ok } from '../../shared/kernel/result';
import { parseIdempotencyKey } from '../../shared/kernel/idempotency-key';
import { serializeEscrowEvent } from './event-serializer';
import { EscrowNotFoundError } from './errors';
import type { EscrowRepository } from './ports/escrow.repository';
import type { IdempotencyStore } from '../../payments/application/ports/idempotency-store';
import { RequestInProgressError } from '../../payments/application/errors';

const IDEMPOTENCY_SCOPE = 'escrow.resolve_dispute';

export interface ResolveDisputeCommand {
  readonly escrowId: string;
  readonly idempotencyKey: string;
}

export interface ResolveDisputeResult {
  readonly escrowId: string;
  readonly state: string;
}

export interface ResolveDisputeDeps {
  readonly idempotency: IdempotencyStore;
  readonly escrows: EscrowRepository;
  readonly ledger: LedgerAppender;
  readonly unitOfWork: UnitOfWork;
}

/**
 * Resolves a dispute, returning a DISPUTED escrow to HELD so
 * release/refund flows can resume. The aggregate's `resolveDispute()`
 * enforces the legal transition; the use case is pure orchestration.
 */
export class ResolveDisputeUseCase {
  constructor(private readonly deps: ResolveDisputeDeps) {}

  async execute(
    command: ResolveDisputeCommand,
  ): Promise<Result<ResolveDisputeResult, DomainError>> {
    const idempotencyKey = parseIdempotencyKey(command.idempotencyKey);
    if (!idempotencyKey.ok) return err(idempotencyKey.error);

    const completed =
      await this.deps.idempotency.getCompleted<ResolveDisputeResult>(
        IDEMPOTENCY_SCOPE,
        idempotencyKey.value,
      );
    if (completed !== null) return ok(completed);

    const acquired = await this.deps.idempotency.acquire(
      IDEMPOTENCY_SCOPE,
      idempotencyKey.value,
    );
    if (acquired === 'in-progress') {
      return err(
        new RequestInProgressError(IDEMPOTENCY_SCOPE, idempotencyKey.value),
      );
    }

    try {
      const escrow = await this.deps.escrows.findById(command.escrowId);
      if (!escrow) {
        await this.deps.idempotency.release(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
        );
        return err(new EscrowNotFoundError(command.escrowId));
      }

      try {
        escrow.resolveDispute();
      } catch (error) {
        await this.deps.idempotency.release(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
        );
        return err(error as DomainError);
      }

      const result = await this.deps.unitOfWork.run(async (tx) => {
        const escrows = this.deps.escrows.with(tx);
        const ledger = this.deps.ledger.with(tx);
        const idempotency = this.deps.idempotency.with(tx);

        await escrows.save(escrow);
        await ledger.append(
          'Escrow',
          escrow.escrowId,
          escrow.pullEvents().map(serializeEscrowEvent),
        );

        const out: ResolveDisputeResult = {
          escrowId: escrow.escrowId,
          state: escrow.currentState,
        };
        await idempotency.complete(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
          out,
        );
        return out;
      });

      return ok(result);
    } catch (error) {
      await this.deps.idempotency
        .release(IDEMPOTENCY_SCOPE, idempotencyKey.value)
        .catch(() => undefined);
      throw error;
    }
  }
}
