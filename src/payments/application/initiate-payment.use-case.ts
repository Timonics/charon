import { LedgerAppender } from '../../ledger/application/ledger-appender';
import { err, ok, type Result } from '../../shared/kernel/result';
import { parseIdempotencyKey } from '../../shared/kernel/idempotency-key';
import { Money } from '../../shared/kernel/money';
import type { ProviderName } from '../../shared/kernel/provider-name';
import type { Principal } from '../../shared/kernel/tenant';
import { requireTenant } from '../../shared/kernel/tenant';
import type { UnitOfWork } from '../../shared/infrastructure/unit-of-work';
import { DomainError } from '../../shared/kernel/domain-error';
import { PaymentIntent } from '../domain/payment-intent';
import { parsePaymentMethod } from '../domain/payment-method';
import {
  routePayment,
  type CardOrigin,
  type RoutingRules,
} from '../domain/payment-router';
import type { PaymentGatewayPort } from '../../provider-integration/application/ports/payment-gateway.port';
import { MissingGatewayAdapterError } from '../../provider-integration/application/errors';
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
  /**
   * Customer email — required by every supported provider's
   * charge API. Optional in the command (the boundary layer
   * decides whether it's required per payment method) but the
   * gateway adapter will surface a ProviderApiError if absent
   * when the provider requires it.
   */
  readonly customerEmail?: string;
  /**
   * Where the provider should redirect the customer after a
   * hosted payment page. Optional — some flows (Stripe client-secret
   * embeds) don't use a redirect.
   */
  readonly callbackUrl?: string;
  /** Optional BIN-derived hint used only for card routing. */
  readonly cardOrigin?: CardOrigin;
}

/** Plain-data result, safe to return over HTTP and to cache for replay. */
export interface InitiatePaymentResult {
  readonly intentId: string;
  readonly status: string;
  readonly provider: ProviderName;
  readonly providerReference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly method: string;
}

export interface InitiatePaymentDeps {
  /**
   * The authenticated caller. The use case reads
   * `principal.tenantId` and stamps it onto the freshly-created
   * intent. A principal without a tenant binding
   * (`{ kind: 'user', tenantId: null }`) throws
   * {@link UnboundPrincipalError} — V1 does not support
   * tenant-less actions.
   */
  readonly principal: Principal;
  readonly idempotency: IdempotencyStore;
  readonly intents: PaymentIntentRepository;
  readonly ledger: LedgerAppender;
  /** Overridable in tests; defaults to production routing rules. */
  readonly routingRules?: RoutingRules;
  /**
   * Map of provider → outbound gateway adapter. The use case looks up
   * the adapter by `routed.value` (the provider chosen by
   * `routePayment`). A missing entry throws
   * {@link MissingGatewayAdapterError} — that's a configuration
   * bug in the composition root, not a runtime condition.
   *
   * Why a map and not a single adapter? The composition root is
   * the only place that knows which providers are enabled in the
   * current deployment. The use case is provider-agnostic — the
   * routing step picks one and the gateway map is the contract for
   * "we know how to talk to that one."
   */
  readonly gateways: ReadonlyMap<ProviderName, PaymentGatewayPort>;
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
 *  5. Call the provider's gateway adapter. The adapter returns
 *     `providerReference` — the reconciliation key that webhook
 *     adapters will echo back. Failure here releases the
 *     idempotency key (no DB state was created) so a retry can
 *     re-execute. The webhook + `webhook_inbox` table cover the
 *     "gateway call succeeded but we never got the response" case
 *     (the charge exists in the provider, we have no internal
 *     record of it — a verification worker using `verifyCharge`
 *     picks it up from the inbox later).
 *  6. Create the aggregate in PROCESSING state with the
 *     `providerReference` set. Emits `PaymentInitiated`.
 *  7. Persist aggregate snapshot + drained events to the ledger.
 *  8. Complete the key so future calls replay.
 *
 * Failure handling: steps 4–7 run under try/finally semantics — on ANY
 * failure the key is released so a later retry can re-execute. The
 * gateway step is the one place this rule is subtle: a transport
 * failure to Paystack MIGHT have created a charge (we just never
 * got the response). Paystack's `reference` field is idempotent
 * (a retry with the same reference returns the same charge), so
 * a safe retry produces the right outcome either way. The
 * `webhook_inbox` writer preserves the receipt for cases where
 * the retry happens after a confirmation webhook has already
 * arrived.
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

      // --- Step 5: call the provider's gateway adapter --------------------
      // We look up the adapter by the routed provider. A missing
      // entry means the composition root enabled this provider in
      // routing rules without binding a gateway — that's a
      // configuration bug, hence the typed
      // MissingGatewayAdapterError rather than a generic 500.
      const gateway = this.deps.gateways.get(routed.value);
      if (!gateway) {
        await this.deps.idempotency.release(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
        );
        return err(new MissingGatewayAdapterError(routed.value));
      }

      // The `reference` Paystack echoes back in its webhooks is
      // our idempotency key — the gateway returns it verbatim. We
      // pass the same value as `customerEmail` and `callbackUrl`
      // so the adapter can POST a complete request.
      const initResult = await gateway.initializeCharge({
        reference: idempotencyKey.value,
        amountMinor: command.amountMinor,
        currency: command.currency,
        customerEmail: command.customerEmail ?? '',
        callbackUrl: command.callbackUrl,
        metadata: command.customerRef
          ? { customerRef: command.customerRef }
          : undefined,
      });
      if (!initResult.ok) {
        // Provider refused the request, or the network call
        // failed. Either way, no DB state was created. Release
        // the idempotency key so a retry can re-execute.
        await this.deps.idempotency.release(
          IDEMPOTENCY_SCOPE,
          idempotencyKey.value,
        );
        return err(initResult.error);
      }

      // --- Step 6: create the aggregate in PROCESSING state -----------
      // markProcessing sets the providerReference; the FSM
      // transitions INITIATED → PROCESSING atomically. From
      // here the intent will only transition via verified
      // webhooks (CHARGE_SUCCEEDED) or via the reconciliation
      // worker (verifyCharge on a stuck PROCESSING intent).
      // The tenantId comes from the verified JWT — use case
      // throws UnboundPrincipalError if the principal has no
      // tenant binding.
      const intent = PaymentIntent.create({
        tenantId: requireTenant(this.deps.principal),
        amount,
        method: method.value,
        provider: routed.value,
        idempotencyKey: idempotencyKey.value,
        customerRef: command.customerRef,
        description: command.description,
      });
      intent.markProcessing(initResult.value.providerReference);

      // --- Step 7: persist state + journal + complete, all in one tx -------
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
          providerReference: intent.chargeReference ?? '',
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
