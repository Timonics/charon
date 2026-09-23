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

const IDEMPOTENCY_SCOPE = 'escrow.release';

export interface ReleaseEscrowCommand {
  readonly escrowId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly idempotencyKey: string;
  readonly recipientRef?: string;
  readonly note?: string;
}

export interface ReleaseEscrowResult {
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

export interface ReleaseEscrowDeps {
  readonly idempotency: IdempotencyStore;
  readonly escrows: EscrowRepository;
  readonly ledger: LedgerAppender;
  readonly unitOfWork: UnitOfWork;
}

/**
 * Releases (part of) an escrowed hold — the marketplace payout step.
 *
 * Thin but deliberate orchestration: idempotency/replay semantics are
 * handled here (pipeline identical to the other use cases), while ALL money
 * rules (state guards, partial-release arithmetic, the cumulative
 * consumption invariant) stay in the {@link Escrow} aggregate — this class
 * contains no business logic of its own, and must never grow any.
 */
export class ReleaseEscrowUseCase {
  constructor(private readonly deps: ReleaseEscrowDeps) {}

  async execute(
    command: ReleaseEscrowCommand,
  ): Promise<Result<ReleaseEscrowResult, DomainError>> {
    // --- Validate ----------------------------------------------------------
    const idempotencyKey = parseIdempotencyKey(command.idempotencyKey);
    if (!idempotencyKey.ok) return err(idempotencyKey.error);

    let amount: Money;
    try {
      amount = Money.of(command.amountMinor, command.currency);
    } catch (error) {
      return err(error as DomainError);
    }

    // --- Replay -------------------------------------------------------------
    const completed =
      await this.deps.idempotency.getCompleted<ReleaseEscrowResult>(
        IDEMPOTENCY_SCOPE,
        idempotencyKey.value,
      );
    if (completed !== null) {
      return ok(completed);
    }

    // --- Acquire --------------------------------------------------------------
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
      // --- Load ---------------------------------------------------------------
      const escrow = await this.deps.escrows.findById(command.escrowId);
      if (!escrow) {
        await this.deps.idempotency.release(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
        );
        return err(new EscrowNotFoundError(command.escrowId));
      }

      // --- Domain transition (all money rules live here) ------------------------
      try {
        escrow.release(amount, command.recipientRef, command.note);
      } catch (error) {
        await this.deps.idempotency.release(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
        );
        return err(error as DomainError);
      }

      // --- Persist + journal + complete, all in one tx ----------------------
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

        const completed: ReleaseEscrowResult = {
          escrowId: escrow.escrowId,
          state: escrow.currentState,
          releasedToDate: escrow.releasedToDate.toSnapshot(),
          refundedToDate: escrow.refundedToDate.toSnapshot(),
          availableAmount: escrow.availableAmount.toSnapshot(),
        };
        await idempotency.complete(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
          completed,
        );
        return completed;
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
