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

const IDEMPOTENCY_SCOPE = 'escrow.cancel';

export interface CancelEscrowCommand {
  readonly escrowId: string;
  readonly idempotencyKey: string;
  readonly reason?: string;
}

export interface CancelEscrowResult {
  readonly escrowId: string;
  readonly state: string;
}

export interface CancelEscrowDeps {
  readonly idempotency: IdempotencyStore;
  readonly escrows: EscrowRepository;
  readonly ledger: LedgerAppender;
  readonly unitOfWork: UnitOfWork;
}

/**
 * Cancels a PENDING escrow before it has been funded. Once the
 * provider has confirmed the hold (state = HELD), cancellation is no
 * longer a valid transition — funds are real and must leave via
 * release or refund.
 */
export class CancelEscrowUseCase {
  constructor(private readonly deps: CancelEscrowDeps) {}

  async execute(
    command: CancelEscrowCommand,
  ): Promise<Result<CancelEscrowResult, DomainError>> {
    const idempotencyKey = parseIdempotencyKey(command.idempotencyKey);
    if (!idempotencyKey.ok) return err(idempotencyKey.error);

    const completed =
      await this.deps.idempotency.getCompleted<CancelEscrowResult>(
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
        escrow.cancel(command.reason);
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

        const out: CancelEscrowResult = {
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
