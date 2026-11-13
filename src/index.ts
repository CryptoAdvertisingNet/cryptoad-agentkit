/**
 * Coinbase AgentKit action provider for CryptoAd Network.
 *
 * Gives an agent the actions to buy crypto advertising: read the formats,
 * quote an order, buy prepaid ad credit or pay for one order, and follow
 * the ads. Payments are x402 payments in USDC from the agent's own wallet
 * (Base, Polygon or Arbitrum), with two guards: only CryptoAd Network's
 * receiving address is paid, and never more than `maxPaymentUsd` at once.
 *
 * The API key a first payment returns is kept by the provider and is never
 * handed to the model. Persist it with `onApiKey`, pass it back as `apiKey`.
 */

import { randomUUID } from "node:crypto";
import {
  EvmWalletProvider,
  customActionProvider,
  type ActionProvider,
  type WalletProvider,
} from "@coinbase/agentkit";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { z } from "zod";

export const CRYPTOAD_ORIGIN = "https://cryptoadvertising.net";

/** Where every payment to CryptoAd Network goes, on each EVM network. */
export const CRYPTOAD_PAY_TO = "0x1313c840F693EB2d8FD4Bb3B8Ed9e55B134B47D8";

/** Circle's USDC on the networks the API accepts, by CAIP-2 id. */
export const CRYPTOAD_USDC: Readonly<Record<string, string>> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};

export type CryptoAdOptions = {
  /** A key from an earlier run (`can_live_...`). */
  apiKey?: string;
  /**
   * Called once when a payment returns a new API key. The key is the account:
   * store it somewhere safe. It is not shown again and not given to the model.
   */
  onApiKey?: (apiKey: string) => void | Promise<void>;
  /** The most one payment may cost, in USD. Default 25. */
  maxPaymentUsd?: number;
  /** For tests. Default: https://cryptoadvertising.net */
  origin?: string;
};

type Json = Record<string, unknown>;

const orderSchema = z
  .object({
    product: z
      .enum(["PTC", "Sponsored Listing", "Banner", "Native", "Paid Visits"])
      .describe("The ad format. Read cryptoad_list_formats for the fields of each."),
    name: z.string().describe("A name for the campaign, for your own reference."),
    landing_url: z.string().describe("The https page the ad opens."),
    ad_title: z.string().describe("The headline."),
    ad_description: z.string().optional().describe("The description (required for most formats)."),
    pricing_model: z.enum(["CPC", "CPM", "CPV"]).optional(),
    bid_usd: z.string().optional().describe('A decimal string, for example "0.005".'),
    daily_budget_usd: z.string().optional(),
    total_budget_usd: z.string().optional(),
    targeting: z.record(z.unknown()).optional(),
    product_options: z.record(z.unknown()).optional(),
    image_id: z.number().int().optional(),
  })
  .passthrough()
  .describe("An order, exactly as cryptoad_list_formats describes it for the chosen format.");

/** What the model is told. Never holds a key. */
function answer(body: unknown): string {
  return JSON.stringify(body, null, 2);
}

function failure(message: string, details?: unknown): string {
  return answer({ error: true, message, ...(details !== undefined ? { details } : {}) });
}

function decodeHeader(value: string): Json {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Json;
}

/**
 * The actions. Add the result to `AgentKit.from({ actionProviders: [...] })`.
 */
export function cryptoAdActionProvider(options: CryptoAdOptions = {}): ActionProvider<WalletProvider> & {
  /** The API key held right now, for the host application to persist. */
  getApiKey: () => string | null;
} {
  const base = `${options.origin ?? CRYPTOAD_ORIGIN}/api/v1`;
  const maxPaymentUsd = options.maxPaymentUsd ?? 25;
  let apiKey: string | null = options.apiKey ?? null;

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    accept: "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  });

  /** Keeps a key the API returned, and takes it out of what the model sees. */
  async function withoutKey(json: Json): Promise<Json> {
    if (typeof json.api_key !== "string") return json;
    apiKey = json.api_key;
    await options.onApiKey?.(json.api_key);
    const { api_key: _kept, ...rest } = json;
    return { ...rest, api_key: "(stored by the provider; not shown)" };
  }

  async function call(method: string, path: string, body?: unknown): Promise<string> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: headers(body !== undefined ? { "content-type": "application/json" } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await response.json().catch(() => ({}))) as Json;
    return answer({ http_status: response.status, ...(await withoutKey(json)) });
  }

  /**
   * A request that may cost money: asked once without payment to read the
   * price, checked against the guards, then paid from the wallet.
   */
  async function paidCall(
    wallet: WalletProvider,
    path: string,
    body: unknown | undefined,
  ): Promise<string> {
    const init = {
      method: "POST",
      headers: headers({
        "idempotency-key": randomUUID(),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };
    const url = `${base}${path}`;
    const unpaid = await fetch(url, init);
    if (unpaid.status !== 402) {
      // Paid from the balance, or refused for a reason that is not the price.
      const json = (await unpaid.json().catch(() => ({}))) as Json;
      return answer({ http_status: unpaid.status, ...(await withoutKey(json)) });
    }

    if (!(wallet instanceof EvmWalletProvider)) {
      return failure("This needs an EVM wallet holding USDC on Base, Polygon or Arbitrum.");
    }
    const chainId = wallet.getNetwork().chainId;
    const network = `eip155:${chainId}`;
    const usdc = CRYPTOAD_USDC[network];
    if (!usdc) {
      return failure(
        `The wallet is on chain ${chainId ?? "unknown"}. CryptoAd Network takes USDC on Base (8453), Polygon (137) or Arbitrum (42161).`,
      );
    }
    const header = unpaid.headers.get("payment-required");
    const accepts = header ? (decodeHeader(header).accepts as Json[] | undefined) : undefined;
    const offer = accepts?.find((entry) => entry.network === network);
    if (!offer) return failure(`The server does not offer payment on ${network}.`);
    const amount = BigInt(String(offer.amount));
    const cap = BigInt(Math.round(maxPaymentUsd * 1_000_000));
    if (
      offer.scheme !== "exact" ||
      String(offer.asset).toLowerCase() !== usdc.toLowerCase() ||
      String(offer.payTo).toLowerCase() !== CRYPTOAD_PAY_TO.toLowerCase()
    ) {
      return failure("The payment request is not a USDC payment to CryptoAd Network. Nothing was paid.");
    }
    if (amount <= 0n || amount > cap) {
      return failure(
        `This costs ${Number(amount) / 1e6} USDC, more than the ${maxPaymentUsd} USDC one payment may cost. Nothing was paid.`,
      );
    }

    const client = new x402Client();
    // The x402 client has a limit of its own, $1 a payment unless told
    // otherwise. The limit that counts here is the one checked above.
    client.setSpendControls({ maxAmountPerPayment: maxPaymentUsd });
    registerExactEvmScheme(client, {
      signer: wallet.toSigner(),
      networks: [network as `${string}:${string}`],
    });
    const paid = await wrapFetchWithPayment(fetch, client)(url, init);
    const json = (await paid.json().catch(() => ({}))) as Json;
    return answer({
      http_status: paid.status,
      paid_usdc: paid.ok ? Number(amount) / 1e6 : 0,
      network,
      ...(await withoutKey(json)),
    });
  }

  const guarded = async (run: () => Promise<string>): Promise<string> => {
    try {
      return await run();
    } catch (error) {
      return failure("The request failed.", error instanceof Error ? error.message : String(error));
    }
  };

  const provider = customActionProvider<WalletProvider>([
    {
      name: "cryptoad_list_formats",
      description:
        "CryptoAd Network: list the crypto ad formats an agent can buy (PTC paid-to-click, Banner, Native, Paid Visits, Sponsored Listing) with their fields, limits, prices and an example order each. The ads are shown to real crypto users. Read this before building an order. Free.",
      schema: z.object({}),
      invoke: async (_args: Record<string, never>) => guarded(() => call("GET", "/formats")),
    },
    {
      name: "cryptoad_quote_ad",
      description:
        "CryptoAd Network: validate an ad order and get its exact price in USD. Creates nothing and costs nothing. A problem with the order is answered with its code and the field it is in.",
      schema: z.object({ order: orderSchema }),
      invoke: async (args: { order: Json }) => guarded(() => call("POST", "/quote", args.order)),
    },
    {
      name: "cryptoad_buy_credit",
      description:
        "CryptoAd Network: buy prepaid advertising credit with USDC from the agent's wallet (x402 payment; 1 USDC = $1.00 of credit). The first purchase opens an account; its API key is stored by the provider. Orders are then paid from the balance.",
      schema: z.object({
        amount_usd: z
          .string()
          .regex(/^[1-9][0-9]{0,6}(\.[0-9]{2})?$/)
          .describe('Whole dollars ("5") or two decimals ("5.00").'),
      }),
      invoke: async (wallet: WalletProvider, args: { amount_usd: string }) =>
        guarded(() => paidCall(wallet, `/credits/${args.amount_usd}`, undefined)),
    },
    {
      name: "cryptoad_create_ad",
      description:
        "CryptoAd Network: place an ad order. Paid from the account's balance when it covers the price, otherwise with a USDC payment of exactly the price from the agent's wallet. Quote the order first. Every ad is reviewed before it goes live: follow it with cryptoad_get_ad.",
      schema: z.object({ order: orderSchema }),
      invoke: async (wallet: WalletProvider, args: { order: Json }) =>
        guarded(() => paidCall(wallet, "/ads", args.order)),
    },
    {
      name: "cryptoad_get_ad",
      description:
        "CryptoAd Network: one ad of the account: status (in_review, active, paused, rejected, completed, archived), spend, what remains, and its delivery totals.",
      schema: z.object({ ad_id: z.number().int().positive() }),
      invoke: async (args: { ad_id: number }) =>
        guarded(async () => {
          const ad = await call("GET", `/ads/${args.ad_id}`);
          const stats = await call("GET", `/ads/${args.ad_id}/stats`);
          return answer({ ad: JSON.parse(ad), stats: JSON.parse(stats) });
        }),
    },
    {
      name: "cryptoad_list_ads",
      description: "CryptoAd Network: the account's ads, newest first, and the balance.",
      schema: z.object({}),
      invoke: async (_args: Record<string, never>) =>
        guarded(async () => {
          const ads = await call("GET", "/ads?limit=20");
          const balance = await call("GET", "/balance");
          return answer({ ads: JSON.parse(ads), balance: JSON.parse(balance) });
        }),
    },
  ]);

  return Object.assign(provider, { getApiKey: () => apiKey });
}
