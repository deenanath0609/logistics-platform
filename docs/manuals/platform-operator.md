# Platform operator manual

For the people who run the City Logistics platform itself: the owner of the
business, and whoever supports carriers on their behalf.

There are very few of you and your logins are the most powerful in the
product. An operator can create a carrier, move its hostname, suspend it,
change what it has paid for, and — under a written, time-boxed grant — sit
inside its own application. Nothing above you approves any of that. The
console's help screen puts it plainly, and it is worth repeating here: there
is no support desk above this one. The record of what you did is the control.

This manual describes the console as it is built today. Where something is
described in the product but not implemented, it is marked **Not built yet**
and says so in the text rather than in a footnote.

---

## Contents

1. [The three hosts, and why they are separate](#1-the-three-hosts-and-why-they-are-separate)
2. [Signing in, and creating the first operator](#2-signing-in-and-creating-the-first-operator)
3. [Operator roles and the capability matrix](#3-operator-roles-and-the-capability-matrix)
4. [The estate: overview, tenant list, tenant detail](#4-the-estate-overview-tenant-list-tenant-detail)
5. [Provisioning a carrier](#5-provisioning-a-carrier)
6. [Plans and modules](#6-plans-and-modules)
7. [Lifecycle: active, suspended, closed](#7-lifecycle-active-suspended-closed)
8. [White-label and outside-service accounts](#8-white-label-and-outside-service-accounts)
9. [Support sessions](#9-support-sessions)
10. [The operator log](#10-the-operator-log)
11. [What an operator may not do](#11-what-an-operator-may-not-do)
12. [Running the platform: certificates, backups, drills](#12-running-the-platform-certificates-backups-drills)
13. [What is not built yet](#13-what-is-not-built-yet)
14. [Command reference](#14-command-reference)

---

## 1. The three hosts, and why they are separate

The deployment answers to one root domain, `lms.credohrms.com`, and the host
in the request decides which of three applications is served.

| Host | What it serves |
|---|---|
| `lms.credohrms.com` | The operator console, under `/platform` |
| `admin.lms.credohrms.com` | The same console — an accepted alias |
| `<carrier>.lms.credohrms.com` | One carrier's own application |

The demo carrier is `city-logistics`, at `city-logistics.lms.credohrms.com`.

The separation is enforced in both directions and is not cosmetic. The console
refuses to render on anything that is not a platform host: a carrier's own
subdomain asking for `/platform/tenants` receives a 404, not a login form and
not a stack trace naming another carrier. In the other direction, a set of
labels can never name a carrier at all — `admin`, `api`, `app`, `assets`,
`cdn`, `console`, `dashboard`, `docs`, `help`, `mail`, `platform`, `static`,
`status`, `support`, `www`. Provisioning refuses them, and the router will not
resolve them.

Your console session lives in its own cookie, `platform_session`, which is
host-only on the console's host and path-scoped to `/platform`. A browser will
not send it to a carrier's subdomain at all. That is deliberate: an operator
session is not merely rejected inside a carrier, it never arrives there. The
one way into a carrier's application is a support session, which is a
different credential entirely and is the subject of [chapter 9](#9-support-sessions).

Every carrier host needs its own TLS certificate. See
[chapter 12](#12-running-the-platform-certificates-backups-drills); a missing
certificate produces a carrier who can sign in and is signed out on the next
click, which is a confusing way to discover the problem.

---

## 2. Signing in, and creating the first operator

The console is at **`https://lms.credohrms.com/platform/login`**.

### The bootstrap problem

There is no self-registration, and there must not be — a sign-up form on the
platform's own host is a sign-up form for the whole estate. The first operator
is therefore created from a terminal on the server, by somebody who already
has the database:

```
npm run platform:admin -- --email ops@example.com --name "Priya Rao" --role OWNER
```

The script prints the generated password once. That password is written with
`mustChangePassword` set, so the console will refuse to do anything else until
it is replaced: it has been in a shell history, a scrollback buffer and
probably a chat message, and it is a handover token rather than a credential.

The script refuses to create a second row for an email that already has one.
Reset the existing login instead. Two rows for one person is how a revoked
operator keeps a way in.

### `--password` is for scripts, not for people

`--password '…'` sets the password instead of generating one, and skips the
forced change on first sign-in. The reasoning is narrow: a password the caller
chose was never handed out by us, so there is nobody for it to have travelled
to, and forcing a change would park a CI run or a fixture on a form it cannot
fill in.

**Do not use it to onboard a real operator.** A colleague's password typed
into your terminal has travelled, and the forced change is the thing that
retires it.

The same flag, with the same reasoning and the same warning, exists as
`--owner-password` on `scripts/provision-tenant.ts`.

### Sign-in rules

- Minimum password length is **12 characters**, enforced when you change it.
- Five failed attempts locks that login for **15 minutes**.
- A separate per-address limit allows five attempts in five minutes. There are
  a handful of operator logins in existence, so a burst of attempts is never a
  busy afternoon.
- A wrong password, an unknown address and a locked account all return the
  same message. The refusal does not tell a stranger which it was.
- Sign-in, failed sign-in, lockout and password change are all written to the
  operator log (`operator.signin`, `operator.signin.failed`,
  `operator.signin.locked`, `operator.password.change`).

Sessions last twelve hours. The operator record is re-read from the database on
every request, so deactivating a login takes effect on that person's very next
click rather than when their cookie expires.

---

## 3. Operator roles and the capability matrix

An operator holds one of four roles, and the role fixes what the login can do.
Only an OWNER can change a role.

The console has nine capabilities and no more. They are a deliberately closed
list, kept separate from the permission vocabulary carriers use for their own
staff, so that no check can ever be written that accepts either population.

| Capability | What it allows | OWNER | SUPPORT | BILLING | VIEWER |
|---|---|:---:|:---:|:---:|:---:|
| `tenant.read` | See the carrier list and every carrier's detail page | ● | ● | ● | ● |
| `tenant.write` | Provision a carrier; change subdomain, custom domain, plan, branding and outside-service accounts | ● | | | |
| `tenant.lifecycle` | Activate, suspend and close a carrier | ● | | | |
| `onboarding.write` | Tick and un-tick onboarding tasks | ● | | | |
| `plan.read` | See plans and what they grant | ● | ● | ● | ● |
| `plan.write` | Create, edit and delete plans | ● | | ● | |
| `usage.read` | See the usage figures on the tenant screens | ● | ● | ● | ● |
| `audit.read` | Read the operator log | ● | ● | | ● |
| `impersonate` | Open, enter and end support sessions | ● | ● | | |

Three things about this table are worth stating out loud.

**SUPPORT cannot change anything.** It reads everything and it may open a
support session. It cannot move a subdomain, change a plan or suspend a
carrier. The one dangerous capability it holds is impersonation, and that is a
grant with a written reason and an expiry rather than an ambient power.

**BILLING has no `audit.read`.** Who suspended whom, and which support session
was opened, is not a billing question.

**BILLING holds `plan.write` but not `tenant.write`.** It can change what a
plan sells to everybody on it; it cannot move one carrier onto another plan.

Navigation hides links a role cannot use, but hiding is presentation and not
access control. Every page checks its own capability, and every action that
changes something checks again before it writes. A BILLING login that types
`/platform/audit` is shown the console's own refusal page, not the log.

---

## 4. The estate: overview, tenant list, tenant detail

### Overview — `/platform`

Opening the console answers three questions: how many carriers there are and
in what state, whether anybody is inside a customer's data right now, and what
the operator team has been doing lately. The status counts link through to a
filtered tenant list. The support-session panel appears only for a role that
holds `impersonate`, and the recent-actions panel only for one that holds
`audit.read`.

> [SCREENSHOT: /platform — the overview with at least one open support session showing in the amber panel]

### Tenant list — `/platform/tenants`

Every carrier, filterable by status and plan, searchable by name, slug,
subdomain or custom domain, and sortable by name, status, creation date or
plan. Forty to a page.

Two columns need explaining. The **usage** figures are the most recent daily
snapshot and not a live count — and today they are always blank, because
nothing writes those snapshots (see
[chapter 13](#13-what-is-not-built-yet)). The **blocking tasks** count is the
number of blocking onboarding items still open; zero means the carrier can be
handed over.

### Tenant detail — `/platform/tenants/[orgId]`

One carrier, whole. The read-only operational summary sits above the controls
that change things, on purpose: an operator arriving from a support ticket
should know what state the carrier is in before being offered the buttons.

The page carries, in order: the operational summary; the modules this carrier
actually has; routing and plan; lifecycle; white-label; their accounts with
the outside services; the onboarding checklist; the support-session form and
recent grants; and the operator actions taken against this carrier.

---

## 5. Provisioning a carrier

A new carrier is built by copying an existing one. There are two doors —
`/platform/tenants/new` in the console, and `npm run tenant:new` from a
terminal — and both call the same service, so a carrier created one way and a
carrier created the other are identical and leave the same audit trail.

`tenant.write` is required, which means an OWNER. Support and billing can see
every carrier and can create none.

### What is copied

The **shape of a carrier's world**, out of a template carrier you choose:

- Geography — states, cities, pincodes, zones and zone-to-pincode links
- Masters — service types, package types, tax rates, charge heads, reason
  codes, vehicle types
- Number series — network-wide ones only
- Roles and their permission grants
- Notification templates
- SLA policies and the escalation ladder

### What is never copied

Anything **operational or commercial**:

- No branches (one head office is built from what you type on the form)
- No routes
- No customers
- No users (one owner is created from the form)
- No vehicles, no drivers
- No rate cards
- No credentials for outside services
- No transactional data of any kind

The reason to be strict about this is a single sentence: **a copied rate card
is somebody else's prices billed to somebody else's customer.** The same
reasoning covers the rest. A Delhi hub belonging to another company is worse
than no hub at all, because it looks like configuration rather than a mistake.

### What is changed on the way across

Four copies are altered rather than duplicated, and each one prevents a
specific failure:

- **Pincodes** lose their serving branch. That column points at one of the
  template's branches, and the template's branch network is not copied. If it
  ever resolved, it would route the new carrier's deliveries to another
  company's hub.
- **Number series** are copied as a shape, never as a position. The counter
  resets to zero and the period key clears. Copying the counter would make the
  first consignment note the new carrier prints carry a number the template
  has already printed — on a document a customer keeps.
- **The LR prefix** is the new carrier's own, taken from the form. The letters
  on a consignment note are the company's identity.
- **SMS templates** are copied inactive, with the DLT template and sender ids
  cleared. A DLT registration belongs to one company and takes one to three
  weeks to approve; an inherited id is rejected at the gateway, and a gateway
  rejection looks identical to a successful queue from inside the app. Nobody
  notices until a consignee says the delivery OTP never arrived. Email and
  in-app templates have no such registration and are copied live.
- **Escalation rules** keep the role they notify and lose the named user. That
  user is a member of the template's staff.

### The form

- **Name, legal name, slug, subdomain.** Slug and subdomain are both held to
  hostname rules — 3 to 63 characters, lower-case letters, digits and hyphens,
  not starting or ending with a hyphen — and neither may be a reserved label.
  The slug is not routed on today, but it is the stable public identifier and
  a slug that could not become a hostname is a trap waiting for the day
  somebody wants one. A clash on either, against any carrier including one
  still provisioning, is refused.
- **LR prefix.** Two to four letters. It is printed on every consignment note.
- **Template carrier.** The picker offers trial, active and suspended
  carriers, oldest first — the oldest carrier on the platform is the one whose
  masters have been maintained longest. Carriers still in PROVISIONING are
  excluded, because copying from a half-built tenant is how an empty geography
  propagates. On a brand-new deployment with nothing to copy from, seed the
  first carrier with `npm run db:seed`.
- **Head office.** Code, name, city, address, six-digit PIN, optional phone.
  The city is resolved against the *template's* geography — PIN first, then
  city name. If neither is in the template's geography the whole provisioning
  is refused and nothing is created; pick a template that covers the head
  office.
- **First owner.** Name, mobile (10 to 15 digits — this is how they sign in),
  optional email. They are given the first role the template has out of
  `SUPER_ADMIN`, `OWNER`, `ADMIN`, `MANAGEMENT`. A template with none of them
  is refused rather than producing an owner with no permissions.
- **Plan.** Optional. A carrier with no plan gets the always-on modules and
  nothing more, which is enough to book a consignment and administer its own
  staff.

Everything commits in one transaction or none of it does. A half-built tenant
is not a state this can reach, which is also why there is no "resume" — a
resume would mean writing into a carrier somebody else is already creating.

### The one-time owner password

On success the console shows the generated owner password on one panel, once.
It is never stored anywhere but as a hash on the user row, and it is not
written to the audit trail. The panel is driven by a cookie that lives for ten
minutes, is scoped to the console's own host and path, and is checked against
the carrier being viewed — walking to a different carrier's page will not show
you the previous one's password.

Write it down or send it before you leave the page. There is no second copy.
The owner is created with a forced password change, so it cannot survive their
first session.

> [SCREENSHOT: /platform/tenants/[orgId] — the one-time owner password panel as it appears immediately after provisioning]

### The onboarding checklist

Every new carrier is written with ten tasks. Six are **blocking** — the
difference between "not done yet" and "cannot be handed over". A carrier that
goes live unable to send a delivery OTP has a broken product, not an
incomplete one.

| Task | Blocking | Note |
|---|:---:|---|
| Confirm branch network and hub roles | ● | Which branches exist, which are hubs, what they connect to. |
| Load the serviceability pincode master | ● | Serviceability is per-carrier. The importer at `/masters/pincodes/import` handles the full load, roughly 19,000 rows. |
| Load customer rate cards | ● | Nothing can be billed until a customer has a rate card. |
| First owner has signed in and changed their password | ● | The seeded password must not survive the first session. |
| DLT sender header registered and approved | ● | The long pole. One to three weeks of external approval, per carrier. Not a code task. |
| DLT templates approved for every SMS the platform sends | ● | A missing one means a delivery OTP that never arrives. |
| Logo, palette and document footer supplied | | Set on the white-label section of the same page. |
| GSTIN, PAN and invoice address confirmed | | As they must appear on documents. |
| Email sender domain verified | | Or email lands in spam. |
| Custom tracking domain pointed and certified | | Only when the carrier wants tracking on their own domain. |

Tasks can be un-ticked as well as ticked. A DLT template rejected after
approval has to be able to go back to not-done; a checklist that only moves
one way stops being believed. Both directions are audited.

A carrier provisioned before a task existed has no row for it at all. The
checklist belongs to that carrier rather than being a view over a global
template, and back-filling would mark a live carrier as incomplete.

> [SCREENSHOT: /platform/tenants/[orgId] — the onboarding checklist with blocking tasks still open]

### The carrier stays PROVISIONING until somebody makes it ACTIVE

Provisioning creates the carrier in **PROVISIONING** status. That is the
honest state: the carrier exists and can be worked on, and nothing about it
has been handed over. Nothing promotes it automatically — not the last
blocking task being ticked, not the owner signing in. An operator with
`tenant.lifecycle` sets it to ACTIVE deliberately, on the lifecycle panel,
when the blocking tasks are done.

### After provisioning

1. Point `<subdomain>.lms.credohrms.com` at the deployment. The wildcard A
   record normally covers this.
2. Issue the certificate: `sudo carrier-cert <subdomain>`.
3. Sign in as the owner and change the password.
4. Start the DLT sender registration. It is the long pole.
5. Load rate cards.
6. Set the status to ACTIVE.

---

## 6. Plans and modules

### What a plan is

A plan is two things: a set of **modules**, and a set of **limits**.

The limits are `maxUsers`, `maxBranches`, `maxShipmentsPerMonth` and
`maxPortalUsers`. Blank means unlimited; zero switches the feature off; both
are meaningful and neither is a typo for the other. Limits are enforced at the
point of use — when a user is invited, when a branch is created, when a
consignment is booked — rather than by a nightly job, so a carrier is told at
the moment rather than in an invoice.

A price and a currency can be recorded on the plan. Nothing in the product
bills against them.

### Modules and permissions are independent, on purpose

Permissions answer "may this person do it". Modules answer "did this company
pay for it". They are deliberately separate: a branch manager holds
`invoice.read` whether or not their carrier is on a plan that includes
billing. Conflating them would mean editing every role on every carrier
whenever a plan changed.

A module owns route prefixes and the permissions that only make sense inside
it, so switching one off removes a whole capability rather than leaving a
half-lit screen.

### The twelve modules

| Module | Key | Requires | Screens it owns | Permissions withdrawn when it is off |
|---|---|---|---|---|
| Core operations | `core` | — (always on) | `/dashboard`, `/help`, `/shipments`, `/pickups`, `/customers`, `/vendors`, `/masters`, `/fleet`, `/admin`, `/notifications`, `/reports` | none |
| Hub & warehouse | `hub` | — | `/hub` | `scan.inbound`, `scan.outbound`, `scan.sort`, `weight.capture`, `receipt.read`, `receipt.close`, `discrepancy.resolve`, `damage.record` |
| Line haul & dispatch | `dispatch` | — | `/dispatch` | `manifest.create`, `manifest.read`, `manifest.update`, `manifest.close`, `manifest.reopen`, `trip.create`, `trip.read`, `trip.dispatch`, `trip.close`, `loading.execute` |
| Last mile delivery | `lastmile` | — | `/delivery` | `delivery.assign`, `delivery.reassign`, `delivery.read`, `delivery.execute`, `delivery.rto`, `pod.read`, `pod.upload` |
| Cash on delivery | `cod` | `lastmile` | `/delivery/cod` | `cod.collect`, `cod.deposit`, `cod.reconcile` |
| Billing & receivables | `billing` | `lastmile` | `/finance` | `ratecard.read`, `ratecard.manage`, `invoice.create`, `invoice.read`, `invoice.approve`, `invoice.cancel`, `payment.record`, `payment.read`, `expense.record`, `expense.approve`, `settlement.read`, `settlement.prepare`, `settlement.approve`, `report.financial` |
| GPS tracking | `tracking` | `dispatch` | `/tracking` | `tracking.read`, `tracking.replay`, `geofence.manage` |
| Service levels & exceptions | `sla` | — | `/exceptions`, `/complaints`, `/masters/sla-policies` | `sla.manage`, `exception.read`, `exception.assign`, `exception.resolve`, `complaint.create`, `complaint.read`, `complaint.resolve` |
| Customer portal | `portal` | — | `/portal` | none — portal logins are customer accounts, not staff holding permissions |
| E-commerce delivery | `ecommerce` | `lastmile`, `cod` | none | none — it is a shipment mode, gated where modes are offered |
| API & webhooks | `integrations` | — | `/integrations` | `apikey.manage` |
| Insights & analytics | `insights` | — | `/insights` | `report.management`, `report.export` |

**Core is on every plan, and on no plan at all.** Booking a consignment and
administering your own staff are not upsells. A carrier mid-provisioning, with
no plan attached, has exactly core.

Two lines in that table repay a second look. **`report.export` belongs to
insights, not core**, which draws the intended line: reading your own day is
operations, taking the whole dataset away is analytics. And **`ecommerce` owns
no routes**, which is the honest answer rather than an omission — it is a
shipment mode, a lens over screens that already exist.

### Prerequisites, and the one that can currently be mis-sold

A module whose prerequisite is missing is **not granted**, even when the plan
names it. `cod` without `lastmile` grants nothing; `billing` without
`lastmile` grants nothing; `tracking` without `dispatch` grants nothing;
`ecommerce` needs both `lastmile` and `cod`.

The plan editor **will currently let you save that plan.** Validation refuses
a feature key that names no module at all, but it does not refuse a
combination whose prerequisite is absent. What happens instead is that the
plan screen and every carrier's detail page show the module under **"on the
plan, but not granted"**, with a sentence naming what is missing. It is shown
rather than refused — visibly wrong instead of silently wrong — but it is
still a plan somebody could sell.

Treat a blocked module on a live plan as a defect to fix on the plan, not on
the carrier. Every carrier on that plan is in the same position.

A third state exists on older plans: strings in the feature list that name no
module at all, left over from when the column was free text. They grant
nothing, they are shown in red as "listed on the plan, but not a module", and
re-saving the plan removes them.

> [SCREENSHOT: /platform/plans — the module chips on a plan that has a granted set, a blocked module, and an unrecognised feature string]

### What actually happens on a downgrade

Removing a module from a plan takes effect for every carrier on that plan, on
their next request. Four things happen, and they are four separate mechanisms
rather than one:

1. **The URL refuses.** Every operations screen sits under a module's prefix.
   Asking for one belonging to a module the carrier no longer has redirects to
   a page saying it is not on their plan and who can change that.
2. **The links disappear.** The navigation is drawn from the granted set.
3. **The session stops carrying those permissions.** The permission set is
   narrowed at sign-in, so a server action guarded by `invoice.approve` refuses
   without ever having to learn what a module is.
4. **The API keys and the webhook go dark too.** This is the one most easily
   forgotten. A carrier dropped from `integrations` finds that already-issued
   API keys stop working — the partner API answers `not_on_plan` with a 403,
   after the key has verified, so a stranger guessing keys still learns
   nothing — and the webhook fan-out stops posting events. Without both, a
   carrier would keep pushing events to a partner's endpoint from a screen
   they could no longer reach in order to switch it off.

### Retiring a plan is not a downgrade

Setting a plan inactive removes it from the picker for new carriers and
changes nothing whatever for carriers already on it. That is deliberate:
"still offered" and "this carrier is paid up" are different facts. Non-payment
is expressed as a suspended carrier, not as a retired plan.

Deleting a plan with carriers on it is refused outright — the foreign key
would null their plan and silently un-price a live account. Move them first,
or retire it, which is almost always the thing actually wanted.

---

## 7. Lifecycle: active, suspended, closed

Five statuses exist — `PROVISIONING`, `TRIAL`, `ACTIVE`, `SUSPENDED`,
`CLOSED` — and the tenant list can be filtered by any of them. The lifecycle
panel on a carrier's page offers **three transitions**, and needs
`tenant.lifecycle`: activate, suspend and close.

`PROVISIONING` is where every carrier starts and is left by activating it.
`TRIAL` can be filtered on and is accepted as a template source, but nothing
in the console sets it; a carrier reaches it only if something outside the
console puts it there.

**ACTIVE** — normal service. The first activation stamps the activation date;
re-activating after a suspension keeps the original, which is what "customer
since" means. Re-activating clears the suspension and its reason; the audit
row recording why they were suspended stays.

**SUSPENDED** — still reachable, but every write is refused in the data layer.
Their operations team can still read their own consignment history while a
payment dispute is settled. **A suspension is not a lockout and must not
become one.** A suspended carrier stays read-only even inside a support
session that asked for write access.

**CLOSED** — sign-in is refused entirely and the host stops resolving; their
subdomain becomes a 404 rather than a login page. Data is retained. Closing is
not deletion, and there is no delete.

Closing a carrier also ends every support session open inside it, in the same
transaction. A grant that outlived the carrier's own sign-in would be the one
way back into a company that has been switched off. For the same reason, a
support session cannot be opened into a closed carrier at all.

Suspending and closing both **require a reason of at least a sentence**. The
requirement is the product's, not the column's. Suspending a company without
recording why is the single entry in the operator log most likely to be read a
year later, in an argument.

---

## 8. White-label and outside-service accounts

### White-label

A carrier's own colours, logo, favicon, document footer, terms text, support
email and phone, DLT sender header, SMTP from-address and WhatsApp number are
edited on the carrier's page with `tenant.write`. Colours must be valid hex —
an unparseable value silently drops the token and renders the carrier's
application in somebody else's palette.

Saving clears the notification layer's cached copy of the carrier
immediately. Without that, an operator whose DLT registration came through
this morning would watch messages keep going out under the old header and
conclude the change had not saved.

Changing the subdomain or custom domain clears the host cache in the same
way. Both take effect at once rather than at the end of a thirty-second
window.

### Their accounts with the outside services

Four slots — SMS gateway, SMTP relay, WhatsApp and GPS — record whose account
a carrier's traffic actually leaves on. Each slot is in one of three states:

- **tenant** — the carrier has their own account, and a secret is stored.
- **platform** — no secret stored, so their traffic goes out on the
  platform's own account. Billed to us, sharing one rate limit with every
  other carrier, and stopping for everyone if that key is revoked. For SMTP it
  is a deliverability problem as well: the carrier's SPF and DKIM records do
  not name our relay, so mail sent as them from it can be treated as forged.
- **none** — neither is configured.

Two rules govern this screen and neither has an exception.

**A stored secret never travels back to the browser.** Not masked, not
partially, not "last four". The query does not select the column at all. What
the screen shows is whether a secret exists and when it was last replaced.
Replacing one means typing a new one — the same bargain as a password field.

**The trail records that a secret changed, never what it changed to.** The
value is never put into the audit payload, and the audit writer independently
redacts anything called `secret`, `password`, `token`, `keyHash` or
`passwordHash`. Two mechanisms, each sufficient alone, because an audit log
holding a live gateway key is a credential store nobody knows they are
running.

Changes appear in the operator log as `tenant.credential.update`,
`tenant.credential.rotate` and `tenant.credential.clear`.

---

## 9. Support sessions

This is the most dangerous surface in the product. Read this chapter before
you use it, and read it again in a year.

### What a grant is

A support session is not a power an operator holds. It is a **grant**: a row
naming one operator, one carrier, a written reason, an expiry, whether writes
are allowed, and optionally one member of the carrier's staff whose view is
adopted. Holding the `impersonate` capability gives you the ability to *open*
a grant. It does not put you inside anybody.

Grants are opened from the carrier's own page, never from the support-sessions
screen. Choosing a carrier from a dropdown on a page about impersonation is a
worse decision than choosing it by having walked to that carrier's record
first, where the reason you type has context.

> [SCREENSHOT: /platform/tenants/[orgId] — the impersonation form with its reason field and duration list]

Every control on that form is a deliberate friction:

- **The reason is required, free text, and at least eight characters.** It is
  free text rather than a dropdown because a dropdown of reasons becomes a
  dropdown whose first entry is always chosen. Write a ticket number and a
  sentence. It is the only record of why somebody outside the company was
  inside their data.
- **The duration is a closed list** — 15, 30, 60, 120 or 240 minutes, with 30
  offered by default. The service will not accept less than 5 or more than
  **240 minutes**, which is the hard ceiling. Nobody opens one "for the day".
- **Write access is an unticked box** with the consequence spelled out beside
  it. Read-only is the right answer for almost every support question.
- **"Act as" is optional.** Adopting one person's view reproduces what they
  can see. Leaving it blank is tenant-wide and read-only.

Opening a grant is refused when: the reason is too short; the duration is out
of range; the carrier is CLOSED; the named user does not belong to *this*
carrier (a cross-tenant grant wearing the right shape); or **you already have
one open**.

### One operator, one open grant

The limit is behavioural rather than technical. Sessions left open in five
carriers at once is how "time-boxed" stops meaning anything. End the one you
have before opening another.

### Entering: a single-use hand-off, traded on the carrier's own host

The console runs on one host and the carrier on another, and the console
cannot set a cookie on a carrier's subdomain. So entering a session works like
this:

1. You press **Enter session** on your own grant. The grant is **re-read from
   the database** at that moment, not taken from the list the page rendered —
   a grant that expired or was ended while you were looking at the screen must
   not produce a working link.
2. A **hand-off token** is minted. It carries a grant id and nothing else: no
   operator id, no user id, no permission set. It lives for **sixty seconds**,
   long enough for one redirect on a bad connection and short enough that a
   URL sitting in a proxy log is already dead.
3. Your browser follows it to the carrier's host, which verifies it, re-reads
   the grant again, checks the grant against the organisation **the host
   resolved to**, exchanges it for a session cookie, writes the entry to the
   operator log, and redirects to the carrier's dashboard. The token is spent
   there and never appears in a URL again.

The session cookie is host-only on that carrier's subdomain and reaches every
page of it, so the banner cannot be escaped. Its lifetime is capped at both
the grant's expiry and one hour, so the token itself is never a long-lived
bearer secret.

If anything is wrong — the token is forged, expired, already spent, or was
minted for a different carrier — the carrier's host answers with one identical
404 and sets no cookie. Distinguishing the cases would tell a stranger with a
stale link which of them was true.

### Every request re-reads the grant

The cookie proves that somebody was handed a grant. It never proves the grant
is still open. **On every single request the grant row is read again**, and a
session ceases to exist the moment any of these becomes true:

- the grant was ended, from the console or from the banner;
- it expired;
- the row is gone;
- the operator behind it was deactivated.

Ending a session, or letting it lapse, therefore kills it immediately rather
than at the end of some window. A token cannot be recalled, which is exactly
why nothing is trusted to a token.

### A grant is worthless anywhere but where it was opened

The organisation always comes from the host, never from the credential. A
grant opened against Acme and presented on Bravo's subdomain is **ignored
outright** — not downgraded to a read-only Bravo session, not partially
honoured. The request continues as an ordinary signed-out visit to Bravo.
Honouring it in any form would make the credential rather than the host the
tenancy boundary, which is the inversion the whole design exists to prevent.

### The banner

While a session is open, a banner sits at the top of **every page** of the
carrier's application. It is not dismissible. It is visible to everyone
looking at that screen — the operator, and any member of the carrier's staff
standing behind them.

It names the operator and their email address, the carrier, the person whose
view was adopted if any, the reason that was typed, and the time the session
expires. It says whether the session may write — reading the *effective*
answer, so a suspended carrier's banner says read-only even when the grant
asked for write. Its exit button is a plain form that works before any
JavaScript has loaded; a banner whose escape hatch depends on hydration is not
an escape hatch.

The banner is driven by the same value the data layer uses to refuse writes,
so the notice and the enforcement cannot disagree.

> [SCREENSHOT: a carrier's own dashboard during a support session — the full-width banner naming the operator, the reason and the expiry, with its end-session button]

### Ending a session

Three ways, and one non-way:

- **The banner's button**, on the carrier's host. It ends the *grant* first
  and clears the cookie second. Clearing the cookie alone would leave a live
  grant behind — still open in the console, still usable by anyone holding a
  copy of the token — which is a session that looks ended and is not. You are
  returned to the console's support-sessions screen, on the console's own
  host, because an operator who has left a customer moments before should land
  somewhere that says so.
- **The console**, from the support-sessions screen or from the carrier's
  page. Any operator holding `impersonate` may end **anyone's** session, not
  only their own. Somebody noticing an open session into a customer they are
  not working with must be able to shut it there and then; the audit row names
  who did.
- **Closing the carrier**, which ends every open grant inside it.

Expiry is the non-way: it writes no audit row, because the grant's own expiry
time already records when it stopped.

Entering someone else's session is refused. Ending is open to everyone because
ending is the safe direction; entering is not, and the audit trail is only
worth reading if the person inside the carrier is the person the row names.

### What the carrier sees

**The carrier sees it in their own audit trail.** Every row written during a
support session carries the grant, and their audit screen at `/admin/audit`
marks it **"via support"** next to the staff member's name, with a tooltip
saying it was made during a platform support session by the vendor acting as
that user.

This matters more than any of the console-side controls, because it is the
only place a company can learn that the change in their employee's name was
not made by their employee. The carrier's audit column is a foreign key into
their own staff table and can name nobody else; the marker is what tells the
two apart.

> [SCREENSHOT: a carrier's own /admin/audit — a row carrying the "via support" tag beside the staff member's name]

**Nobody at the carrier is notified when a session opens.** See
[chapter 13](#13-what-is-not-built-yet).

### What a session can actually do

This is where the design earns its keep. There are two shapes of session and
they are very different.

**Without an adopted user — tenant-wide, and read-only.** There is nobody to
adopt, so the session is built to be unable to do anything that would need an
identity. The data layer refuses every write regardless of what the box said.
The permission set is narrowed to non-sensitive `*.read` codes that the
carrier's **own active roles** already grant — every permission in it is one
the carrier hands out to its own staff. Sensitive read permissions are
excluded even though they read: `report.export` is a read that writes an
export audit row, and this session has no user id to put in it. The session's
own id is deliberately not a user id, so anything reaching for "rows this user
owns" finds none. The data scope is the widest the carrier itself hands out
and never wider — a carrier whose roles are all branch-scoped gives a
branch-scoped support session, which will see very little, and an empty screen
is the right failure there.

**With an adopted user — that person's session, minus three codes.** You get
the same query, the same roles, the same branch scope and the same identity
their own login produces. You see what the person you are helping sees. You
cannot acquire a permission nobody at the carrier holds, because the set is
that person's set. Their forced password change, if any, is not imposed on
you.

Three permissions are subtracted from an adopted session and can never be
held under any grant:

| Withheld | What it would give | Why it is withheld |
|---|---|---|
| `user.manage` | Create a login, or reset a password | A user added at minute two of a thirty-minute session is still there next year. It is a way back in that no expiry closes. |
| `role.manage` | Grant a permission to a role | The same, one level up: it permanently widens what every holder of that role can do. |
| `apikey.manage` | Mint an API key | A bearer credential for the carrier's whole API, valid until somebody notices it. |

Everything else an adopted session does is bounded by the grant: it expires,
the banner announces it, the row being ended stops it on the next request, and
the change is marked "via support" in the carrier's own trail. These three are
bounded by none of that, because **what they produce outlives the grant**.

That is the whole argument, and it is worth stating in one line: **a support
session that can create a permanent login inside a customer is not a support
session.** It is an unaudited standing account with a friendly name.

Support does not need them. Reproducing a customer's problem, reading what
they see, correcting a status, approving the invoice they are stuck on — none
of that touches identity. An operator who genuinely must add a user for a
customer can ask the customer to add it, which is the conversation that should
be happening anyway.

### The four audit moments

| Moment | Written | Records |
|---|---|---|
| Opened | `impersonation.open` | Carrier, reason, duration, whether writes were asked for, which user is adopted |
| Entered | `impersonation.enter` | The same, plus whether writes are *effectively* allowed, and the time it happened |
| Ended | `impersonation.end` | Who ended it, and whether from the console or the banner |
| Expired | nothing | The grant's own expiry time is the record |

Opening a grant is an intention; entering it is the thing that happened, and
the two are hours apart often enough that one row cannot stand for both. The
entry row is also what makes an impersonated write attributable: the carrier's
own log names the adopted user, and the pairing that says "those rows, in that
window, were an operator" lives only in the operator log.

### Is what it grants proportionate?

An honest reading: **yes, with one qualification.**

The read-only shape is close to ideal. It carries no identity, can write
nothing, cannot export, and holds only permissions the carrier already hands
to its own staff. There is very little to argue with.

The adopted shape is genuinely powerful — full write access as a real
employee, up to four hours. But it is bounded on every axis that matters: it
needs a named carrier, a written reason and a deliberate tick; it dies on
expiry or on either party ending it, effective on the next request; it is
announced continuously to everyone looking at the screen; it cannot be
replayed on another carrier; and every change it makes is labelled in the
customer's own records. Crucially, its ceiling is a real employee's ceiling
rather than a vendor-invented one. And the three permissions withheld are
exactly the three whose effects would survive the grant. That is the right cut.

The qualification is the silence. The controls are all *recorded* rather than
*announced*: a carrier learns that a support session happened by going and
looking at their audit trail. Nobody tells them. Four hours of write access as
their finance manager can come and go without a single message to the company
it happened to. The trail is honest, but it is passive, and a control nobody
is prompted to check is weaker than the same control with a notification
attached. Until that is built, an operator who opens a write-enabled session
should tell the carrier they are doing it.

---

## 10. The operator log

`/platform/audit`, with `audit.read`. Filterable by carrier, by operator and
by action; fifty to a page. Recent activity also appears on the console
overview and on each carrier's page.

This is a **different table** from the audit trail carriers read, and the
separation is the point. Suspending a company, opening a support session and
moving a subdomain are not a carrier's business to browse. The rows must also
survive the carrier they describe, which is why the carrier is stored as a
copied slug rather than joined through a foreign key: a closed and cleaned-up
carrier still has a readable history here.

Nothing merges the two, and nothing tenant-facing can read this one.

Every change an operator makes is written in the same transaction as the
change itself. A suspension that happened with no trail is not a state this
system can reach. The exceptions are sign-in, sign-out and the recording of a
support-session entry, which are best-effort — refusing a login because the
log is down helps nobody, and refusing to let an operator in because a log
write failed helps nobody either, given the grant already authorised it.

Rows created by a script carry no operator, which is what "created out of
band" should look like. `scripts/create-platform-admin.ts` writes an
`operator.create` row with no actor for exactly that reason.

The IP address recorded is only ever one the proxy configuration vouches for.
It used to take the leftmost forwarded entry, which is the one value in the
chain the caller writes — so the actor of an audited action could choose the
address the trail would remember them by, which is worse than remembering
none.

---

## 11. What an operator may not do

Consolidated, because these are the sentences most worth being able to point
at later. Every one of them is enforced in code, not by convention.

**You cannot read a carrier's data without a grant.** Your console cookie is
not sent to a carrier's host at all, and even if it were, it carries no
organisation, no permissions and no branch scope — there is no way to spell a
call that would accept it as a tenant login.

**You cannot enter another operator's support session.** You may end it.

**You cannot hold two open grants at once.**

**You cannot open a grant without a reason.** Eight characters is the floor; a
ticket number and a sentence is the expectation.

**You cannot open a grant for longer than four hours.**

**You cannot open a grant into a closed carrier**, and closing a carrier ends
every grant inside it.

**You cannot adopt a user who belongs to a different carrier.**

**You cannot use a grant on a carrier it was not opened against.** It is
ignored, not downgraded.

**You cannot create a user, change a role, or mint an API key inside a support
session**, whatever the adopted person's own permissions say.

**You cannot write during a session with no adopted user**, however the
"allow writes" box was ticked.

**You cannot write into a suspended carrier**, even with a write-enabled
grant. The carrier's own state is not something a support grant is allowed to
argue with.

**You cannot hide a support session.** The banner is on every page and is not
dismissible, and the carrier's own audit trail marks what you did.

**You cannot delete a carrier.** Closing retains the data.

**You cannot suspend or close a carrier without recording why.**

**You cannot delete a plan that carriers are on.**

**You cannot read a stored gateway secret.** Not from the screen and not from
the log.

**You cannot provision a carrier onto a reserved label**, a name shorter than
three characters, or a subdomain or slug another carrier already holds.

**You cannot make a plan grant a module by typing its key.** A feature string
that names no module is refused on save.

**You cannot act on the console at all while your own password change is
outstanding.**

---

## 12. Running the platform: certificates, backups, drills

### A certificate for each carrier — `deploy/carrier-cert.sh`

```
sudo carrier-cert acme
sudo carrier-cert acme --dry-run
```

Run once per carrier at provisioning time. Pass the **label only** — `acme`,
not `acme.lms.credohrms.com`; passing a whole hostname would quietly ask for a
certificate for somebody else's domain, and the script refuses anything that
is not a bare label.

The session cookie is issued `Secure` in production and a browser will not
send a Secure cookie back over plain HTTP, so a carrier without a certificate
can sign in and find themselves signed out on the very next click.

Why one certificate per carrier rather than a wildcard: Let's Encrypt only
issues wildcards through a DNS challenge, which needs an API credential for
the DNS provider, and GoDaddy gates its DNS API behind holding ten or more
domains. The HTTP challenge needs no credential at all. The cost is this
script; the benefit is having no API key to store, rotate or leak.

The script is safe to re-run and does nothing if the host is already covered.
It checks that the name resolves to this server before asking for anything — a
name that does not resolve fails with a message about validation, which reads
like a certificate problem and is really a DNS problem, usually a missing
wildcard A record. It then reads back **every name already on the
certificate** and passes them all in again. That last step is the whole of the
danger in the script: reissuing with only the root and the new carrier would
silently drop every carrier added before today.

### The nightly backup — `deploy/backup-db.sh`

```
deploy/backup-db.sh [destination]      # default /opt/backups
```

**It writes two files, and the second one is the reason this section exists.**

`pg_dump` does not dump roles. Roles are cluster-wide objects and live only in
`pg_dumpall --globals-only`. A restore from the data dump alone brings back
every row and every row-level-security policy, and those policies then
reference an application role that does not exist on the new server. Postgres
will not invent it. The application cannot connect.

What happens next is the part worth writing down. The instinct at three in the
morning is to point the application at the database owner instead — and the
system comes straight back up looking healthy, **with tenant isolation
switched off**, because row-level security does not apply to a table's owner.
One carrier would read another's consignments and nothing would look wrong.

So the globals are dumped beside the data, every night. Both files are checked
before the old ones are deleted: the data dump must be a readable archive, and
the globals file must actually contain roles. The first run of this script
wrote a 229-byte globals file, reported success, and left a backup that could
not have been restored — the tool had failed loudly to stderr while still
exiting zero. Both checks exist because of that.

The globals carry no role passwords, deliberately: they do not belong in a
nightly file on disk, and the application role's password lives in the
environment file, from which `node scripts/apply-rls.mjs --apply` recreates
the role and its grants.

Fourteen days are kept by default.

### Restoring

**Roles first, always.** The data restore references them.

```
createdb -U postgres logistics_restored
psql -U postgres -f globals-YYYY-MM-DDTHHMMSSZ.sql
pg_restore -U postgres -d logistics_restored --no-owner \
  --role=postgres logistics-YYYY-MM-DDTHHMMSSZ.dump
```

Then run `node scripts/apply-rls.mjs --apply`, which creates the application
role and its grants from the same source of truth the live server uses.

### Rehearsing the restore — `scripts/restore-drill.mjs`

```
npm run verify:restore
npm run verify:restore -- --keep      # leave the scratch database behind
```

A backup nobody has restored is a hope, not a backup. The drill dumps,
restores into a scratch database on the same server, checks four things in
order, and drops the scratch database afterwards. Nothing it does touches the
live one.

1. The dump restores at all.
2. The row counts match, table by table.
3. Row-level security is still switched **on** for every tenant-owned table.
4. Every policy is present, and the grants the application role needs came
   back with them.

The last two are the ones nobody thinks to check, and they are the difference
between a restored database and a restored database that still keeps carriers
apart.

### Verifying the console itself

Two scripts exist and both are worth running after any change near tenancy,
the console, or provisioning.

```
npm run verify:tenancy-console
npm run smoke:platform
```

`verify:tenancy-console` asks the questions an attacker would, over real HTTP:
that a carrier's subdomain cannot serve the console and the console's host
cannot serve a carrier; that none of the three cookies is accepted anywhere but
its own host and audience; that a refusal does not name what it is refusing;
that provisioning copies masters and nothing else; and that a support session
opens, is entered, is announced on every page, is refused when replayed on
another carrier's host, is marked in the carrier's own trail, and dies when
ended. It also checks the capability matrix, role by role.

`smoke:platform` signs in as the oldest active operator and asks for every
console screen, failing on anything that is not a page that actually rendered.
It exists because asking for a guarded route while signed *out* proves the
guard runs and nothing else — a page that throws on render looks identical
from outside.

---

## 13. What is not built yet

Two things in this manual's territory are described by the product and do not
exist. Both are stated here rather than left to be discovered.

### The usage snapshots have no writer

`TenantUsageSnapshot` is the table behind every usage figure in the console:
the shipment, delivery, active-user, branch, portal-user, notification and
API-call numbers on the tenant list and on each carrier's operational summary.

**Nothing writes it.** There is no scheduled pass, in the application, in the
worker or in a script. The console reads it and only reads it.

The visible consequence: the operational summary on every carrier's page shows
a dash for each of those figures, and its snapshot date reads **"never
run"**. That is honest — it means the nightly pass has not run, not that the
carrier shipped nothing — but it means the console has no usage view at all
today, and there is nothing an operator can do to populate it.

It is also why the shipments-per-month limit is enforced by counting the
carrier's own bookings at the moment of booking rather than reading this
table. Enforcing against a table nothing writes would enforce against zero.

### Nobody is notified when a support session opens

The trail records it — the operator log on our side, the "via support" marker
on theirs — but **no message is sent to anybody**. Not to the carrier's owner,
not to their administrators, not to the other operators. There is no email, no
SMS and no in-app notice at any of the four moments of a grant.

A carrier learns that somebody was inside their data by going and looking at
their audit trail. Until this is built, tell the carrier yourself when you
open a session that can write.

---

## 14. Command reference

Everything below is run on the server, from the application directory.

| Command | What it does |
|---|---|
| `npm run platform:admin -- --email <e> --name <n> [--role OWNER\|SUPPORT\|BILLING\|VIEWER]` | Creates an operator login. Prints a generated password once, with a forced change. |
| `npm run platform:admin -- … --password '<p>'` | The same, with a chosen password and **no** forced change. Scripts and fixtures only. |
| `npm run tenant:new -- --slug <s> --name "<n>" --subdomain <sub> --owner-name "<n>" --owner-mobile <m>` | Provisions a carrier from a terminal, through the same service the console uses. |
| `sudo carrier-cert <subdomain>` | Issues the TLS certificate for one carrier's host. `--dry-run` rehearses it. |
| `deploy/backup-db.sh [dest]` | Nightly backup: the data dump and the globals, both verified. |
| `npm run verify:restore` | Rehearses a full restore and re-checks that isolation came back with it. |
| `npm run db:rls -- --apply` | Recreates the application role, its grants and every row-level-security policy. |
| `npm run verify:tenancy-console` | The tenancy and console boundary, end to end, including impersonation. |
| `npm run smoke:platform` | Asks for every console screen as a signed-in operator. |
| `npm run db:seed` | Seeds the first carrier on a brand-new deployment, so there is a template to copy from. |

### Audit actions you will see in the operator log

`operator.create` · `operator.signin` · `operator.signin.failed` ·
`operator.signin.locked` · `operator.password.change` · `tenant.provision` ·
`tenant.identity.update` · `tenant.branding.update` · `tenant.activate` ·
`tenant.suspend` · `tenant.close` · `tenant.credential.update` ·
`tenant.credential.rotate` · `tenant.credential.clear` ·
`onboarding.task.done` · `onboarding.task.reopen` · `plan.create` ·
`plan.update` · `plan.delete` · `impersonation.open` ·
`impersonation.enter` · `impersonation.end`
