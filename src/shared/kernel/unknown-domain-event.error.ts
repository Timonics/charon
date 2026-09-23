import { DomainError } from './domain-error';

/**
 * Thrown by an event serializer when it receives a domain event type it
 * does not know how to flatten. Deliberately loud: an unserializable event
 * reaching the ledger would mean silent history loss. Adding a new domain
 * event REQUIRES adding its serializer case in the same change.
 *
 * Lives in the shared kernel because every bounded context that journals
 * events (Payments, Escrow, ...) needs it — it is not Payments-specific.
 */
export class UnknownDomainEventError extends DomainError {
  readonly code = 'UNKNOWN_DOMAIN_EVENT';

  constructor(eventType: string) {
    super(`No serializer registered for domain event type: ${eventType}`);
  }
}
