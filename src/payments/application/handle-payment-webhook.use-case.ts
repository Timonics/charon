import { LedgerAppender } from '../../ledger/application/ledger-appender';
import { NormalizedPaymentEvent } from '../../provider-integration/domain/normalized-payment-event';
import type { Result } from '../../shared/kernel/result';
import type { DomainError } from '../../shared/kernel/domain-error';
import type { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { err, ok } from '../../shared/kernel/result';
import { Money } from '../../shared/kernel/money';
import { IllegalPaymentStatusTransitionError } from '../domain/errors';
import type { PaymentIntent } from '../domain/payment-intent';
import type { PaymentStatus } from '../domain/payment-status';
import { serializePaymentEvent } from './event-serializer';
import {
  UnknownProviderReferenceError,
  UnsupportedEventTypeError,
  WebhookAmountMismatchError,
} from './errors';
import type { PaymentIntentRepository } from './ports/payment-intent.repository';
import type { ProcessedWebhookStore } from './ports/processed-webhook-store';
import type { WebhookInboxStore } from '../../provider-integration/application/ports/webhook-inbox.store';

/** What happened to the webhook; safe to log and to return to adapters. */
export type WebhookHandlingResult =
  | { readonly outcome: 'APPLIED'; readonly intentId: string }
  | { readonly outcome: 'DUPLICATE_IGNORED' }
  | { readonly outcome: 'ALREADY_IN_TARGET_STATE' };

export interface HandlePaymentWebhookDeps {
  readonly intents: PaymentIntentRepository;
  readonly ledger: LedgerAppender;
  readonly processedWebhooks: ProcessedWebhookStore;
  /**
   * Append-only inbox of every verified webhook. Written in the same
   * unit of work as the dedup marker so a SequenceGapError repair can
   * later reconstruct the ledger from this table alone. See
   * `provider-integration/application/ports/webhook-inbox.store.ts`
   * for the full rationale.
   */
  readonly webhookInbox: WebhookInboxStore;
  /**
   * Wraps the persistence portion of the handler (snapshot save + ledger
   * append + processed marker) in a single database transaction. The
   * already-in-target-state branch also writes the processed marker inside
   * the same unit of work, so a crash between marker write and response
   * cannot leave the marker out of sync with the snapshot.
   */
  readonly unitOfWork: UnitOfWork;
}

/**
 * Applies a signature-verified, normalized provider webhook to the matching
 * PaymentIntent. THIS is where settlement truth enters the system
 * (non-negotiable: state changes on verified webhooks, never on synchronous
 * API responses).
 *
 * Defenses, in order — each one is a real failure mode of provider webhooks:
 *
 *  1. DEDUPE (event id): providers retry deliveries. Identical redeliveries
 *     exit as DUPLICATE_IGNORED without touching the domain.
 *  2. RESOLUTION: the event's providerRef must resolve to exactly one
 *     internal intent. Unknown reference → rejected, not guessed at.
 *  3. AMOUNT INTEGRITY: for success events carrying an amount, it must match
 *     the intent exactly. A mismatch means something is deeply wrong; we
 *     stop rather than book foreign numbers.
 *  4. STATE MACHINE: the domain transition runs through the aggregate's
 *     guarded transitions. A genuine conflict (e.g. FAILED then a late
 *     SUCCEEDED) throws — EXCEPT the benign case where the intent is already
 *     in the event's target state, which we treat as a crash-window
 *     redelivery (processed-marker lost after the transition committed) and
 *     absorb idempotently.
 *  5. JOURNAL + MARK: intent snapshot, ledger entries, and the processed
 *     marker commit together (same atomicity contract as InitiatePayment).
 */
export class HandlePaymentWebhookUseCase {
  constructor(private readonly deps: HandlePaymentWebhookDeps) {}

  async execute(
    event: NormalizedPaymentEvent,
  ): Promise<Result<WebhookHandlingResult, DomainError>> {
    // --- Defense 1: delivery dedupe ---------------------------------------
    if (await this.deps.processedWebhooks.wasProcessed(event.eventId)) {
      return ok({ outcome: 'DUPLICATE_IGNORED' });
    }

    // --- Defense 2: reconcile to an internal intent ------------------------
    const intent = await this.deps.intents.findByProviderChargeRef(
      event.provider,
      event.providerRef,
    );
    if (!intent) {
      return err(
        new UnknownProviderReferenceError(event.provider, event.providerRef),
      );
    }

    // --- Defense 3: amount integrity ---------------------------------------
    const amountCheck = this.verifyAmountIntegrity(event, intent);
    if (!amountCheck.ok) return err(amountCheck.error);

    // --- Defense 4: guarded domain transition ------------------------------
    try {
      this.applyTransition(event, intent);
    } catch (error) {
      if (
        error instanceof IllegalPaymentStatusTransitionError &&
        this.isAlreadyInTargetState(event, intent)
      ) {
        // Crash-window redelivery: the transition committed previously but
        // the processed marker did not. Absorb idempotently inside the
        // same unit-of-work so the next retry short-circuits at Defense 1.
        await this.deps.unitOfWork.run(async (tx) => {
          const intents = this.deps.intents.with(tx);
          const ledger = this.deps.ledger.with(tx);
          const processed = this.deps.processedWebhooks.with(tx);
          const inbox = this.deps.webhookInbox.with(tx);
          // Intent snapshot is unchanged — but we re-save to keep the
          // access pattern uniform and prove the marker write commits
          // atomically with any future snapshot update.
          await intents.save(intent);
          await ledger.append(
            'PaymentIntent',
            intent.intentId,
            intent.pullEvents().map(serializePaymentEvent),
          );
          // Inbox write is idempotent on (provider, event_id); a
          // redelivery that previously wrote the inbox row is a no-op
          // here, matching the dedup marker's idempotency.
          await inbox.recordVerifiedWebhook(event);
          await processed.markProcessed(event.eventId);
        });
        return ok({ outcome: 'ALREADY_IN_TARGET_STATE' });
      }
      return err(error as DomainError);
    }

    // --- Defense 5: persist snapshot + journal + marker + inbox, atomically -
    // The inbox write belongs here, not earlier, because the inbox row
    // should reflect a verified event that the system actually acted
    // on. If a redelivery short-circuits at Defense 1 (DUPLICATE_IGNORED)
    // we deliberately do NOT write to the inbox — the original
    // delivery's row is already there.
    await this.deps.unitOfWork.run(async (tx) => {
      const intents = this.deps.intents.with(tx);
      const ledger = this.deps.ledger.with(tx);
      const processed = this.deps.processedWebhooks.with(tx);
      const inbox = this.deps.webhookInbox.with(tx);
      await intents.save(intent);
      await ledger.append(
        'PaymentIntent',
        intent.intentId,
        intent.pullEvents().map(serializePaymentEvent),
      );
      // The inbox row is what the SequenceGapError repair reads
      // back when the ledger is missing a sequence. Written here,
      // in the same UoW as the journal entry, so a crash between
      // these two lines leaves the ledger WITHOUT a row that the
      // inbox DOESN'T have — making the repair path observable.
      await inbox.recordVerifiedWebhook(event);
      await processed.markProcessed(event.eventId);
    });

    return ok({ outcome: 'APPLIED', intentId: intent.intentId });
  }

  /**
   * Maps the normalized event onto the aggregate's guarded transition
   * methods. Unhandled-but-known types (TRANSFER_*, REFUND_COMPLETED) are
   * rejected loudly — they belong to the Escrow context's handler and
   * reaching this one means a routing/configuration mistake.
   */
  private applyTransition(
    event: NormalizedPaymentEvent,
    intent: PaymentIntent,
  ): void {
    switch (event.type) {
      case 'CHARGE_SUCCEEDED':
        intent.markSucceeded();
        return;
      case 'CHARGE_FAILED':
        intent.markFailed(event.failureReason);
        return;
      default:
        throw new UnsupportedEventTypeError(
          event.type,
          'HandlePaymentWebhookUseCase',
        );
    }
  }

  /**
   * The benign-transition test for Defense 4: an illegal transition is only
   * absorbable when the intent already sits in the state this event would
   * move it to. Anything else (FAILED → SUCCEEDED, EXPIRED → SUCCEEDED, ...)
   * is a genuine conflict and must surface.
   */
  private isAlreadyInTargetState(
    event: NormalizedPaymentEvent,
    intent: PaymentIntent,
  ): boolean {
    const targetByEventType: Partial<Record<string, PaymentStatus>> = {
      CHARGE_SUCCEEDED: 'SUCCEEDED',
      CHARGE_FAILED: 'FAILED',
    };
    return intent.currentStatus === targetByEventType[event.type];
  }

  /**
   * Success events that carry an amount must agree with the intent to the
   * minor unit and the currency. Absent amounts are treated as "provider
   * did not send one" and skipped — never as zero.
   */
  private verifyAmountIntegrity(
    event: NormalizedPaymentEvent,
    intent: PaymentIntent,
  ): Result<true, DomainError> {
    if (event.type !== 'CHARGE_SUCCEEDED' || event.amountMinor === undefined) {
      return ok(true);
    }
    const webhookMoney = Money.of(
      event.amountMinor,
      event.currency ?? intent.amount.currency,
    );
    if (!webhookMoney.equals(intent.amount)) {
      return err(
        new WebhookAmountMismatchError(
          event.providerRef,
          webhookMoney.toString(),
          intent.amount.toString(),
        ),
      );
    }
    return ok(true);
  }
}
