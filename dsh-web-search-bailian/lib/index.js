import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

/**
 * Bailian (DashScope) search provider for the `ctx.web` seam.
 *
 * Unlike `@deepseek-ai/dsh-web-search-deepseek` (which calls DeepSeek's
 * Anthropic-compatible Messages API with the `web_search_20250305` server
 * tool), this provider targets Aliyun Bailian's OpenAI-compatible **Responses**
 * endpoint and enables its **built-in** `web_search` tool. Bailian executes the
 * search server-side and returns structured `web_search_call` items plus a
 * final `message` answer, which we normalize into `WebSearchResult`.
 *
 * The wire format and native `fetch` client are provider-private and do not
 * use `ctx.llm`. Modeled on `@deepseek-ai/dsh-web-search-deepseek`.
 */

/** Stable id this provider registers under. Referenced by `web.config.searchProvider`. */
const BAILIAN_PROVIDER_ID = "bailian";
/** Default endpoint: Bailian's OpenAI-compatible base (`/responses` is appended). */
const BAILIAN_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
/** Default model name for the auxiliary search request. */
const BAILIAN_DEFAULT_MODEL = "qwen3.8-max";
/** Default upper bound on generated tokens for the Responses request. */
const BAILIAN_DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** Attribution header sent on every request. */
const USER_AGENT = "deepseek-harness-bailian-search/0.0.1";

/**
 * Map a Bailian Responses body to a normalized `WebSearchResult`. Walks
 * `web_search_call` items for citeable sources, dedupes by `url`, and folds the
 * final `message` text into `content` (Bailian's built-in search produces a
 * synthesized answer, unlike DeepSeek's structured-only blocks). The web
 * service owns the final `maxResults` truncation, so `truncated` is `false`.
 *
 * @throws {WebError} when built-in search produced no source.
 */
function mapResponsesResponse(response) {
	const output = response.output ?? [];
	const seen = /* @__PURE__ */ new Set();
	const sources = [];
	let content = "";
	for (const item of output) {
		if (item.type === "web_search_call") {
			for (const source of item.action?.sources ?? []) {
				const url = typeof source.url === "string" ? source.url : "";
				if (url.length === 0 || seen.has(url)) continue;
				seen.add(url);
				sources.push({
					url,
					...typeof source.title === "string" && source.title.length > 0 ? { title: source.title } : {},
					...typeof source.snippet === "string" && source.snippet.length > 0 ? { snippet: source.snippet } : {}
				});
			}
		} else if (item.type === "message") {
			for (const part of item.content ?? []) {
				if (typeof part.text === "string" && part.text.length > 0) content += (content.length > 0 ? "\n" : "") + part.text;
			}
		}
	}
	if (sources.length === 0) throw new WebError("Bailian returned no web_search_call sources; the request may not have triggered built-in web search", "WEB_PROVIDER_ERROR");
	return {
		...content.length > 0 ? { content } : {},
		sources,
		truncated: false
	};
}

/** The Bailian-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
class BailianSearchProvider {
	resolveOptions;
	id = BAILIAN_PROVIDER_ID;
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}
	available() {
		const options = this.resolveOptions();
		return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== void 0) && URL.canParse(options.baseURL) && isPositiveInteger(options.maxOutputTokens);
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		const apiKey = await this.apiKey(options, signal);
		throwIfSearchAborted(signal);
		const endpoint = `${options.baseURL}/responses`;
		const body = {
			model: options.model,
			max_output_tokens: options.maxOutputTokens,
			input: [{
				role: "user",
				content: [{ type: "input_text", text: `Perform a web search for the query: ${request.query}` }]
			}],
			tools: [{ type: "web_search" }]
		};
		options.recordRequest?.({ endpoint, body });
		throwIfSearchAborted(signal);
		let response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": `Bearer ${apiKey}`,
					"content-type": "application/json",
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify(body),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Bailian search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let message = `Bailian API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
				if (detail !== void 0 && detail.length > 0) message = detail;
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
		try {
			return mapResponsesResponse(await response.json());
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			if (error instanceof WebError) throw error;
			throw new WebError(`Bailian returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
	async apiKey(options, signal) {
		throwIfSearchAborted(signal);
		if (options.apiKey !== void 0 && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(void 0), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Bailian search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (resolved !== void 0 && resolved.length > 0) return resolved;
		throw new WebError(`Bailian search has no API key for "${options.apiKeyEnv ?? "BAILIAN_API_KEY"}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-bailian config`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
}

function abortable(operation, signal) {
	if (signal === void 0) return operation;
	if (signal.aborted) return Promise.reject(searchAborted(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(searchAborted(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
		});
	});
}
function throwIfSearchAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}
function searchAborted(signal, fallback) {
	return new WebError("Bailian search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}

/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-bailian";
/** The web seam this provider registers into. */
const inject = ["web"];
const DEFAULT_API_KEY_ENV = "BAILIAN_API_KEY";
const Config = z.object({
	apiKey: z.string().role("secret"),
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	baseURL: z.string(),
	model: z.string().default(BAILIAN_DEFAULT_MODEL),
	maxOutputTokens: z.number().step(1).min(1).default(BAILIAN_DEFAULT_MAX_OUTPUT_TOKENS)
});
/** Environment variable naming this provider's endpoint override. */
const SEARCH_BASE_URL_ENV = "BAILIAN_SEARCH_BASE_URL";
/** Settings namespace carrying this provider's endpoint, model, and key reference. */
const WEB_SEARCH_BAILIAN_SETTINGS_NAMESPACE = settingsNamespace("web-search-bailian");

function resolveOptions(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== void 0 && config.apiKey.length > 0 ? config.apiKey : void 0;
	return {
		...literalApiKey === void 0 ? {} : { apiKey: literalApiKey },
		resolveApiKey: async () => {
			const credentials = ctx.get("credentials");
			if (credentials !== void 0) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
		},
		apiKeyEnv,
		baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value ?? BAILIAN_DEFAULT_BASE_URL,
		model: config.model ?? BAILIAN_DEFAULT_MODEL,
		maxOutputTokens: config.maxOutputTokens ?? BAILIAN_DEFAULT_MAX_OUTPUT_TOKENS,
		recordRequest: (request) => {
			ctx.get("agents")?.currentInitiator()?.session.append("web/bailian-search-llm-request", request);
		}
	};
}
/** Register the Bailian search provider with `ctx.web`. */
function apply(ctx, config) {
	let current = () => config;
	installSettingsSection(ctx, WEB_SEARCH_BAILIAN_SETTINGS_NAMESPACE, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {}
	});
	ctx.web.registerSearchProvider(new BailianSearchProvider(() => resolveOptions(ctx, current())));
}

export { Config, BAILIAN_DEFAULT_BASE_URL, BAILIAN_DEFAULT_MAX_OUTPUT_TOKENS, BAILIAN_DEFAULT_MODEL, BAILIAN_PROVIDER_ID, BailianSearchProvider, WEB_SEARCH_BAILIAN_SETTINGS_NAMESPACE, apply, inject, name };
