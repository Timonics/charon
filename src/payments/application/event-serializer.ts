import type { AppendableEvent } from '../../ledger/application/ledger-appender';
import type { DomainEvent } from '../../shared/kernel/domain-event';
import { UnknownDomainEventError } from '../../shared/kernel/unknown-domain-event.error';
import {
  PaymentFailed,
  PaymentInitiated,
  PaymentSucceeded,
  RefundIssued,
} from '../domain/events';

/**
 * Flattens Payments-context domain events into JSON-safe
 * {@link AppendableEvent}s for the ledger.
 *
 * Why this exists as an explicit mapping (and not `JSON.stringify(event)`):
 * domain events carry rich value objects — `Money` holds an internal dinero
 * object with function references that neither `structuredClone` nor clean
 * JSON serialization can carry. The journaled payload must be a stable,
 * language-neutral shape (plain numbers/strings/objects), so each event
 * type gets an explicit mapping here. When events are replayed into
 * projections, these payloads are the contract.
 *
 * The default case throws {@link UnknownDomainEventError} on purpose: a new
 * event type without a serializer must fail at development time, never
 * write a half-empty entry into the audit log.
 */
export function serializePaymentEvent(event: DomainEvent): AppendableEvent {
  if (event instanceof PaymentInitiated) {
    return {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: {
        intentId: event.intentId,
        // Money is journaled as its DB-native snapshot: integer minor units
        // + currency code — the exact shape persistence stores.
        amount: event.amount.toSnapshot(),
        method: event.method,
        provider: event.provider,
        idempotencyKey: event.idempotencyKey,
      },
    };
  }

  if (event instanceof PaymentSucceeded) {
    return {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: {
        intentId: event.intentId,
        amount: event.amount.toSnapshot(),
        providerChargeRef: event.providerChargeRef,
      },
    };
  }

  if (event instanceof PaymentFailed) {
    return {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: {
        intentId: event.intentId,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      },
    };
  }

  if (event instanceof RefundIssued) {
    return {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: {
        intentId: event.intentId,
        amount: event.amount.toSnapshot(),
        refundedToDate: event.refundedToDate.toSnapshot(),
      },
    };
  }

  throw new UnknownDomainEventError(event.eventType);
}
