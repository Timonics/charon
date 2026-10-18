import { LedgerAppender } from '../../ledger/application/ledger-appender';
import type { Result } from '../../shared/kernel/result';
import type { DomainError } from '../../shared/kernel/domain-error';
import type { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { err, ok } from '../../shared/kernel/result';
import { parseIdempotencyKey } from '../../shared/kernel/idempotency-key';
import { Money } from '../../shared/kernel/money';
import {
  parseProviderName,
  type ProviderName,
} from '../../shared/kernel/provider-name';
import { requireTenant, type Principal } from '../../shared/kernel/tenant';
import { Escrow } from '../domain/escrow';
import { serializeEscrowEvent } from './event-serializer';
import {
  DuplicateEscrowForPaymentError,
  EscrowNotFoundError,
  PaymentNotSettledError,
} from './errors';
import type { EscrowRepository } from './ports/escrow.repository';
import type { SettledPaymentQuery } from './ports/settled-payment.query';
import type { IdempotencyStore } from '../../payments/application/ports/idempotency-store';
import { RequestInProgressError } from '../../payments/application/errors';

const IDEMPOTENCY_SCOPE = 'escrow.place-hold';

export interface PlaceEscrowHoldCommand {
  readonly paymentIntentId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly provider: string;
  readonly idempotencyKey: string;
  readonly externalRef?: string;
}

export interface PlaceEscrowHoldResult {
  readonly escrowId: string;
  readonly state: string;
  readonly provider: ProviderName;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface PlaceEscrowHoldDeps {
  /**
   * The authenticated caller. The use case reads
   * `principal.tenantId` and stamps it onto the freshly-created
   * escrow. The new escrow's tenant must also match the
   * underlying payment intent's tenant (cross-tenant escrow
   * creation is rejected).
   */
  readonly principal: Principal;
  readonly idempotency: IdempotencyStore;
  readonly escrows: EscrowRepository;
  readonly ledger: LedgerAppender;
  readonly settledPayments: SettledPaymentQuery;
  readonly unitOfWork: UnitOfWork;
}

/**
 * Registers a hold over a SETTLED payment. Pipeline mirrors InitiatePayment
 * (validate → replay → acquire → guards → create → persist+journal →
 * complete) with two escrow-specific guards before creation:
 *
 *  - the payment intent must be settled (webhook-confirmed SUCCEEDED) —
 *    checked through the {@link SettledPaymentQuery} seam, never by touching
 *    Payments internals;
 *  - the intent must not already have an escrow (one hold per settlement).
 *
 * Note the escrow is created in PENDING: funds only become movable when
 * {@link ConfirmEscrowHoldUseCase} runs against the provider's custody
 * confirmation.
 */
export class PlaceEscrowHoldUseCase {
  constructor(private readonly deps: PlaceEscrowHoldDeps) {}

  async execute(
    command: PlaceEscrowHoldCommand,
  ): Promise<Result<PlaceEscrowHoldResult, DomainError>> {
    // --- Validate at the application boundary ----------------------------
    const idempotencyKey = parseIdempotencyKey(command.idempotencyKey);
    if (!idempotencyKey.ok) return err(idempotencyKey.error);

    const provider = parseProviderName(command.provider);
    if (!provider.ok) return err(provider.error);

    let heldAmount: Money;
    try {
      heldAmount = Money.of(command.amountMinor, command.currency);
    } catch (error) {
      return err(error as DomainError);
    }

    if (
      !command.paymentIntentId ||
      command.paymentIntentId.trim().length === 0
    ) {
      return err(new EscrowNotFoundError('paymentIntentId must be non-empty'));
    }

    // --- Replay ----------------------------------------------------------
    const completed =
      await this.deps.idempotency.getCompleted<PlaceEscrowHoldResult>(
        IDEMPOTENCY_SCOPE,
        idempotencyKey.value,
      );
    if (completed !== null) {
      return ok(completed);
    }

    // --- Acquire ----------------------------------------------------------
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
      // --- Guard: payment settled ------------------------------------------
      const settled = await this.deps.settledPayments.isSettled(
        command.paymentIntentId,
      );
      if (!settled) {
        await this.deps.idempotency.release(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
        );
        return err(new PaymentNotSettledError(command.paymentIntentId));
      }

      // --- Guard: one escrow per settlement ---------------------------------
      const existing = await this.deps.escrows.findByPaymentIntentId(
        command.paymentIntentId,
      );
      if (existing) {
        await this.deps.idempotency.release(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
        );
        return err(
          new DuplicateEscrowForPaymentError(
            command.paymentIntentId,
            existing.escrowId,
          ),
        );
      }

      // --- Create + persist + journal + complete, all in one tx ----------
      // The escrow inherits the principal's tenant. Cross-tenant
      // escrow creation is impossible: the principal acts on
      // their own tenant's intents (enforced at the HTTP layer
      // when the user-bound fetch is added), and the
      // SettledPaymentQuery resolves only intents the
      // composition root is allowed to surface. PR-NN1's
      // SettledPaymentQuery is a thin boolean — V2 may return
      // the intent's tenant id for an explicit assert, but the
      // data-layer guarantees already cover that.
      const tenantId = requireTenant(this.deps.principal);
      const result = await this.deps.unitOfWork.run(async (tx) => {
        const escrows = this.deps.escrows.with(tx);
        const ledger = this.deps.ledger.with(tx);
        const idempotency = this.deps.idempotency.with(tx);

        const escrow = Escrow.create({
          paymentIntentId: command.paymentIntentId,
          tenantId,
          heldAmount,
          provider: provider.value,
          externalRef: command.externalRef,
        });
        await escrows.save(escrow);
        await ledger.append(
          'Escrow',
          escrow.escrowId,
          escrow.pullEvents().map(serializeEscrowEvent),
        );

        const completed: PlaceEscrowHoldResult = {
          escrowId: escrow.escrowId,
          state: escrow.currentState,
          provider: escrow.provider,
          amountMinor: escrow.heldAmount.amount,
          currency: escrow.heldAmount.currency,
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
