export type ProviderName = "ddg";

export interface ProviderDecision {
	name: ProviderName;
	fallbackReason?: string;
}

/** DuckDuckGo is the only provider — the provider-selection env knob was
 *  removed with it, and any env resolves to ddg. */
export function decideProvider(_env: NodeJS.ProcessEnv): ProviderDecision {
	return { name: "ddg" };
}
