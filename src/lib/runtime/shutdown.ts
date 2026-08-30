/**
 * Whether this process has been asked to stop.
 *
 * Deliberately a module-level flag rather than something threaded through
 * call signatures. Shutdown is genuinely process-wide state — there is one
 * answer, it is the same for every caller, and the alternative is an
 * `AbortSignal` parameter added to a dozen functions that have no other
 * reason to know about scheduling.
 *
 * It exists because "await the in-flight pass" is not enough on its own. A
 * drain claims an event, runs its handlers, then marks it done; a batch of
 * fifty is fifty of those in a row. Waiting for the whole batch can outlast
 * the grace window an orchestrator gives between SIGTERM and SIGKILL, and
 * being cut off mid-batch leaves the event it was inside claimed with
 * nobody working on it. The claim lease means that event is eventually
 * reclaimed rather than lost — but "eventually" is five minutes, and a
 * clean stop should not cost a carrier five minutes of notifications.
 *
 * So a long loop checks this **between** units of work and stops at a
 * boundary where nothing is half-done. Anything it did not reach is still
 * PENDING and the next process takes it immediately.
 *
 * The web server never sets it. Only the worker's supervisor does.
 */
let stopping = false;

export function beginShutdown(): void {
  stopping = true;
}

export function isShuttingDown(): boolean {
  return stopping;
}

/** Tests only: puts the flag back so one case cannot leak into the next. */
export function resetShutdownForTests(): void {
  stopping = false;
}
