import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import type { GhidraRequestOptions } from "./GhidraClientTypes.js";
import type {
  GhidraSessionError,
  GhidraSessionFailureKind,
} from "./GhidraSessionError.js";

/** Result settled by one queued Ghidra Program request. */
export type GhidraQueuedRequestResult = Result<JsonValue, GhidraSessionError>;
/** Socket execution seam used after a request reaches the queue head. */
export type GhidraRequestExecutor = (
  method: string,
  parameters: JsonValue,
  options: GhidraRequestOptions,
) => Promise<GhidraQueuedRequestResult>;
/** Bind queue failures to the owning client's live diagnostics. */
export type GhidraQueueFailureFactory = (
  kind: GhidraSessionFailureKind,
  message: string,
  cause?: unknown,
) => GhidraSessionError;

/** Stop the provider session when an admitted operation is cancelled. */
export type GhidraActiveCancellationHandler = () => Promise<void>;

interface GhidraQueueRunOptions extends GhidraRequestOptions {
  /**
   * Settle the caller when a request that already reached the bridge is
   * aborted. The Program operation keeps the queue slot until the bridge
   * replies, and the live session stays open.
   */
  readonly detachCallerOnActiveAbort?: boolean;
}

interface QueuedRequest {
  readonly method: string;
  readonly parameters: JsonValue;
  readonly signal: AbortSignal | undefined;
  readonly detachCallerOnActiveAbort: boolean;
  readonly resolve: (result: GhidraQueuedRequestResult) => void;
  readonly onAbort: (() => void) | undefined;
  callerSettled: boolean;
}

/** FIFO that admits one Ghidra Program request at a time. */
export class GhidraRequestQueue {
  readonly #queue: QueuedRequest[] = [];
  #active = false;
  #closedFailure: GhidraSessionError | undefined;

  constructor(
    private readonly execute: GhidraRequestExecutor,
    private readonly failure: GhidraQueueFailureFactory,
    private readonly onActiveCancellation: GhidraActiveCancellationHandler,
  ) {}

  /** Queue one request until it completes, is cancelled, or the session closes. */
  run(
    method: string,
    parameters: JsonValue,
    options: GhidraQueueRunOptions,
  ): Promise<GhidraQueuedRequestResult> {
    if (this.#closedFailure !== undefined)
      return Promise.resolve(err(this.#closedFailure));
    if (options.signal?.aborted === true)
      return Promise.resolve(
        err(this.failure("cancelled", "Ghidra request was cancelled")),
      );
    return new Promise((resolve) => {
      let entry: QueuedRequest;
      const onAbort =
        options.signal === undefined
          ? undefined
          : () =>
              this.#rejectQueued(
                entry,
                err(this.failure("cancelled", "Ghidra request was cancelled")),
              );
      entry = {
        method,
        parameters,
        signal: options.signal,
        detachCallerOnActiveAbort: options.detachCallerOnActiveAbort === true,
        resolve,
        onAbort,
        callerSettled: false,
      };
      this.#queue.push(entry);
      if (onAbort !== undefined)
        options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#drain();
    });
  }

  /** Fail requests that have not crossed the socket during session cleanup. */
  failQueued(failure: GhidraSessionError): void {
    this.#closedFailure = failure;
    for (const entry of this.#queue.splice(0)) {
      this.#release(entry);
      entry.resolve(err(failure));
    }
  }

  /** Admit requests after the owning client completes a new session startup. */
  reopen(): void {
    this.#closedFailure = undefined;
  }

  #drain(): void {
    if (this.#active) return;
    const entry = this.#queue.shift();
    if (entry === undefined) return;
    this.#release(entry);
    // The caller can abort after this request leaves the queue.
    const signalAborted = (): boolean => entry.signal?.aborted === true;
    if (signalAborted()) {
      entry.resolve(
        err(this.failure("cancelled", "Ghidra request was cancelled")),
      );
      this.#drain();
      return;
    }
    this.#active = true;
    let executionSettled = false;
    let activeCancellation: Promise<void> | undefined;
    const detach = entry.detachCallerOnActiveAbort;
    const cancelled = err(
      this.failure("cancelled", "Ghidra request was cancelled"),
    );
    const settleCaller = (result: GhidraQueuedRequestResult): void => {
      if (entry.callerSettled) return;
      entry.callerSettled = true;
      entry.resolve(result);
    };
    const onAbort =
      entry.signal === undefined
        ? undefined
        : () => {
            if (executionSettled) return;
            if (detach) {
              settleCaller(cancelled);
              return;
            }
            this.failQueued(
              this.failure(
                "process",
                "Ghidra session closed after active request cancellation",
              ),
            );
            activeCancellation = this.onActiveCancellation();
          };
    if (onAbort !== undefined)
      entry.signal?.addEventListener("abort", onAbort, { once: true });
    // Abort between dequeue and listener installation must not send a
    // completion request that the caller has already given up.
    if (detach && signalAborted()) settleCaller(cancelled);
    if (detach && entry.callerSettled) {
      if (entry.signal !== undefined && onAbort !== undefined)
        entry.signal.removeEventListener("abort", onAbort);
      this.#active = false;
      if (this.#closedFailure === undefined) this.#drain();
      return;
    }
    void this.execute(
      entry.method,
      entry.parameters,
      detach || entry.signal === undefined ? {} : { signal: entry.signal },
    )
      .then(async (result) => {
        if (activeCancellation !== undefined) {
          try {
            await activeCancellation;
          } catch (cause: unknown) {
            result = err(
              this.failure(
                "process",
                cause instanceof Error
                  ? `Ghidra cleanup after cancellation failed: ${cause.message}`
                  : "Ghidra cleanup after cancellation failed",
                cause,
              ),
            );
          }
        }
        executionSettled = true;
        settleCaller(result);
      })
      .catch((cause: unknown) => {
        executionSettled = true;
        settleCaller(
          err(
            this.failure(
              "protocol",
              "Ghidra serial request execution rejected unexpectedly",
              cause,
            ),
          ),
        );
      })
      .finally(() => {
        if (entry.signal !== undefined && onAbort !== undefined)
          entry.signal.removeEventListener("abort", onAbort);
        this.#active = false;
        if (this.#closedFailure === undefined) this.#drain();
      });
  }

  #rejectQueued(entry: QueuedRequest, result: GhidraQueuedRequestResult): void {
    const index = this.#queue.indexOf(entry);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#release(entry);
    entry.resolve(result);
  }

  #release(entry: QueuedRequest): void {
    if (entry.signal !== undefined && entry.onAbort !== undefined)
      entry.signal.removeEventListener("abort", entry.onAbort);
  }
}
