# How money works in Vidverse

There are two separate streams of money. They are kept apart on purpose, in the code and in what the site tells people.

| | Who earns it | Where it comes from | Built? |
|---|---|---|---|
| **Advertising** | You, the site owner | Google AdSense slots on video pages | Slots, policy, labelling and eligibility rules are built and tested. Real ads need an approved AdSense account. |
| **Tips and support** | Creators | Viewers, through Razorpay payment links; or creators' own links | Built and tested against a local stand-in for Razorpay. Never run against the real Razorpay. |
| **Revenue-share batches** | Creators | Money you have *already received* from a sponsor or membership programme | Built and tested. |

## Why creators do not get a share of AdSense income

Google's AdSense Help says that "publishers aren't allowed to distribute the earnings from their AdSense account with third parties" unless they first receive written permission from Google, and that Google rarely gives it ([Google AdSense Help: sharing earnings](https://support.google.com/adsense/answer/1348725)). Paying creators a cut of ad revenue would put your AdSense account, and your only ad income, at risk.

So the site is built around that rule:

- Ad income stays with you. The Help pages and the Earnings page say so in plain words, so no creator is promised something the site cannot pay.
- Creators earn from **tips**, from **their own support links** (shown on their channel), and from **revenue-share batches** that you fund from money other than AdSense.
- The revenue-share engine accepts a source called `adsense` only if the person posting the batch confirms, with a strictly boolean `true`, that they hold Google's written permission. Without it the batch is refused. This is a guard against doing the risky thing by accident; it is not a way to get permission.

If you ever get written permission from Google, the engine is ready for it. Until then, leave it alone.

## Advertising (AdSense)

### What the site does

- Shows up to two slots (under the player and beside it) on the **watch page of a public, finished video** and nowhere else. Not in the player, not on sign-in, settings, Studio or admin pages.
- Never shows ads to the **owner of the video**, or to **moderators and admins**, so nobody clicks their own ads (Google prohibits it).
- Pauses ads on a video while it has an **open report**, and gives them back when a moderator dismisses it. (Trade-off: a determined person can pause a competitor's ads by filing reports. One open report per person per video, and reports are rate-limited; a moderator decides.)
- Labels every slot "Advertisement", and removes the slot and its label when Google has no ad to show (no empty labelled boxes).
- Asks Google for **non-personalised ads** unless you deliberately set both `ADS_NON_PERSONALIZED=false` and `ADS_CONSENT_CONFIRMED=true` (see step 5). Either one alone changes nothing, and the Cookies page and Help article only talk about a consent message when personalised ads are really on.
- Serves `/ads.txt` from your `ADSENSE_CLIENT` or the line you give in `ADS_TXT`.
- Uses a slightly looser Content-Security-Policy **only on watch pages that show ad slots**, because Google's ad script needs it. Everything else keeps the strict policy. The browser tests check that the looser policy still blocks injected inline scripts.

### What you must do

1. Publish the site on your own domain with the legal pages filled in and reviewed. Google reviews the site before approving it.
2. Apply for AdSense. Wait for approval. (Ad slots stay off until `ADSENSE_CLIENT` and a slot id are set.)
3. Create two ad units in AdSense and put their ids in `ADSENSE_SLOT_WATCH_TOP` and `ADSENSE_SLOT_WATCH_SIDE`.
4. Add the `ads.txt` line AdSense shows you to `ADS_TXT`, or leave it empty to use the default line the site builds from `ADSENSE_CLIENT`.
5. **Visitors in the EEA, the UK and Switzerland.** This site has **no consent banner of its own**. Google says a Google-certified consent tool is required to serve *personalised* ads in those regions ([Google's consent requirements](https://support.google.com/admanager/answer/13554116)), and AdSense policy tells publishers to get consent for cookies and local storage "where legally required" ([AdSense Help](https://support.google.com/adsense/answer/7670013)), which can matter even for non-personalised ads. So:
   - The default is non-personalised ads, the lower-risk setting. It is not a promise that no consent is needed.
   - Before you serve ads to those regions at all, switch on Google's consent message in your AdSense account ("Privacy & messaging") or use another Google-certified tool, and ask a lawyer whether your site needs more.
   - Only if you want personalised ads, set `ADS_NON_PERSONALIZED=false` **and** `ADS_CONSENT_CONFIRMED=true`. The second one is you saying the consent message is on. Without it the site ignores the first and says so when it starts.
   - This has never been run against a real AdSense account (see `STATUS.md`).
6. Never click your own ads, never ask people to click them, and do not put wording like "click the ad to support us" anywhere. The site has none; do not add it.

### What AdSense will not do for you

It will not make money without visitors. See "Reality check" below.

## Tips

1. A viewer opens **Support** on a video or channel, picks ₹50, ₹100, ₹250, ₹500 or ₹1,000, or types another amount (₹20 to ₹50,000 by default), and may add a message.
2. The site creates a **Razorpay payment link** for that amount. The viewer pays on Razorpay's hosted page. Card and UPI details never touch this site.
3. Razorpay calls the site's webhook, `/webhooks/razorpay`, with a signed message. **Only a webhook with a valid signature can credit money.** The page the viewer returns to only shows what the site already knows.
4. The tip is split: **10% platform fee** (`PLATFORM_FEE_BPS=1000`) and the rest to the creator's balance. Every amount is whole paise in the database; no floating point is used for money.
5. The creator's share is **held for 7 days** (`HOLD_DAYS=7`) to cover refunds and disputes, then becomes available.
6. The creator adds **payout details** (a UPI address or an Indian bank account). They are validated, encrypted at rest (AES-256-GCM) and shown back only as a short hint such as `ri••••@okbank`.
7. After payout details are added or changed, payouts wait **24 hours**, so a thief with a stolen session cannot cash out at once.
8. The creator **requests a payout** (minimum ₹500). One open request at a time. An administrator with two-step verification on **reveals** the payout details (this asks for their password again and is written to the audit log), pays the creator **by hand** from your bank or UPI app, and marks the payout **paid** with the transaction reference. Nothing pays out automatically.
9. Creators see a statement and can download it as CSV (Excel-safe: formula characters are neutralised, and a byte-order mark keeps the rupee sign and Indian names intact).

### Practice mode

`PAYMENTS_PROVIDER=test` swaps Razorpay for a page on the site with "Pretend to pay" and "Cancel" buttons. It never moves money and **the site refuses to start in production with it**. Use it to try the whole flow on your own computer.

### Things that are not built

- **Refund webhooks.** Admins can refund a tip from the admin page, which reverses the ledger entries; but if a refund happens inside Razorpay's dashboard, the site is not told. Reconcile by hand until this is built.
- **Automatic payouts** (Razorpay Route or RazorpayX). Payouts are manual on purpose, until you have a lawyer's view (next section).
- **Tax handling.** The site does not calculate GST on your fee, TDS, or issue invoices.

### Read this before turning on live tips

Taking money from viewers into your account, holding it for a creator and passing it on later looks like what Indian payment regulation calls **payment aggregation**, which in India needs authorisation from the Reserve Bank of India (see the Reserve Bank of India's [Master Direction on Regulation of Payment Aggregator (PA)](https://rbi.org.in/SCRIPTs/BS_ViewMasDirections.aspx?id=12896), September 2025). Whether your arrangement is covered depends on how you set it up with Razorpay (for example, a marketplace or split-payment product in which Razorpay settles directly to the creator may change the answer). This is not something software can decide. **Ask a lawyer or chartered accountant, and ask Razorpay, before you switch on live tips.** Until then, leave `PAYMENTS_PROVIDER=off`: the site works without it and the Support buttons do not appear.

## Revenue-share batches

For money you have already received and want to share (a sponsor who paid you ₹50,000 for a month of the platform, a membership programme):

1. An administrator with two-step verification creates a **batch**: a label, the source, the amount received, the percentage that goes to creators, and a period (start and end date).
2. The site totals **qualified watch time** per creator for the period. Only finished videos of active creators who have accepted the current creator terms count.
3. The administrator previews the split, then **posts** it. The creators' pool (the amount times the creators' percentage) is divided by watch time in whole paise, so the shares always add up to the pool exactly. The rest stays with the platform.
4. A batch can be posted once. The audit log records who did what.

**Honest warning:** anything paid on watch time can be gamed by people who fake watch time. The site credits watch time on the server (a view needs 30 seconds or half the video, whichever is less, with caps on how fast time can pile up), but no counting method is fraud-proof. Keep batches small until you trust the numbers, and read the audit pages.

## Healthy engagement instead of "addiction" and clickbait

You asked for a site people come back to and click-driven earnings. The site is built to make people come back **because it is good**, not because it traps them, and to reward videos that deliver what their title promises:

- **Ranking.** Reach comes from people liking what they clicked. The average share of a video that viewers actually watch is **squared** in the score, so a misleading title or thumbnail (many clicks, early exits) sinks, and an honest one rises. New videos get a short, fair boost to gather signal. The Trending page says this in plain words.
- **Reasons to return that are the viewer's own:** a Subscriptions feed in strict newest-first order, Continue watching, Watch later, Liked videos, optional notifications, and search.
- **No compulsion tricks:** autoplay can be turned off; after three videos in a row start on their own, the site asks "still watching?"; a private "time watched" page shows today's and the week's minutes; an optional daily reminder; no marketing email; no streaks or fake urgency.

That is not a limitation on your income. Advertisers, AdSense and creators all do better with an audience that trusts the site. Deceptive click-bait and compulsion loops can also get an AdSense account refused or closed, and they are the pattern consumer-protection regulators look at first.

## Reality check

- **Ads need traffic.** AdSense pays per thousand views and per click. Typical rates on a new site are small. The cost of delivering video (storage and bandwidth) is usually the number that decides whether a video site can pay for itself. Run `npm run economics -- --views 100000` and replace every default with real prices from your provider. Every default in that script is a placeholder, not a forecast.
- **Video is the expensive kind of site.** Start with the `fast` transcoding profile, a small upload limit, and a cheap object store or CDN in front of the media folder when traffic grows (the storage layer is local disk today; see `STATUS.md`).
- **Nothing here is financial, legal or tax advice.** It describes what the software does.
