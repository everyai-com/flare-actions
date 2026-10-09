# x402 spike: machine-to-machine capacity purchasing

**Status: mapped, not wired.** This doc is the design spike; the only
code is the quote stub (`x402Quote` in `cloud.ts`, served at
`POST /v1/cloud/x402/quote`). Nothing here takes money — `payTo` is
null until Flare Cloud provisions a settlement address.

## Why x402

Agent purchasing means an agent buys runner capacity without a human
billing event per run. [x402](https://www.x402.org/) (Coinbase's open
payment standard) fits: HTTP-native, no accounts, no API keys — a 402
response carries the payment requirement, the client retries with an
`X-PAYMENT` header, a facilitator settles on-chain and the server
verifies before fulfilling. The agent's wallet pays; the human only
tops up the wallet.

## The mapped flow

1. Agent: `POST /v1/cloud/x402/quote { runners: 2 }` → quote
   (`amountCents: 9800`, `asset: USDC`, `network: base`,
   `expiresAt: +15m`). Pricing is public; quotes are free.
2. Agent builds an x402 `PaymentPayload` (USDC on Base to `payTo`)
   and calls `POST /v1/cloud/x402/purchase { quoteId, payment }`.
   (Not built — this is where the spike ends.)
3. Server verifies the payload with a facilitator, and on success
   calls `grantCredits` with `ref = x402:<paymentHash>` — the
   ledger's idempotency makes retried purchases credit once, exactly
   like retried billing webhooks and top-up redeems.
4. Credits fund runs through the normal metering path
   (`docs/HOSTED.md`); the agent tops up its own wallet out of band.

## Why this shape

- **Quotes before payment.** Amounts are deterministic (whole
  runner-months at the $49 founding rate), so the quote is pure and
  cacheable; expiry bounds price drift.
- **Ledger-native settlement.** Fulfillment is just a grant with a
  deterministic ref — no new money path, no new races. Double-spend
  collapses into the existing exactly-once machinery.
- **No accounts.** The wallet is the identity; the payment hash is
  the receipt. Agents hold budgets as wallet balances, not Flare
  logins — matching the prepaid-credits model (buy runner-months,
  approval-link top-ups for humans).
- **Chain choice is a default, not a lock.** Base/USDC keeps fees
  negligible for $49 tickets; the quote names asset + network so a
  future facilitator can offer alternatives.

## Open questions (for the wiring pass)

- Facilitator: run our own verifier vs. a hosted facilitator (uptime
  vs. trust tradeoff); verify-before-fulfill is mandatory either way.
- Quote binding: `quoteId` rows vs. stateless signed quotes (D1 rows
  are simpler and auditable; TTL sweep reuses the prune pattern).
- Minimum ticket: L1 fees make sub-dollar purchases silly — runner
  granularity already keeps tickets ≥$49.
- Refunds: credit-ledger reversal rows (a `refund` kind) vs. on-chain
  refunds; ledger-side keeps everything in one audit trail.
