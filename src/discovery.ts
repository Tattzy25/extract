/**
 * Bazaar discovery metadata.
 *
 * This is what makes the endpoint findable by buying agents. There is no
 * signup form: the listing is created by the first payment that settles
 * through the authenticated CDP facilitator, using the metadata declared here.
 *
 * Bazaar rejects listings with a description over 500 chars, invalid JSON
 * Schema, or a missing resource. Keep the description short.
 */
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

/** Kept deliberately under 500 characters. */
export const SERVICE_DESCRIPTION =
	"Convert any public web page to clean Markdown. POST a url, get back deterministic Markdown plus a SHA-256 of the exact bytes and an ISO retrieval timestamp, so the output is verifiable and cacheable. Renders JavaScript pages via a real headless browser. Fixed price per call, no key, no account, no rate limit negotiation. Returns a stable JSON envelope with an ok flag and a machine-readable error code.";

export const SERVICE_TAGS = [
	"markdown",
	"scraping",
	"web-extraction",
	"html-to-markdown",
	"rag",
];

/** Response example that buyers see before they pay. */
export const OUTPUT_EXAMPLE = {
	ok: true,
	url: "https://example.com/",
	markdown:
		"# Example Domain\n\nThis domain is for use in illustrative examples in documents.",
	chars: 78,
	truncated: false,
	sha256: "3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea",
	retrievedAt: "2026-08-19T18:00:00.000Z",
	browserMs: 812,
};

/** JSON Schema for the POST body. */
export const INPUT_SCHEMA = {
	type: "object",
	properties: {
		url: {
			type: "string",
			format: "uri",
			description: "Public http(s) URL to convert to Markdown.",
		},
		waitUntil: {
			type: "string",
			enum: ["load", "domcontentloaded", "networkidle0", "networkidle2"],
			default: "networkidle2",
			description: "Page load condition. Use networkidle0 for heavy SPAs.",
		},
		rejectRequestPattern: {
			type: "array",
			items: { type: "string" },
			maxItems: 10,
			description: "Regex strings for subresources to block, e.g. CSS.",
		},
		userAgent: {
			type: "string",
			description: "Override the browser User-Agent.",
		},
	},
	required: ["url"],
	additionalProperties: false,
} as const;

/** JSON Schema for the response envelope. */
export const OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		ok: { type: "boolean" },
		url: { type: "string" },
		markdown: { type: "string" },
		chars: { type: "integer" },
		truncated: { type: "boolean" },
		sha256: { type: "string" },
		retrievedAt: { type: "string", format: "date-time" },
		browserMs: { type: ["integer", "null"] },
	},
	required: ["ok"],
} as const;

/**
 * Discovery extension for the HTTP route POST /v1/extract. This object is what
 * becomes the public Bazaar listing.
 */
export const httpDiscoveryExtension = declareDiscoveryExtension({
	bodyType: "json",
	input: { url: "https://example.com" },
	inputSchema: INPUT_SCHEMA as unknown as Record<string, unknown>,
	output: {
		example: OUTPUT_EXAMPLE,
		schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
	},
});

// Bazaar rejects descriptions over 500 characters. Pure computation, no I/O,
// so this is safe at module scope: a bad edit breaks the deploy, not a buyer.
if (SERVICE_DESCRIPTION.length > 500) {
	throw new Error(
		`SERVICE_DESCRIPTION is ${SERVICE_DESCRIPTION.length} chars; Bazaar rejects over 500`
	);
}
