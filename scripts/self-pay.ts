/**
 * One-shot buyer. Run this from your machine to make the first real payment,
 * which is what publishes the Bazaar listing.
 *
 *   BUYER_PRIVATE_KEY=0x... npm run self-pay
 *
 * Optional:
 *   TARGET=https://extract.anigok.com/v1/extract
 *   PAGE=https://example.com
 *
 * Success looks like: HTTP 200, a payment-response header with a transaction
 * hash, and an extension-responses header containing bazaar success.
 */
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.BUYER_PRIVATE_KEY;
if (!key) {
	console.error("BUYER_PRIVATE_KEY is required");
	process.exit(1);
}

const target =
	process.env.TARGET ?? "https://extract.anigok.com/v1/extract";
const page = process.env.PAGE ?? "https://example.com";

const account = privateKeyToAccount(
	key.startsWith("0x") ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`)
);

console.log(`buyer  ${account.address}`);
console.log(`target ${target}`);
console.log(`page   ${page}`);

const client = registerExactEvmScheme(new x402Client(), { signer: account });
const payingFetch = wrapFetchWithPayment(fetch, client);

const response = await payingFetch(target, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ url: page }),
});

console.log(`\nstatus              ${response.status}`);
console.log(`payment-response    ${response.headers.get("payment-response")}`);
console.log(
	`extension-responses ${response.headers.get("extension-responses")}`
);

const body = await response.text();
console.log(`\nbody (first 600 chars)\n${body.slice(0, 600)}`);

if (response.status !== 200) process.exit(1);
