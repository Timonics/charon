import { LedgerAppender } from '../../ledger/application/ledger-appender';
import type { Result } from '../../shared/kernel/result';
import type { DomainError } from '../../shared/kernel/domain-error';
import type { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { err, ok } from '../../shared/kernel/result';
import { IllegalEscrowStateTransitionError } from '../domain/errors';
import { serializeEscrowEvent } from './event-serializer';
import type { EscrowRepository } from './ports/escrow.repository';

export interface ConfirmEscrowHoldCommand {
  readonly paymentIntentId: string;
  readonly providerCustodyRef: string;
}

export type ConfirmEscrowHoldResult =
  | { readonly outcome: 'HELD'; readonly escrowId: string }
  | { readonly outcome: 'ALREADY_HELD'; readonly escrowId: string }
  | { readonly outcome: 'NO_ESCROW_FOR_PAYMENT' };

export interface ConfirmEscrowHoldDeps {
  readonly escrows: EscrowRepository;
  readonly ledger: LedgerAppender;
  readonly unitOfWork: UnitOfWork;
}

/**
 * Confirms an escrow's hold once the provider's custody primitive is in
 * place — the escrow-side half of settlement. Invoked from the webhook
 * pipeline after a charge succeeds (and the provider subaccount/split has
 * been established); NOT a client-facing command.
 *
 * Deliberately has NO caller-supplied idempotency key: webhook-driven
 * commands dedupe on the provider event id via ProcessedWebhookStore at the
 * pipeline level. The second line of defense lives here — a redelivery that
 * slips past the marker (crash window) finds the escrow already HELD and is
 * absorbed as ALREADY_HELD rather than erroring.
 *
 * NO_ESCROW_FOR_PAYMENT is a normal outcome, not an error: most settled
 * payments have no escrow attached.
 */
export class ConfirmEscrowHoldUseCase {
  constructor(private readonly deps: ConfirmEscrowHoldDeps) {}

  async execute(
    command: ConfirmEscrowHoldCommand,
  ): Promise<Result<ConfirmEscrowHoldResult, DomainError>> {
    const escrow = await this.deps.escrows.findByPaymentIntentId(
      command.paymentIntentId,
    );
    if (!escrow) {
      return ok({ outcome: 'NO_ESCROW_FOR_PAYMENT' });
    }

    try {
      escrow.hold(command.providerCustodyRef);
    } catch (error) {
      if (
        error instanceof IllegalEscrowStateTransitionError &&
        escrow.currentState === 'HELD'
      ) {
        return ok({ outcome: 'ALREADY_HELD', escrowId: escrow.escrowId });
      }
      return err(error as DomainError);
    }

    await this.deps.unitOfWork.run(async (tx) => {
      const escrows = this.deps.escrows.with(tx);
      const ledger = this.deps.ledger.with(tx);
      await escrows.save(escrow);
      await ledger.append(
        'Escrow',
        escrow.escrowId,
        escrow.pullEvents().map(serializeEscrowEvent),
      );
    });
    return ok({ outcome: 'HELD', escrowId: escrow.escrowId });
  }
}
