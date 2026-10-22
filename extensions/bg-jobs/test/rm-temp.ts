import { rmSync } from "node:fs";

/** Force-removes a temp dir, retrying transient Windows EPERM/EBUSY (open CWD handles, AV scans). */
export function rmTemp(dir: string): void {
	rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
