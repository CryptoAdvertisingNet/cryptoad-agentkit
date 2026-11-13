// Runs the actions by hand, without a language model, to see what an agent
// gets back.
//
//   npm install && npm run build
//   WALLET_PRIVATE_KEY=0x... node examples/try-it.mjs            formats and a quote (free)
//   WALLET_PRIVATE_KEY=0x... node examples/try-it.mjs buy 5      buy $5 of ad credit
//
// The wallet needs USDC on Base for a purchase. It needs no ETH.
import { ViemWalletProvider } from "@coinbase/agentkit";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { cryptoAdActionProvider } from "../dist/index.js";

const privateKey = process.env.WALLET_PRIVATE_KEY;
if (!privateKey) throw new Error("set WALLET_PRIVATE_KEY");

// AgentKit reports each wallet it creates to Coinbase's analytics and does
// not wait for the answer. When that request fails, Node ends the process
// for an unhandled rejection. Only that one failure is ignored here.
process.on("unhandledRejection", (reason) => {
  if (String(reason?.stack ?? "").includes("sendAnalyticsEvent")) return;
  throw reason;
});

const wallet = new ViemWalletProvider(
  createWalletClient({ account: privateKeyToAccount(privateKey), chain: base, transport: http() }),
);
const provider = cryptoAdActionProvider({
  maxPaymentUsd: 25,
  // Store the key where your application keeps secrets. Here it is only counted.
  onApiKey: (key) => console.log(`(an API key of ${key.length} characters was issued and kept by the provider)`),
});
const actions = Object.fromEntries(provider.getActions(wallet).map((action) => [action.name, action]));
console.log("actions:", Object.keys(actions).join(", "));

const short = (text) => (text.length > 700 ? `${text.slice(0, 700)}\n...` : text);

if (process.argv[2] === "buy") {
  console.log(short(await actions.CustomActionProvider_cryptoad_buy_credit.invoke({ amount_usd: process.argv[3] ?? "5" })));
} else {
  const formats = JSON.parse(await actions.CustomActionProvider_cryptoad_list_formats.invoke({}));
  console.log("formats:", formats.formats.map((format) => format.product).join(", "));
  console.log(
    short(
      await actions.CustomActionProvider_cryptoad_quote_ad.invoke({
        order: {
          product: "PTC",
          name: "Quoted from AgentKit",
          landing_url: "https://example.com/",
          ad_title: "Have a look at this page",
          ad_description: "Open the page and look around for ten seconds.",
          product_options: { clicks: 10, duration_seconds: 10 },
        },
      }),
    ),
  );
}
