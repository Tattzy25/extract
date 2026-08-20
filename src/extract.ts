/**
 * The product. Deterministic URL -> Markdown extraction.
 *
 * Deterministic means: same input shape, same output shape, every time.
 * A buying agent can parse this without an LLM, which is the whole point.
 */
import type { Env } from "./env";

export const MAX_MARKDOWN_CHARS = 500_000;
export const RENDER_TIMEOUT_MS = 20_000;

export interface ExtractRequest {
	url: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	rejectRequestPattern?: string[];
	userAgent?: string;
}

export interface ExtractSuccess {
	ok: true;
	url: string;
	markdown: string;
	chars: number;
	truncated: boolean;
	sha256: string;
	retrievedAt: string;
	browserMs: number | null;
}

export interface ExtractFailure {
	ok: false;
	error: string;
	code:
		| "invalid_body"
		| "invalid_url"
		| "blocked_url"
		| "render_failed"
		| "render_timeout";
}

export type ExtractResult = ExtractSuccess | ExtractFailure;

const ALLOWED_WAIT_UNTIL = new Set([
	"load",
	"domcontentloaded",
	"networkidle0",
	"networkidle2",
]);

/**
 * Hostnames that must never be reachable through a paid public endpoint.
 * Cloud metadata services are the highest-value SSRF target.
 */
const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"metadata",
	"metadata.google.internal",
	"metadata.goog",
	"instance-data",
	"instance-data.ec2.internal",
]);

const BLOCKED_HOST_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".localdomain",
	".home.arpa",
];

/**
 * True when a dotted-quad IPv4 literal falls in a range that must not be
 * reachable from a public endpoint.
 */
function isBlockedIPv4(host: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return false;
	const o = m.slice(1).map(Number);
	if (o.some((n) => n > 255)) return true;
	const [a, b] = o;
	if (a === 0) return true; // 0.0.0.0/8
	if (a === 10) return true; // private
	if (a === 127) return true; // loopback
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
	if (a === 169 && b === 254) return true; // link-local + AWS/GCP metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 168) return true; // private
	if (a === 192 && b === 0) return true; // 192.0.0/24, 192.0.2/24
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a === 198 && b === 51) return true; // TEST-NET-2
	if (a === 203 && b === 0) return true; // TEST-NET-3
	if (a >= 224) return true; // multicast + reserved
	return false;
}

/**
 * True when an IPv6 literal is loopback, link-local, or unique-local.
 */
function isBlockedIPv6(host: string): boolean {
	if (!host.startsWith("[")) return false;
	const raw = host.slice(1, -1).toLowerCase().split("%")[0];
	if (raw === "::" || raw === "::1") return true;
	if (raw.startsWith("fe8") || raw.startsWith("fe9")) return true;
	if (raw.startsWith("fea") || raw.startsWith("feb")) return true; // link-local
	if (raw.startsWith("fc") || raw.startsWith("fd")) return true; // unique-local
	// IPv4-mapped, e.g. ::ffff:127.0.0.1
	const tail = raw.split(":").pop() ?? "";
	if (tail.includes(".") && isBlockedIPv4(tail)) return true;
	return false;
}

/**
 * Validate and normalize a caller-supplied URL.
 *
 * @param input - Raw URL string from the request body
 * @returns The normalized URL, or a failure result
 */
export function validateTargetUrl(
	input: unknown
): { ok: true; url: URL } | ExtractFailure {
	if (typeof input !== "string" || input.trim() === "") {
		return { ok: false, code: "invalid_url", error: "url must be a string" };
	}
	if (input.length > 2048) {
		return { ok: false, code: "invalid_url", error: "url exceeds 2048 chars" };
	}

	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return { ok: false, code: "invalid_url", error: "url is not parseable" };
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return {
			ok: false,
			code: "blocked_url",
			error: "only http and https are supported",
		};
	}

	if (url.username || url.password) {
		return {
			ok: false,
			code: "blocked_url",
			error: "credentials in url are not allowed",
		};
	}

	const host = url.hostname.toLowerCase();
	if (
		BLOCKED_HOSTNAMES.has(host) ||
		BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) ||
		!host.includes(".") ||
		isBlockedIPv4(host) ||
		isBlockedIPv6(url.host.toLowerCase())
	) {
		return {
			ok: false,
			code: "blocked_url",
			error: "target host is not publicly routable",
		};
	}

	return { ok: true, url };
}

/**
 * Parse and validate the JSON request body.
 *
 * @param body - Already-parsed JSON value
 * @returns A normalized request, or a failure result
 */
export function parseExtractRequest(
	body: unknown
): { ok: true; request: ExtractRequest } | ExtractFailure {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return {
			ok: false,
			code: "invalid_body",
			error: "body must be a JSON object",
		};
	}
	const b = body as Record<string, unknown>;

	const urlCheck = validateTargetUrl(b.url);
	if (!urlCheck.ok) return urlCheck;

	const request: ExtractRequest = { url: urlCheck.url.toString() };

	if (b.waitUntil !== undefined) {
		if (
			typeof b.waitUntil !== "string" ||
			!ALLOWED_WAIT_UNTIL.has(b.waitUntil)
		) {
			return {
				ok: false,
				code: "invalid_body",
				error: `waitUntil must be one of ${[...ALLOWED_WAIT_UNTIL].join(", ")}`,
			};
		}
		request.waitUntil = b.waitUntil as ExtractRequest["waitUntil"];
	}

	if (b.rejectRequestPattern !== undefined) {
		if (
			!Array.isArray(b.rejectRequestPattern) ||
			b.rejectRequestPattern.length > 10 ||
			b.rejectRequestPattern.some(
				(p) => typeof p !== "string" || p.length > 200
			)
		) {
			return {
				ok: false,
				code: "invalid_body",
				error: "rejectRequestPattern must be an array of <=10 strings",
			};
		}
		request.rejectRequestPattern = b.rejectRequestPattern as string[];
	}

	if (b.userAgent !== undefined) {
		if (typeof b.userAgent !== "string" || b.userAgent.length > 300) {
			return {
				ok: false,
				code: "invalid_body",
				error: "userAgent must be a string of <=300 chars",
			};
		}
		request.userAgent = b.userAgent;
	}

	return { ok: true, request };
}

/**
 * Hex-encoded SHA-256 of a string. Lets the buyer verify the payload it paid for.
 *
 * @param value - Text to hash
 * @returns Lowercase hex digest
 */
export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value)
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Render a URL to Markdown through the Browser Run binding.
 *
 * Uses env.BROWSER.quickAction("markdown", ...), which requires
 * compatibility_date >= 2026-03-24 and needs no API token.
 *
 * @param env - Worker environment
 * @param request - Validated extract request
 * @returns A deterministic success or failure envelope. Never throws.
 */
export async function renderMarkdown(
	env: Env,
	request: ExtractRequest
): Promise<ExtractResult> {
	const body: BrowserRunMarkdownOptions = {
		url: request.url,
		gotoOptions: { waitUntil: request.waitUntil ?? "networkidle2" },
		...(request.rejectRequestPattern
			? { rejectRequestPattern: request.rejectRequestPattern }
			: {}),
		...(request.userAgent ? { userAgent: request.userAgent } : {}),
	};

	let response: Response;
	try {
		response = await withTimeout(
			env.BROWSER.quickAction("markdown", body),
			RENDER_TIMEOUT_MS
		);
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return {
			ok: false,
			code: timedOut ? "render_timeout" : "render_failed",
			error: timedOut
				? `render exceeded ${RENDER_TIMEOUT_MS}ms`
				: `browser error: ${errorMessage(error)}`,
		};
	}

	const browserMsHeader = response.headers.get("X-Browser-Ms-Used");
	const browserMs = browserMsHeader ? Number(browserMsHeader) : null;

	const raw = await response.text();

	if (!response.ok) {
		return {
			ok: false,
			code: "render_failed",
			error: `browser returned ${response.status}: ${raw.slice(0, 300)}`,
		};
	}

	// The markdown quick action returns { success: true, result: "<markdown>" }.
	// Fall back to the raw body if a future version returns text/plain.
	let markdown: string;
	try {
		const parsed = JSON.parse(raw) as { success?: boolean; result?: unknown };
		if (parsed.success === false) {
			return {
				ok: false,
				code: "render_failed",
				error: `browser reported failure: ${raw.slice(0, 300)}`,
			};
		}
		markdown = typeof parsed.result === "string" ? parsed.result : raw;
	} catch {
		markdown = raw;
	}

	const truncated = markdown.length > MAX_MARKDOWN_CHARS;
	if (truncated) markdown = markdown.slice(0, MAX_MARKDOWN_CHARS);

	return {
		ok: true,
		url: request.url,
		markdown,
		chars: markdown.length,
		truncated,
		sha256: await sha256Hex(markdown),
		retrievedAt: new Date().toISOString(),
		browserMs: Number.isFinite(browserMs) ? browserMs : null,
	};
}

/**
 * Reject a promise once a deadline elapses.
 *
 * @param promise - Work to bound
 * @param ms - Deadline in milliseconds
 * @returns The promise's value if it settles in time
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			const error = new Error(`timed out after ${ms}ms`);
			error.name = "TimeoutError";
			reject(error);
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

/**
 * Safe error message extraction.
 *
 * @param error - Unknown thrown value
 * @returns A short human-readable message
 */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
