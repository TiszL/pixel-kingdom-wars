# Hero recruitment currency consent

New paid recruitments require both the receipt-capable v1 endpoint and a fresh
`features.gameCurrency = {version:1, exactSpendCurrency:1}` from the original
base's authenticated balance response. The presence of `features.gems` version1 /
receipts1 enables Gems selection. Choose Gems when they cover the whole price,
otherwise custodial KEEP when it alone covers it; never pool currencies. Exact
KEEP remains usable while Gems is paused. A missing enforcement capability cannot
prove a KEEP-only deployment, so new cash recruitment waits for an update.
Contract-only recruitment remains available on older servers.

The selected currency is optional local `intent.expectedCurrency`, outside the
server's strict request body. Save it before POST and send it as the command-local
`x-pkw-expected-currency` option on the original request and every explicit retry.
The quote, key, wallet/API/cluster identity, base and tile stay immutable. Contract
stock arriving after paid review may satisfy that original contract-first request.
A paid receipt must match the saved currency; a contract receipt is also valid.
Historical journals without the field retain their original body and behavior,
including accepting historical Gems proof without attaching new consent to a key.

Only the immediate first dispatch's typed `409 CURRENCY_CONSENT_CHANGED`, matching
the selected currency, can be durably marked `refusal` and `finished` without an
acceptance receipt. A subsequent review needs a distinct key. A missing response,
malformed receipt, interrupted storage write, or later retry refusal remains
uncertain. Automatic recovery is GET-only; receipt lookup precedes retry validation
so accepted work remains recoverable after funding, flags or ownership change.
There is no recruitment refund operation; recovery proves original acceptance and
actual funding rather than inferring a refund or minting replacement credit.


Coordinated final gate (2026-09-21): independent security review **SHIP**;
4,574 tests/319 established web files pass with zero skips. In-progress wallet-buy
primitives were excluded explicitly from this checkpoint and require their own gate.
The production web build passes at351KB gzip first paint (1,000KB hard budget).
