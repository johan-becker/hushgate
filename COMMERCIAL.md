# Commercial licensing

You are probably here because you read the [licence](LICENSE) and worked out
that your use of hushgate needs one. This page explains, in plain language, who
needs a commercial licence, what to send me, and what you are buying. No forms,
no portal, no sales team — there is one person here.

## The short version

hushgate is **source-available**, not open source. The
[Business Source License 1.1](LICENSE) lets a lot of people use it in
production for free. Two groups it does not cover:

1. **Larger organisations in production.** More than 10 people, counting
   employees and independent contractors across all entities under common
   control.
2. **Anyone offering hushgate to third parties** as a hosted, managed, embedded
   or resold offering — at any size, including a two-person company.

Everything else is free, forever, with no registration and no phoning home:

- any **non-production** use at any size — evaluation, development, staging,
  CI, security review, a proof of concept for your board;
- **production** use by an organisation of 10 or fewer people;
- **production** use by an individual, personally;
- **production** use by non-profits, registered charities and accredited
  educational institutions, regardless of headcount — still subject to (2).

And each published version converts automatically to the
[Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0)
four years after it is published.

## Worked examples

| Situation | Licence needed? |
| --- | --- |
| **A 40-person SaaS company** runs hushgate in its own request path, in production, for its own product's LLM calls. Nobody outside the company touches it. | **Yes.** Over 10 people, in production. The use is internal, which is exactly what the commercial licence is for — it is not a competitor problem, it is a headcount threshold. |
| **A 6-person agency** runs hushgate in production on its own infrastructure to sanitise prompts for its own internal tooling. | **No.** 10 or fewer people, and it is not being offered to anyone else. |
| **The same 6-person agency** now runs a hushgate instance per client, as a managed service the clients pay for. | **Yes.** Size stops mattering the moment the software is offered to third parties on a hosted or managed basis. |
| **A hosting provider** offers "PII filtering, powered by hushgate" as a product to its customers. | **Yes**, at any size. This is the case the licence exists for. |
| **A university** deploys hushgate for a 900-person department, in production. | **No.** Accredited educational institutions are free regardless of headcount — as long as they are not offering it on to third parties as a service. |
| **A solo freelancer** runs hushgate in production for her own consultancy's work. | **No.** An individual, or an organisation of one. |
| **The same freelancer** builds a client a product with hushgate embedded, and the client is a 300-person insurer who will run it in their own production. | **The client needs a licence**, not the freelancer. The licence follows the organisation that runs it in production. Tell them early; it is a bad surprise at go-live. |
| **A 2,000-person bank** evaluates hushgate for six months in a lab, against real traffic captures, never in production. | **No.** Non-production use is free at any size. Come back when it goes live. |

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

**"Can we get a perpetual licence rather than a subscription?"** Ask. It is a
reasonable thing to want for on-premises infrastructure software and I would
rather discuss it than lose you over the billing model.

## Trade marks

A commercial licence covers the code. It does not grant rights in the hushgate
name or logo — see [TRADEMARKS.md](TRADEMARKS.md).

---

Copyright © 2026 Johan Becker. Nothing on this page is a contract or an offer;
it describes how to start a conversation that leads to one.
