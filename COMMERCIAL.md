# Commercial licensing

You are probably here because you read the [licence](LICENSE) and worked out
that your use of hushgate needs one. This page explains, in plain language, who
needs a commercial licence, what to send me, and what you are buying. No forms,
no portal, no sales team — there is one person here.

**Evaluation is always free.** You do not need a licence, a key, a trial
request, or a conversation with me to try hushgate — at any organisation size,
for as long as you need. Non-production use is free under the licence itself.
Read on only if you are taking it to production.

## The short version

hushgate is **source-available**, not open source. The
[Business Source License 1.1](LICENSE) lets a lot of people use it in
production for free. This page paraphrases it; [LICENSE](LICENSE) is what
actually governs, and where the two differ the licence wins.

Two groups the free grant does not cover:

1. **Larger organisations in production.** More than 10 people. You count one
   each, regardless of hours worked: every employee, officer, independent
   contractor, freelancer, intern, working student, apprentice, and every
   individual supplied to you by a staffing or temporary-employment agency —
   across all entities under common control. Non-executive directors and
   shareholders who do no work for the organisation are not counted. Full
   rules [below](#how-the-10-are-counted).
2. **Anyone offering hushgate to third parties** as a hosted, managed or
   embedded **commercial offering** — at any size, including a two-person
   company. Reselling copies of hushgate is not this: redistribution is granted
   by the licence outright.

Everything else is free, forever, with no registration and no phoning home:

- **copying, modifying, forking and redistributing** hushgate, at any size —
  the licence grants those outright and the two conditions above limit
  production use only, never these;
- any **non-production** use at any size — evaluation, development, staging,
  CI, security review, a proof of concept for your board;
- **production** use by an organisation of 10 or fewer people;
- **production** use by an individual, personally;
- **production** use by non-profits, registered charities and accredited
  educational institutions, regardless of headcount — still subject to (2).

And each published version converts automatically to the
[Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0)
four years after it is published.

## How the 10 are counted

You count as one individual each, regardless of hours worked: every
**employee, officer, independent contractor, freelancer, intern, working
student, apprentice**, and every individual supplied to you by a **staffing or
temporary-employment agency** (Zeitarbeit). You do **not** count non-executive
directors, or shareholders who perform no work for the organisation.

"Your organisation" is the legal entity you work for plus every organisation
that controls it, that it controls, or that is under common control with it —
so a 4-person subsidiary of a 900-person group counts the group.

The count is taken **on the first day of each calendar quarter**. Hiring your
eleventh person on 5 February does not end your free grant mid-quarter.

**And there is a 90-day grace period.** When your count first exceeds 10, the
free grant continues to apply to you for a further **90 days** from that date,
so that you can obtain a commercial licence or wind down production use without
being out of compliance on the day the offer letter is signed. Mail me inside
that window and you will not be chased.

## What counts as "offering it to third parties"

Condition (2) is about selling hushgate's functionality to people outside your
organisation. The licence draws the line explicitly, and most of the cases
people worry about fall on the free side of it:

- **Your own employees and independent contractors are not third parties.**
  Running one shared hushgate for your own staff and freelancers is not an
  offering.
- **Running hushgate for your organisation's own internal purposes is not an
  offering.** It does not matter how many customers your organisation has, or
  that its product makes LLM calls through hushgate — your customers are not
  being offered hushgate.
- **Using hushgate as an internal component of a product whose value to your
  customers does not consist substantially of hushgate's functionality is not
  an offering.** If they are buying a scheduling tool, a support desk or a CRM
  and hushgate happens to sanitise the prompts inside it, that is not the case
  this condition is for.

What it *is* for: hushgate, or its functionality, being the thing the customer
is paying for — "PII filtering, powered by hushgate", a managed hushgate
instance per client, an appliance whose selling point is the gateway.

If your product sits near that line, mail me rather than guess. This is exactly
the nuance a plain-language summary cannot settle on its own; the wording that
decides it is in [LICENSE](LICENSE).

## Worked examples

| Situation | Licence needed? |
| --- | --- |
| **A 40-person SaaS company** runs hushgate in its own request path, in production, for its own product's LLM calls. Nobody outside the company touches it. | **Yes** — on headcount alone. The use is purely internal and is *not* an offering to third parties; it is over 10 people, and that is the whole reason. It is not a competitor problem, it is a threshold. |
| **An 8-person SaaS company** embeds hushgate inside its scheduling product to sanitise prompts before its own LLM calls. Its customers are buying scheduling. | **No.** 10 or fewer people, and an internal component of a product whose value is not substantially hushgate's functionality is explicitly not an offering to third parties. |
| **A 6-person agency** runs hushgate in production on its own infrastructure to sanitise prompts for its own internal tooling. | **No.** 10 or fewer people, and it is not being offered to anyone else. |
| **The same 6-person agency** now runs a hushgate instance per client, as a managed service the clients pay for. | **Yes.** Size stops mattering the moment hushgate itself is offered to third parties on a hosted or managed basis. |
| **A 7-person company** runs one shared hushgate that its employees and its two freelancers use. | **No.** Your own employees and independent contractors are not third parties. |
| **A hosting provider** offers "PII filtering, powered by hushgate" as a product to its customers. | **Yes**, at any size. Here hushgate's functionality *is* what the customer is buying. This is the case the licence exists for. |
| **A university** deploys hushgate for a 900-person department, in production. | **No.** Accredited educational institutions are free regardless of headcount — as long as they are not offering it on to third parties as a commercial offering. |
| **A solo freelancer** runs hushgate in production for her own consultancy's work. | **No.** An individual, or an organisation of one. |
| **The same freelancer** builds a client a product with hushgate embedded, and the client is a 300-person insurer who will run it in their own production. | **The client needs one; she probably does not.** Delivering a bespoke product in which hushgate is an internal component is not an offering, provided the product's value to the client is not substantially hushgate's functionality — if she is selling them a PII gateway, it is. The insurer needs a licence for its own production use, on headcount. Tell them early; it is a bad surprise at go-live. |
| **A 9-person startup** hires four people; on 1 April the count is 13. | **Yes, but not yet.** The count is taken on the first day of the quarter, and the free grant then runs for 90 more days. You have until roughly the end of June to license or to stop. |
| **A 2,000-person bank** evaluates hushgate for six months in a lab, against real traffic captures, never in production. | **No.** Non-production use is free at any size. Come back when it goes live. |
| **A 500-person company** forks hushgate, patches a detector, and publishes the fork under its own name. It does not run it in production. | **No.** Copying, modifying and redistributing are granted outright; the size and offering conditions limit production use only. (The name is a separate matter — see [TRADEMARKS.md](TRADEMARKS.md).) |

If your case is not on that list and you genuinely cannot tell, mail me and
ask. Asking costs nothing and I would rather answer than have you guess.

## What to put in the mail

Send to **jo_becker@mailbox.org**. Useful, in roughly this order:

- **Who you are** — legal entity name, country, and the approximate number of
  people (employees plus contractors, across affiliates).
- **What you want to do with it** — internal production use, embedded in a
  product you ship, offered as a service to your customers.
- **Roughly how much** — number of production instances or environments, order
  of magnitude of requests, number of tenants if you use multi-tenancy.
- **Which version** you intend to run, and when you want to go live.
- **What your procurement needs** — a specific contract paper, a DPA, an
  invoice with a VAT ID, a security questionnaire. Say so up front; it is the
  part that takes the time.
- **Anything you need changed** in the software to make it work for you.

You will get a reply from me, not from a CRM.

## Pricing

**Pricing is quoted per case.** There is no published price list, because there
are not yet enough deals behind me to publish one honestly. A quote depends on
your size, how you deploy it, and what you need alongside the licence. Tell me
what you are doing and you will get a number and a reason for that number.

What is fixed: the price is a licence fee for production use, invoiced from
Germany, and I do not price by how much personal data you process.

## What you are buying, and what you are not

**You get:**

- the right to run hushgate in production for the use you describe, outside the
  free grant in the licence;
- the same source you already have — there is no separate "enterprise edition",
  no feature held back, no licence key, and no telemetry;
- new versions released during your term, each carrying its own Change Date;
- a direct line to the person who wrote it, for bugs and questions.

**You are not getting:**

- a 24/7 on-call rota. I am one developer in Karlsruhe, in one time zone. I
  will not sign a response-time commitment I cannot personally honour at three
  in the morning, and you should be suspicious of a solo vendor who does.
- a hosted service. hushgate runs on your infrastructure; that is the point of
  it.
- an indemnity or a liability position agreed in advance. Send me your paper
  and we will work through it; expect the limits a one-person supplier can
  realistically carry.

## Questions I get asked

**"Why pay, if it becomes Apache-2.0 in four years anyway?"** Because you want
to run *this* version *now*. Each version's four-year clock starts when that
version is published, so the code you would wait for is the code that is four
years old. The fee buys production rights today, plus every version released
during your term.

**"Is it open source?"** No, and I would rather say so plainly than stretch the
term. It is source-available: you get the complete source, you can read it,
build it, modify it, and run it under the terms in [LICENSE](LICENSE) — and it
becomes genuine open source on a schedule that is written into the licence.

**"Can we see the source before we buy?"** You already can. All of it is in
this repository. Nothing is withheld from the free tier.

**"We are over 10 people but only using it in staging."** Then you need
nothing. Non-production use is free at any size.

**"We embed hushgate inside our own product. Is that an 'embedded commercial
offering'?"** Not on its own. The licence says in as many words that using
hushgate as an internal component of a product whose value to your customers
does not consist substantially of hushgate's functionality is *not* an offering
to third parties. If you are under the size grant, that is free. It becomes an
offering when hushgate's functionality is what your customers are buying.

**"We just went over 10 people."** You have 90 days from the day the count
first exceeded 10, and the count is only taken on the first day of each
calendar quarter. Nothing breaks, nothing phones home, and there is no
retroactive claim for the window. Mail me inside it.

**"Can we resell hushgate?"** Redistribution is granted by the licence
outright, so passing copies on is not what the commercial licence is about.
What needs one is offering it to third parties as a hosted, managed or embedded
commercial offering — and whoever ends up running it in production still needs
to be inside the grant themselves. The name is separate: see
[TRADEMARKS.md](TRADEMARKS.md).

**"Can we get a perpetual licence rather than a subscription?"** Ask. It is a
reasonable thing to want for on-premises infrastructure software and I would
rather discuss it than lose you over the billing model.

## Trade marks

A commercial licence covers the code. It does not grant rights in the hushgate
name or logo — see [TRADEMARKS.md](TRADEMARKS.md).

---

Copyright © 2026 Johan Becker. Nothing on this page is a contract or an offer;
it describes how to start a conversation that leads to one.
