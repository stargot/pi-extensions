/**
 * Arm-once capture state for payload-capture.
 *
 * Pure module: no pi imports, no IO. The event handler in index.ts applies the
 * state transitions and does UX/filesystem work around them, which keeps the
 * arm-once and save-gate semantics unit-testable.
 */
import { redactPayload } from "./redact.ts";

export interface PayloadCapture {
	/** ISO timestamp of the capture. */
	ts: string;
	/** `provider/model-id` of the request, or "unknown". */
	model: string;
	/** Redacted JSON-safe deep copy of the provider payload. */
	payload: unknown;
	/** Redaction/serialization limits were hit. */
	truncated: boolean;
	/** Size of the rendered JSON text in chars. */
	chars: number;
}

export interface PayloadCaptureState {
	armed: boolean;
	/** Persist the next capture (only honored together with project trust). */
	save: boolean;
	lastCapture?: PayloadCapture;
}

export function createPayloadState(): PayloadCaptureState {
	return { armed: false, save: false };
}

/** Arm the one-shot capture. `save` is remembered and re-checked against trust at capture time. */
export function armPayload(state: PayloadCaptureState, save: boolean): void {
	state.armed = true;
	state.save = save;
}

/** Disarm without forgetting the last capture. */
export function disarmPayload(state: PayloadCaptureState): void {
	state.armed = false;
	state.save = false;
}

/** Full reset: disarm and drop the capture (mirrors /payload clear). */
export function clearPayload(state: PayloadCaptureState): void {
	disarmPayload(state);
	state.lastCapture = undefined;
}

export interface CaptureOutcome {
	captured: boolean;
	capture?: PayloadCapture;
	/** `--save` was armed; callers must still check `ctx.isProjectTrusted()` before writing. */
	saveRequested: boolean;
}

/**
 * Consume the armed capture: on the first call after `armPayload` this disarms
 * the state, redacts `payload` into a fresh deep copy and stores it as
 * `lastCapture`. Any later call is a no-op (arm-once). Never throws: if
 * redaction fails, an error-marker capture is stored instead of the raw payload.
 */
export function captureNextPayload(
	state: PayloadCaptureState,
	payload: unknown,
	meta: { model: string; ts?: string },
): CaptureOutcome {
	if (!state.armed) return { captured: false, saveRequested: false };
	const saveRequested = state.save;
	disarmPayload(state);
	try {
		const redacted = redactPayload(payload);
		state.lastCapture = {
			ts: meta.ts ?? new Date().toISOString(),
			model: meta.model,
			payload: redacted.value,
			truncated: redacted.truncated,
			chars: redacted.text.length,
		};
	} catch (error) {
		state.lastCapture = {
			ts: meta.ts ?? new Date().toISOString(),
			model: meta.model,
			payload: {
				error: `payload-capture: redaction failed: ${error instanceof Error ? error.message : String(error)}`,
			},
			truncated: true,
			chars: 0,
		};
	}
	return { captured: true, capture: state.lastCapture, saveRequested };
}

/** Filename for a capture: `<ts>-<model>.json`, both parts sanitized. */
export function captureFilePath(dir: string, capture: Pick<PayloadCapture, "ts" | "model">): string {
	const stamp = capture.ts.replace(/[:.]/g, "-");
	const model = capture.model.replace(/[^\w.-]+/g, "-");
	return `${dir}/${stamp}-${model}.json`;
}
