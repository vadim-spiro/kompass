# Kompass: notes for the data team

Kompass is the workspace for MAINGAU's CRM and service teams on top of our insights service. The insights service scores the 30.09. snapshot: CLV, churn risk and the next best action per customer, with expected ΔCLV. Kompass turns that into work:

- **Campaigns:** audience, timing, messages per channel, review and send.
- **Automations:** flows that run on stream events and every morning.
- **The live day:** the 01.10. event stream, replayed. Each event re-ranks that customer.
- **The service desk.**
- **Analytics** over all 12 datasets, with uplift against the control group.
- **The assistant,** which works the screens for you.

Every message waits for a human. No AI path can send, approve or launch.

## Run it

```bash
npm run install:all   # once
npm run dev           # workspace server on :8787, UI on :5173
```

- **API base:** `http://localhost:8787/api`. The UI reaches the same routes through `/api` on :5173.
- **Spec:** `api/openapi.yaml`, also served at `/api/openapi.yaml`. It covers the workspace routes: campaigns, automations, approvals, settings and the assistant. The live, analytics and outreach routes are listed below.
- **Insights service:** the team server by default; `INSIGHTS_URL` in `.env` points elsewhere. Its routes are passed through unchanged at `/api/insights/*`, so `GET /api/insights/overview` is the service's `/overview`.
- **LLM:** only the assistant uses it, configured in `.env`. Every decision and every number works without it. With `?demo=1` in the UI, the assistant plays fixed scripts (`server/src/demo.ts`) for the two requests in the demo video. The tool calls still run for real.
- **Logs:** `server/logs/kompass.log`, or `GET /api/logs`.

## Routes worth evaluating

| Route | What it gives you |
|---|---|
| `GET /home` | Today's numbers: 750 customers, revenue at risk, customers with an action, the value of taking every next best action, savings. |
| `GET /customers/:id/360` | One customer: the insights profile with the live overlay (consent, service case, blockers), playbook and timeline. |
| `POST /campaigns/:id/plan` | Who gets what for a campaign: one row per customer, contacted or left out, with the reason. Our own rules (below) are applied on top of the engine's gates. |
| `GET /campaigns/:id/best-times` | Each contact's most active time slot (7–11, 11–15, 15–18, 18–22 h). The signals are offers they viewed, clicked or bought (weighted ×3), charging starts, and tickets they opened. Below 3 signals, the audience's best slot for the channel is used. |
| `GET /live` · `POST /live/advance {"to":"2026-10-01 12:00:00"}` · `POST /live/reset` | The replayed day: clock, events, every decision with the rules that fired and the top action before and after, the service desk. |
| `GET /live/customers/:id` | A customer's live ranking: actions with ΔCLV and reason, blocked offers and why, flags. |
| `GET /analytics/catalog` · `POST /analytics/run` | The semantic layer and the chart runner. `{"source":"offers","x":"c_tone","measures":["conversion_rate","uplift"]}` returns rows, n per cell and a one-line insight from a two-proportion z-test: “Conversion rate: Du 4,2 % vs Sie 2,9 % (n = 569 / 1.701), not a significant difference (p = 0,14).” Below n = 30 it warns. |
| `GET /outreach/audiences` | The ready-made audiences in the campaign gallery, built from `/segments`, `/pains`, `/retention/guarantee-calendar`, `/savings/summary` and `/growth/offers`. |

## The live overlay

`server/src/engine.ts` re-ranks the insights service's actions for "now", using what the stream delivered since the snapshot. Every place that decides or renders for a customer reads the profile through it, so the 360, campaigns, automations and approvals always agree.

- **A withdrawn consent** closes its channel at once, and queued messages on it are cancelled.
- **Dunning, an open complaint or a pending cancellation** block sales. Service comes first.
- **An agent's "customer upset" feedback** pauses offers for 30 days.
- **A fresh signal lifts the offer it points to.** For example, a gas meter deregistration lifts StromWärme.
- **A sales contact during a service case** is priced with the churn it adds: +0.05, from `value_assumptions`.
- **Service resolution** costs 15 €.
- **Contact costs** per channel come from the mock data.

### Assumptions we added

These are not in the dataset, so please challenge them. They live in `server/src/engine.ts` (`signalsFrom`, `CHANNEL_ORDER`).

| Signal in the stream | Offer it lifts | Acceptance we assume |
|---|---|---|
| Gas meter deregistered (likely a heat pump) | StromWärme | 0.30 |
| Says they want to leave (call, ticket) | StromGarant | 0.45 |
| Cancellation received | StromGarant | 0.20 |
| Cart left in the shop | that product | 0.25 |
| Bought a wallbox | Autostrom / smart charging | 0.20 / 0.15 |
| Bought a charging cable | Autostrom | 0.15 |
| Clicked smart living or heat in a newsletter | that offer | 0.12 / 0.15 |
| Used 80 % (100 %) of the mobile data volume | bigger mobile plan | 0.20 (0.30) |
| Channel order when the engine's channel is closed | — | portal pop-up, email, newsletter, SMS, phone |

The value of a new recurring product is its catalog margin per year × 3.76, the present value of 1 € a year over 10 years at 6 % discount and 14 % churn (from `value_assumptions`).

## Our rules on top of the engine

These are set in Settings and saved in the workspace.

| Rule | Default |
|---|---|
| Contact limit | 2 per 30 days overall. Per channel: SMS 1, call 1, portal pop-up 2, email 2, newsletter 4. |
| Quiet days after a complaint | 14. Service contacts are still allowed. |
| Channel switches | All on. A channel switched off leaves campaigns, and automations skip it. |
| Second approver | Required for campaigns. |
| Control group | Every campaign keeps one. |

## The event stream (01.10.)

| Fact | Count | How Kompass handles it |
|---|---|---|
| Events | 647 | Applied when they were ingested, not when they happened, as the systems delivered them. |
| Duplicates | 12 | Dropped by `event_id`. |
| Late arrivals (> 1 h) | 45 | Applied when they arrive, and flagged as late. |

## Current numbers

Snapshot 30.09.2026, workspace after `POST /workspace/reset`:

| Number | Value |
|---|---|
| Customers | 750 |
| Revenue at risk | 72.637 € |
| Customers with a next best action | 499 |
| Value of taking every next best action | +16.774 € |
| Savings found in customer data | 23.616 € |
| Customers with an open service case | 151 |

These numbers move once the day is replayed, because the live overlay re-ranks customers.

## Where you could help most

1. **Acceptance model.** Calibrate the insights service's acceptance probabilities against the control groups in `nba_actions`. In Analytics, "Which channel beats its control group?" is the starting point.
2. **Best send time.** The slots come from three activity signals. Check whether they predict opens better than one fixed time.
3. **Assumptions.** Sanity-check the values in the table above.
4. **New traps.** Tell us about any data trap we have missed, ideally with the customer IDs.
