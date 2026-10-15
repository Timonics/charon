import { LedgerAppender } from '../../ledger/application/ledger-appender';
import type { Result } from '../../shared/kernel/result';
import type { DomainError } from '../../shared/kernel/domain-error';
import type { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { err, ok } from '../../shared/kernel/result';
import { parseIdempotencyKey } from '../../shared/kernel/idempotency-key';
import { Money } from '../../shared/kernel/money';
import { serializeEscrowEvent } from './event-serializer';
import { EscrowNotFoundError } from './errors';
import type { EscrowRepository } from './ports/escrow.repository';
import type { IdempotencyStore } from '../../payments/application/ports/idempotency-store';
import { RequestInProgressError } from '../../payments/application/errors';

const IDEMPOTENCY_SCOPE = 'escrow.refund';

export interface RefundEscrowCommand {
  readonly escrowId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly idempotencyKey: string;
  readonly note?: string;
}

export interface RefundEscrowResult {
  readonly escrowId: string;
  readonly state: string;
  readonly releasedToDate: {
    readonly amount: number;
    readonly currency: string;
  };
  readonly refundedToDate: {
    readonly amount: number;
    readonly currency: string;
  };
  readonly availableAmount: {
    readonly amount: number;
    readonly currency: string;
  };
}

export interface RefundEscrowDeps {
  readonly idempotency: IdempotencyStore;
  readonly escrows: EscrowRepository;
  readonly ledger: LedgerAppender;
  readonly unitOfWork: UnitOfWork;
}

/**
 * Refunds part of a held escrow back to the buyer. The inverse of
 * {@link ReleaseEscrowUseCase}. Same pipeline shape: validate → replay →
 * acquire → load → domain transition → persist+journal+complete in one tx.
 * All money rules (the cumulative-consumption invariant that
 * released + refunded ≤ held) live in the {@link Escrow} aggregate;
 * this class contains no business logic of its own.
 */
export class RefundEscrowUseCase {
  constructor(private readonly deps: RefundEscrowDeps) {}

  async execute(
    command: RefundEscrowCommand,
  ): Promise<Result<RefundEscrowResult, DomainError>> {
    const idempotencyKey = parseIdempotencyKey(command.idempotencyKey);
    if (!idempotencyKey.ok) return err(idempotencyKey.error);

    let amount: Money;
    try {
      amount = Money.of(command.amountMinor, command.currency);
    } catch (error) {
      return err(error as DomainError);
    }

    const completed =
      await this.deps.idempotency.getCompleted<RefundEscrowResult>(
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
        escrow.refund(amount, command.note);
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

        const out: RefundEscrowResult = {
          escrowId: escrow.escrowId,
          state: escrow.currentState,
          releasedToDate: escrow.releasedToDate.toSnapshot(),
          refundedToDate: escrow.refundedToDate.toSnapshot(),
          availableAmount: escrow.availableAmount.toSnapshot(),
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
