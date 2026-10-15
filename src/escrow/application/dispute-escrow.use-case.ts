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

const IDEMPOTENCY_SCOPE = 'escrow.dispute';

export interface DisputeEscrowCommand {
  readonly escrowId: string;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface DisputeEscrowResult {
  readonly escrowId: string;
  readonly state: string;
}

export interface DisputeEscrowDeps {
  readonly idempotency: IdempotencyStore;
  readonly escrows: EscrowRepository;
  readonly ledger: LedgerAppender;
  readonly unitOfWork: UnitOfWork;
}

/**
 * Opens a dispute on a HELD escrow, freezing it. The aggregate's
 * `dispute()` method enforces the legal-transition guard (HELD →
 * DISPUTED); the use case is pure orchestration.
 */
export class DisputeEscrowUseCase {
  constructor(private readonly deps: DisputeEscrowDeps) {}

  async execute(
    command: DisputeEscrowCommand,
  ): Promise<Result<DisputeEscrowResult, DomainError>> {
    const idempotencyKey = parseIdempotencyKey(command.idempotencyKey);
    if (!idempotencyKey.ok) return err(idempotencyKey.error);

    const completed =
      await this.deps.idempotency.getCompleted<DisputeEscrowResult>(
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
        escrow.dispute(command.reason);
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

        const out: DisputeEscrowResult = {
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
