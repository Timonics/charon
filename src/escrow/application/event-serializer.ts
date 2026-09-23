import type { AppendableEvent } from '../../ledger/application/ledger-appender';
import type { DomainEvent } from '../../shared/kernel/domain-event';
import { UnknownDomainEventError } from '../../shared/kernel/unknown-domain-event.error';
import {
  EscrowCancelled,
  EscrowDisputed,
  EscrowHeld,
  EscrowInitiated,
  EscrowReleased,
  EscrowRefunded,
  EscrowResolved,
} from '../domain/events';

/**
 * Flattens Escrow-context domain events into JSON-safe
 * {@link AppendableEvent}s for the ledger. Same contract and rationale as
 * the Payments serializer — see serializePaymentEvent. The journaled
 * payload shapes below are the replay contract for escrow projections.
 */
export function serializeEscrowEvent(event: DomainEvent): AppendableEvent {
  if (event instanceof EscrowInitiated) {
    return {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: {
        escrowId: event.escrowId,
        paymentIntentId: event.paymentIntentId,
        heldAmount: event.heldAmount.toSnapshot(),
        provider: event.provider,
      },
    };
  }

  if (event instanceof EscrowHeld) {
    return {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: {
        escrowId: event.escrowId,
        heldAmount: event.heldAmount.toSnapshot(),
        providerCustodyRef: event.providerCustodyRef,
      },
    };
  }

  if (event instanceof EscrowReleased) {
    return {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: {
        escrowId: event.escrowId,
        releaseId: event.releaseId,
        amount: event.amount.toSnapshot(),
        releasedToDate: event.releasedToDate.toSnapshot(),
        ...(event.recipientRef !== undefined
          ? { recipientRef: event.recipientRef }
          : {}),
      },
    };
  }

  if (event instanceof EscrowRefunded) {
    return {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: {
        escrowId: event.escrowId,
        refundId: event.refundId,
        amount: event.amount.toSnapshot(),
        refundedToDate: event.refundedToDate.toSnapshot(),
      },
    };
  }

  if (event instanceof EscrowDisputed) {
    return {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: { escrowId: event.escrowId, reason: event.reason },
    };
  }

  if (event instanceof EscrowResolved) {
    return {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: { escrowId: event.escrowId },
    };
  }

  if (event instanceof EscrowCancelled) {
    return {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: {
        escrowId: event.escrowId,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      },
    };
  }

  throw new UnknownDomainEventError(event.eventType);
}
