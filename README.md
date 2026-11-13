# cryptoad-agentkit

A [Coinbase AgentKit](https://github.com/coinbase/agentkit) action provider for
[CryptoAd Network](https://cryptoadvertising.net/agents). It lets an agent buy
crypto advertising on its own: read the formats, quote an order, pay in USDC
from its wallet through [x402](https://www.x402.org), and follow the ads.

The ads are shown to real crypto users: users of FaucetPay and visitors of the
publisher sites in the network. There is no account to open and no API key to
apply for. The smallest order costs $0.05.

## Install

```
npm install github:CryptoAdvertisingNet/cryptoad-agentkit @coinbase/agentkit
```

(Once the package is on npm: `npm install cryptoad-agentkit`.)

## Use

```ts
import { AgentKit } from "@coinbase/agentkit";
import { cryptoAdActionProvider } from "cryptoad-agentkit";

const agentKit = await AgentKit.from({
  walletProvider, // an EVM wallet holding USDC on Base, Polygon or Arbitrum
  actionProviders: [
    cryptoAdActionProvider({
      maxPaymentUsd: 25,
      apiKey: process.env.CRYPTOAD_API_KEY, // from an earlier run, if any
      onApiKey: async (key) => saveSecret("CRYPTOAD_API_KEY", key),
    }),
  ],
});
```

## Actions

| Action | What it does | Costs |
| --- | --- | --- |
| `cryptoad_list_formats` | The ad formats with their fields, limits, prices and an example order each | nothing |
| `cryptoad_quote_ad` | The exact price of an order; creates nothing | nothing |
| `cryptoad_buy_credit` | Buys prepaid ad credit with USDC from the wallet (1 USDC = $1.00) | the amount |
| `cryptoad_create_ad` | Places an ad, from the balance or with a payment of exactly its price | the price |
| `cryptoad_get_ad` | One ad: status, spend, delivery | nothing |
| `cryptoad_list_ads` | The account's ads and the balance | nothing |

## What it will and will not pay

- Only CryptoAd Network's receiving address
  (`0x1313c840F693EB2d8FD4Bb3B8Ed9e55B134B47D8`), only in Circle's USDC, on the
  network the wallet is on (Base, Polygon or Arbitrum).
- Never more than `maxPaymentUsd` in one payment (default 25). A request
  above it is refused before anything is signed.
- The wallet needs no ETH. A payment is a signed authorization (EIP-3009) and
  the facilitator pays the gas.

## The API key

The first payment opens an account and returns its API key. The provider
keeps the key and uses it for the later calls; the model never sees it. The
key is the account, and it is shown once: store it with `onApiKey` and pass
it back as `apiKey` the next time. `provider.getApiKey()` returns the key held
right now.

## Try it without a model

```
npm install && npm run build
WALLET_PRIVATE_KEY=0x... node examples/try-it.mjs          # formats and a quote
WALLET_PRIVATE_KEY=0x... node examples/try-it.mjs buy 5    # buy $5 of ad credit
```

## Links

- The API for a language model: https://cryptoadvertising.net/llms.txt
- OpenAPI: https://cryptoadvertising.net/openapi.json
- MCP server: https://cryptoadvertising.net/mcp
- More examples: https://github.com/CryptoAdvertisingNet/cryptoad-agent-examples

## License

MIT
