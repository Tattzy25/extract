/**
 * Bazaar keepalive.
 *
 * Two jobs, both done by paying yourself one cent:
 *
 *  1. First run publishes the listing. There is no registration form for the
 *     x402 Bazaar. A listing is created when a payment settles through the
 *     authenticated CDP facilitator carrying the discovery metadata declared
 *     in src/discovery.ts.
 *
 *  2. Later runs keep it alive. A listing with no settled payment for 30 days
 *     is dropped from discovery.
 *
 * Requires the BUYER_PRIVATE_KEY secret: a throwaway Base wallet holding a
 * couple of dollars of USDC. Leave the secret unset and this no-ops, which is
 * the correct behaviour until you have decided to fund a buyer wallet.
 */
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import type { Env } from "./env";

/**
 * Pay this service one cent from the buyer wallet.
 *
 * @param env - Worker environment
 * @returns Nothing. Failures are logged, never thrown, so a bad cron run
 *   cannot take down the Worker.
 */
export async function runBazaarKeepalive(env: Env): Promise<void> {
	const key = env.BUYER_PRIVATE_KEY;
	if (!key) {
		console.log("keepalive skipped: BUYER_PRIVATE_KEY not set");
		return;
	}

	try {
		const account = privateKeyToAccount(
			key.startsWith("0x") ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`)
		);

		const client = registerExactEvmScheme(new x402Client(), {
			signer: account,
		});

		const payingFetch = wrapFetchWithPayment(fetch, client);

		const response = await payingFetch(`${env.SERVICE_ORIGIN}/v1/extract`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "https://example.com" }),
		});

		console.log(
			JSON.stringify({
				event: "bazaar_keepalive",
				status: response.status,
				paymentResponse: response.headers.get("payment-response"),
				extensionResponses: response.headers.get("extension-responses"),
			})
		);
	} catch (error) {
		console.error(
			"bazaar keepalive failed:",
			error instanceof Error ? error.message : String(error)
		);
	}
}
