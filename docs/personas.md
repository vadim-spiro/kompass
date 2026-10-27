# Kompass personas

Kompass is the decision layer for MAINGAU Energie: a Next Best Action (NBA) engine, an orchestration workspace for marketing, and a Customer 360° view for service. These personas are fictional, built from the challenge slides, the mock data, and the research brief. Each one has acceptance checks the UI must pass. Validate them with the MAINGAU contacts named under each persona.

---

## 1. Clara Neumann, CRM & Campaign Lead (primary user)

- 38, eight years in energy marketing, owns newsletters, retention and cross-sell campaigns.
- Today: 13 newsletters a year to all subscribers, segments built by the data team in Excel, results reported as open rates.
- Judged on: renewals at price-guarantee end, cross-sell rate, unsubscribes. From now on: expected CLV gain.

**Jobs to be done**
1. See where the money is: which offers and segments carry the most expected CLV gain this week.
2. Steer the engine without code: switch offers on/off, set priorities, set contact limits.
3. Approve what goes out, in batches, with confidence nothing breaks consent.
4. Prove to management that a campaign worked.

**Frustrations:** waiting days for segments; Liquid code for Du/Sie; can't explain why someone got a mail; open rates that lie (Apple MPP).

**Acceptance checks**
- [ ] Overview answers "how much CLV is on the table and what needs my approval?" in under 5 seconds, with no scrolling.
- [ ] Changing an offer's priority or the contact limit shows the effect on ranking and totals right away.
- [ ] Approving 50 proposals takes one action, with a preview of a Du and a Sie example first.
- [ ] Every proposal shows a one-line reason in plain language.
- [ ] Uplift vs control group is visible per offer, never open rates.

---

## 2. Mehmet Arslan, Service Agent (Customer 360° user)

- 29, phone and chat agent, 40–60 contacts a day, uses the CRM plus the agent-assist pilot.
- In the pilot he dismissed most offer suggestions because customers were upset.

**Jobs to be done**
1. Understand the customer in 10 seconds: products, contracts, open cases, mood, tone.
2. Know whether to offer anything or fix the problem first.
3. Log what happened in one click.

**Frustrations:** offers that ignore an open complaint; no context on why an offer appears; having to read five systems.

**Acceptance checks**
- [ ] Customer 360° header shows products, open cases, CLV and churn risk without scrolling.
- [ ] If there is an open complaint or dunning, the top action is service-first, and sales offers are visibly blocked with the reason.
- [ ] The recommended salutation (Du/Sie) and the evidence for it are visible.
- [ ] One-click feedback: "mentioned / not relevant / customer upset".

---

## 3. Jonas Weber, Product Manager B2C Energy

- 34, owns StromGarant, StromWärme and the dynamic tariff.
- Wants his products in front of the right customers, not everyone.

**Jobs to be done**
1. See how many customers are eligible for his product and what blocks the rest.
2. Catch signals like gas meter deregistration (likely heat pump) the same day.
3. Know which channel and tone convert for his product.

**Acceptance checks**
- [ ] Offer catalog shows eligible customers, expected CLV gain and the top blocking reason per offer.
- [ ] Live events show a gas meter deregistration turning into a StromWärme recommendation.
- [ ] Experiments show conversion by channel and tone for his offers, against control.

---

## 4. Fatima Yilmaz, Digital Channels & E-Commerce

- 31, owns portal, app, push and the Shopware shop.
- Cares about frequency, placement and not burning the app audience.

**Jobs to be done**
1. Control channel order and frequency caps per channel.
2. Preview exactly what appears in the portal pop-up or app push.
3. See wallbox buyers who don't have Autostrom yet.

**Acceptance checks**
- [ ] Channel order and per-channel limits are editable in one place.
- [ ] Message preview renders per channel (portal, app, email, SMS, call script).
- [ ] Segment filter "wallbox buyers without Autostrom" is one click from the overview.

---

## 5. Ralf Becker, Data Architect & Compliance

- 45, owns the Databricks master view, data quality and the DPO relationship.

**Jobs to be done**
1. Trust the data: freshness per source, duplicates, late events.
2. Audit any decision: inputs, rules fired, scores, chosen action, approver.
3. Prove zero consent or exclusion violations.

**Acceptance checks**
- [ ] Compliance view shows the violation checker result over all customers (target: 0) and per rule.
- [ ] Decision log entries open to inputs → rules → scores → action.
- [ ] Data freshness per source is visible, with duplicate and late event counts from the replay.
- [ ] Full OpenAPI spec available from the app.

---

## Design principles derived from the personas

1. **Summary before detail.** Every screen opens with the answer, then the evidence.
2. **Plain language over model language.** "Price guarantee ends in 41 days" not "pg_days_left=41".
3. **Blocked is a first-class state.** Show what the engine refused to do and why.
4. **Human in the loop by default.** Nothing leaves without approval.
5. **CLV everywhere.** Every action carries expected € gain; negative values are shown, not hidden.
6. **German customer content, English UI.** Matches the challenge rules.
