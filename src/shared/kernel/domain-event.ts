import { randomUUID } from 'node:crypto';

export abstract class DomainEvent {
  abstract readonly eventType: string;

  readonly eventId: string = randomUUID();
  readonly occurredAt: Date = new Date();
}
