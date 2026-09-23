import { LedgerAppender } from '../../ledger/application/ledger-appender';
import { err, ok, type Result } from '../../shared/kernel/result';
import { parseIdempotencyKey } from '../../shared/kernel/idempotency-key';
import { Money } from '../../shared/kernel/money';
import type { ProviderName } from '../../shared/kernel/provider-name';
import type { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { DomainError } from '../../shared/kernel/domain-error';
import { PaymentIntent } from '../domain/payment-intent';
import { parsePaymentMethod } from '../domain/payment-method';
import {
  routePayment,
  type CardOrigin,
  type RoutingRules,
} from '../domain/payment-router';
import { serializePaymentEvent } from './event-serializer';
import { RequestInProgressError } from './errors';
import type { IdempotencyStore } from './ports/idempotency-store';
import type { PaymentIntentRepository } from './ports/payment-intent.repository';

/**
 * Scope separating idempotency keys per command type. Two different commands
 * may legitimately reuse the same client-generated key; scoping prevents a
 * refund key from suppressing a charge with the same string.
 */
const IDEMPOTENCY_SCOPE = 'payments.initiate';

/**
 * Input to {@link InitiatePaymentUseCase.execute}. Raw strings/numbers on
 * purpose: validation lives HERE (application boundary), not in the domain
 * and not in the HTTP layer — the domain gets only already-validated value
 * objects, and the interface layer gets a single well-defined error shape.
 */
export interface InitiatePaymentCommand {
  /** Integer minor units (kobo/cents) — never a float. */
  readonly amountMinor: number;
  /** ISO 4217 code, e.g. 'NGN'. */
  readonly currency: string;
  /** 'card' | 'bank_transfer' | 'ussd' | 'mobile_money'. */
  readonly method: string;
  /** Caller-generated key; replays return the cached result. */
  readonly idempotencyKey: string;
  readonly customerRef?: string;
  readonly description?: string;
  /** Optional BIN-derived hint used only for card routing. */
  readonly cardOrigin?: CardOrigin;
}

/** Plain-data result, safe to return over HTTP and to cache for replay. */
export interface InitiatePaymentResult {
  readonly intentId: string;
  readonly status: string;
  readonly provider: ProviderName;
  readonly amountMinor: number;
  readonly currency: string;
  readonly method: string;
}

export interface InitiatePaymentDeps {
  readonly idempotency: IdempotencyStore;
  readonly intents: PaymentIntentRepository;
  readonly ledger: LedgerAppender;
  /** Overridable in tests; defaults to production routing rules. */
  readonly routingRules?: RoutingRules;
  /**
   * Wraps the persistence portion of the use case in a single database
   * transaction. The intent snapshot save, the ledger journal append, and
   * the idempotency completion all commit together (or all roll back) so
   * a partial failure cannot leave the journal and the snapshot
   * inconsistent. Acquiring the idempotency key still happens OUTSIDE the
   * transaction — see the pipeline below for the exact ordering.
   */
  readonly unitOfWork: UnitOfWork;
}

/**
 * The InitiatePayment use case: the ONLY way a payment enters the system.
 *
 * Ordered pipeline — each step's failure mode is deliberate:
 *
 *  1. Validate boundary inputs (idempotency key, method, money). Invalid
 *     input fails before we touch the idempotency store, so a malformed
 *     request never pins its key.
 *  2. Replay check: a completed key returns the stored result — the
 *     client-visible half of "idempotency by default".
 *  3. Acquire the key: a concurrent duplicate is rejected with
 *     {@link RequestInProgressError} instead of being executed twice.
 *  4. Route to a provider (pure domain function).
 *  5. Create the aggregate (emits PaymentInitiated).
 *  6. Persist aggregate snapshot + drained events to the ledger.
 *  7. Complete the key so future calls replay.
 *
 * Failure handling: steps 4–6 run under try/finally semantics — on ANY
 * failure the key is released so a later retry can re-execute (correct,
 * because a released key means no side effects were committed; the Postgres
 * implementation must make step 6 transactional so that invariant holds).
 */
export class InitiatePaymentUseCase {
  constructor(private readonly deps: InitiatePaymentDeps) {}

  async execute(
    command: InitiatePaymentCommand,
  ): Promise<Result<InitiatePaymentResult, DomainError>> {
    // --- Step 1: validate at the application boundary --------------------
    const idempotencyKey = parseIdempotencyKey(command.idempotencyKey);
    if (!idempotencyKey.ok) return err(idempotencyKey.error);

    const method = parsePaymentMethod(command.method);
    if (!method.ok) return err(method.error);

    let amount: Money;
    try {
      amount = Money.of(command.amountMinor, command.currency);
    } catch (error) {
      return err(error as DomainError);
    }

    // --- Step 2: replay — same key, already completed --------------------
    const completed =
      await this.deps.idempotency.getCompleted<InitiatePaymentResult>(
        IDEMPOTENCY_SCOPE,
        idempotencyKey.value,
      );
    if (completed !== null) {
      return ok(completed);
    }

    // --- Step 3: concurrency gate ----------------------------------------
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
      // --- Step 4: route ---------------------------------------------------
      const routed = routePayment(
        { amount, method: method.value, cardOrigin: command.cardOrigin },
        this.deps.routingRules,
      );
      if (!routed.ok) {
        await this.deps.idempotency.release(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
        );
        return err(routed.error);
      }

      // --- Step 5: create the aggregate ------------------------------------
      const intent = PaymentIntent.create({
        amount,
        method: method.value,
        provider: routed.value,
        idempotencyKey: idempotencyKey.value,
        customerRef: command.customerRef,
        description: command.description,
      });

      // --- Step 6: persist state + journal + complete, all in one tx -------
      // The snapshot (repository) and the journal (ledger) must commit
      // atomically — see the port contracts. Wrapping all three writes
      // (intents.save, ledger.append, idempotency.complete) in one unit of
      // work guarantees that a failure in any one rolls the others back,
      // which is precisely what makes the "release on failure" semantics
      // correct: a released key is guaranteed to have no partial side
      // effects.
      const result = await this.deps.unitOfWork.run(async (tx) => {
        const intents = this.deps.intents.with(tx);
        const ledger = this.deps.ledger.with(tx);
        const idempotency = this.deps.idempotency.with(tx);

        await intents.save(intent);
        await ledger.append(
          'PaymentIntent',
          intent.intentId,
          intent.pullEvents().map(serializePaymentEvent),
        );

        const completed: InitiatePaymentResult = {
          intentId: intent.intentId,
          status: intent.currentStatus,
          provider: intent.provider,
          amountMinor: intent.amount.amount,
          currency: intent.amount.currency,
          method: intent.method,
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
      // Unknown failure (persistence, serialization, ...). Free the key so
      // the caller can retry; swallow release failures to preserve the
      // original error. The unit-of-work already rolled back any partial
      // writes (intent snapshot, ledger journal) — the released key is the
      // only remaining side effect to clean up.
      await this.deps.idempotency
        .release(IDEMPOTENCY_SCOPE, idempotencyKey.value)
        .catch(() => undefined);
      throw error;
    }
  }
}
