export type ProviderName = "ddg" | "langsearch";

export interface ProviderDecision {
	name: ProviderName;
	fallbackReason?: string;
}

export function decideProvider(env: NodeJS.ProcessEnv): ProviderDecision {
	const requested = env.PI_WEB_SEARCH_PROVIDER?.trim().toLowerCase();
	if (requested !== "langsearch") return { name: "ddg" };
	if (!env.LANGSEARCH_API_KEY?.trim()) {
		return {
			name: "ddg",
			fallbackReason: "PI_WEB_SEARCH_PROVIDER=langsearch but LANGSEARCH_API_KEY is not set",
		};
	}
	return { name: "langsearch" };
}
