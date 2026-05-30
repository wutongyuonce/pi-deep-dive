import type { KnownProvider } from "./types.ts";

function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
	if (provider === "anthropic") {
		return ["ANTHROPIC_API_KEY"];
	}

	const envMap: Record<string, string> = {
		deepseek: "DEEPSEEK_API_KEY",
		openai: "OPENAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
	};

	const envVar = envMap[provider];
	return envVar ? [envVar] : undefined;
}

export function findEnvKeys(provider: KnownProvider): string[] | undefined;
export function findEnvKeys(provider: string): string[] | undefined;
export function findEnvKeys(provider: string): string[] | undefined {
	const envVars = getApiKeyEnvVars(provider);
	if (!envVars) return undefined;

	const found = envVars.filter((envVar) => !!process.env[envVar]);
	return found.length > 0 ? found : undefined;
}

export function getEnvApiKey(provider: KnownProvider): string | undefined;
export function getEnvApiKey(provider: string): string | undefined;
export function getEnvApiKey(provider: string): string | undefined {
	const envKeys = findEnvKeys(provider);
	if (envKeys?.[0]) {
		return process.env[envKeys[0]];
	}

	return undefined;
}
