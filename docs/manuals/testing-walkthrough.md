# Testing walkthrough

The fifth manual, and the only one written for you rather than for a user. The
other four explain the product to the people who will live in it. This one is a
route through the whole thing in one sitting, in the order the freight moves,
so that a morning's testing covers every part rather than the parts you happen
to think of.

It assumes nothing except that you can sign in. Each step says who to be, what
to do, and **what you should see** — that last part is the point, because a
test you cannot fail is not a test.

---

## Before you start

**Everything is on one host.** `https://city-logistics.lms.credohrms.com` for
carrier staff and customers; `https://lms.credohrms.com/platform/login` for the
operator console. They are deliberately different addresses: the console is
refused on a carrier's host and answers 404, not 403, so a stranger cannot even
learn it exists.

**Every staff password is `Admin@123`.** Portal customers use `Portal@123`. The
mobile number is the username, and it is built to be read rather than looked
up: `9` + the branch's digit three times + `00000` + the post.

| Branch | Prefix | | Post | Last digit |
|---|---|---|---|---|
| HO-DEL — Head Office | `9111…` | | Branch Manager | `1` |
| HUB-DEL — Delhi Hub | `9222…` | | Booking Executive | `2` |
| BR-GGN — Gurugram | `9333…` | | Hub Operator | `3` |
| HUB-JAI — Jaipur Hub | `9444…` | | Dispatch Manager | `4` |
| BR-BOM — Mumbai | `9555…` | | Pickup Executive *(field)* | `5` |
| BR-FBD — Faridabad | `9666…` | | Delivery Agent *(field)* | `6` |
| HUB-AMD — Ahmedabad | `9777…` | | | |

So `9333000003` is Gurugram's hub operator and nothing else, anywhere.

**The lane this walkthrough uses** is Gurugram → Delhi Hub → Jaipur:
`BR-GGN` books, `HUB-DEL` moves it, `HUB-JAI` delivers it. Every branch is
staffed with all six posts, so you can run the same walkthrough on any lane you
like — this one simply has the most seeded data behind it.

**Keep two browsers open**, or one plus a private window. Half of what is worth
testing here is that one person *cannot* do something, and the fastest way to
see it is to be two people at once.

---

## Part one — the freight's own path

This is the spine. If only one thing is tested, test this.

### 1. Book a consignment · `9333000002` (Gaurav, booking executive)

**Shipments → New booking.** Consignor and consignee, Gurugram to Jaipur, two
or three packages, a weight. Leave **Needs pickup** on.

**You should see** an LR number issued immediately (`CL2026…`), a price against
the published tariff, and a collection raised with it — a `PU…` number. The
price matters: **a zero means no rate card resolved for that lane**, which is a
real answer and not a glitch. Those consignments are the worklist on
*Finance → Rate cards → Coverage gaps*.

**Then book a second one with Needs pickup switched off.** No collection is
raised for it. This is the consignor who says they will bring it to the
counter, and it is most of the traffic in a real carrier.

**Look at the list.** The two consignments sit under *different* chips —
"Awaiting pickup" and "Coming to the counter". Both are `BOOKED`; the
difference is who is doing the moving, and a duty manager reading "Awaiting
pickup 19" needs to know how many vans that is.

### 2. Send a van · `9333000001` (Neha, branch manager)

**Pickups.** Today's collections. Find the one your booking raised, assign it
to `9333000005` (Pankaj, pickup executive).

**You should see** the consignment move to `PICKUP_ASSIGNED`.

> The pickup desk shows exactly one day and has no date picker — you change the
> day by editing `?date=YYYY-MM-DD` in the address bar. A collection raised for
> tomorrow is simply not on screen.

### 3. Collect it · `9333000005` (Pankaj, on a phone)

Sign in on a phone, or narrow the browser window. **Today's collections** →
open the stop.

Two outcomes and no third. **Collected** takes packages, weight and remarks.
**Could not collect** *requires a reason* and will not save without one.

**Try the failure first**, then collect it properly on a second visit. You
should see both attempts on the record afterwards — nothing is overwritten.

### 4. Receive it · `9333000003` (Dinesh, hub operator)

**Hub → Scan console**, mode **Inbound**. Scan or type the LR.

**You should see** `RECEIVED_AT_ORIGIN`. Now do the same for the **counter**
consignment from step 1 — the one with no pickup. It goes straight from
`BOOKED` to `RECEIVED_AT_ORIGIN`.

> That path did not exist until recently. A branch had to raise a collection
> and complete it for a van that never left the yard, writing a false record of
> who moved the goods into a log that cannot be edited afterwards.

### 5. Weigh it · `9333000003`

**Hub → Weighment.** Enter a weight much larger than the booked one — say 45 kg
against 5 kg.

**Press "Check the price first" before applying anything.** That preview is
there because the alternative was one button that repriced, raised a debit note
and messaged the customer in a single irreversible step, and a clerk who typed
700 for 70 found out from the consignor.

**You should see** the price move, a second calculation stored at invoice stage
with the booking one untouched, and — because 9× is past tolerance — an
exception opened and the consignor told.

### 6. Sort it · `9333000003`

**Hub → Scan console**, mode **Sort**. Status becomes `PROCESSED`.

> There are no sort bins seeded and no screen to create them, so the "drop into
> bin" control never appears. The scan itself works.

### 7. Manifest and trip · `9222000004` (Farhan, dispatch manager)

**Dispatch → Manifests → New.** Gurugram to Jaipur. Add both sorted
consignments. **Close for dispatch.**

**Dispatch → Trips → New.** A vehicle, a driver, the lane. Attach the manifest.
Open the **loading sheet** and scan the packages on. Then **gate out**.

**You should see** `MANIFESTED`, then `DISPATCHED` at the gate.

**Worth trying deliberately:** attach a second heavy manifest to the same
vehicle. Each manifest can be within the payload on its own while the two
together are not, and the gate is the last moment before it is a challan at a
weighbridge. It should refuse.

### 8. Receive at the destination · `9444000003` (Bhanu, Jaipur hub operator)

Gate the vehicle in, then **Hub → Inbound receipt**. Open the arriving manifest
and scan against it — but **deliberately leave one consignment unscanned**, and
scan one barcode that was never on the manifest.

Now hand over: **`9444000001` (Alka, branch manager)** closes the receipt. The
hub operator cannot, and that is deliberate — closing accuses another branch.

**You should see**, on closing: the unscanned packages become a **shortage**,
the stray becomes an **excess**, and both are owned by **Gurugram, the branch
that dispatched**, while Jaipur is recorded as where they were found. Check the
exception tower: the owner column should say `BR-GGN`, not `HUB-JAI`.

> This is the single most consequential act in the building, and until this
> week nothing raised those exceptions at all — a shortage died on a page the
> closing clerk had already walked away from.

### 9. Deliver it · `9444000001`, then `9444000006`

**Delivery → Runs.** Build a run, assign it to `9444000006` (Sohan), order the
stops. Then sign in as Sohan on a phone.

**Fail one delivery first.** It needs a reason; the consignment goes back to
`RECEIVED_AT_HUB` and the attempt count rises. Then deliver it: receiver name,
signature or photograph, and — if it is COD — the cash in full. There is no
part collection.

### 10. Close the day · `9444000001`

**Delivery → COD day end.** The agent hands in what they took; the branch
counts it.

**Try handing in less than was collected.** It should refuse to reconcile and
say what is still out. Until this week it did not: the shortfall column was
overwritten at verification, so an agent who collected ₹1,000, declared ₹800
and had ₹800 counted ended the day reconciled at zero.

---

## Part two — the paths that are not the happy one

### On a consignment's own page

Four controls beside Print, and each appears only when the consignment is in a
state that allows it:

| Control | Try | You should see |
|---|---|---|
| **Cancel** | On a fresh booking, then on one already picked up | Allowed, then refused — once we hold the boxes, giving them back is a return with its own charge |
| **Hold / Release** | Put one on hold, then release it | Status does not move; the hold is its own fact. Release asks what changed |
| **Amend** | Change a consignee phone after dispatch; then try the package count | The phone is allowed — a consignee who has moved is the commonest amendment there is. The count is refused once the goods are ours |
| **Correct status** | As `9999999999`, try to correct something to `DELIVERED` | Refused. A correction cannot manufacture a receiver, proof and a COD reconciliation |

A correction that does go through appears on the timeline **boxed and badged
"Entered by hand"** — the only entry that did not follow from something
physically happening.

### Scope — the half worth testing hardest

Sign in as `9555000001` (Sneha, Mumbai branch manager) and try to reach the
Gurugram consignment you booked. **Search for its LR number.**

You should get nothing. That search box is worth doing by hand because it is
where the boundary broke: the branch filter and the search filter both produced
an `OR`, and written side by side the second silently replaced the first — so
the list scoped correctly with an empty box and answered from the whole network
the moment anyone typed into it.

Also try: opening it by URL (404), printing it (404), and resolving one of the
Gurugram shortages from the Jaipur tower as the Mumbai manager (refused).

### The customer's side

Sign in to `/portal` as `priya@acme.test` / `Portal@123`.

Track a consignment, download a proof of delivery, look at the invoices, raise
a complaint. Then sign in as `vikram@acme.test` — a **member** — and try the
same. Then consider that a **viewer** may read and not act at all.

Open a public tracking link in a private window. It should show the milestones
and **nothing internal**: no branch codes, no staff names, no costs, no device
identifiers.

### The operator console

`https://lms.credohrms.com/platform/login` as `deenanathg@gmail.com` /
`Admin@123#45`.

The tenant list, a carrier's detail, plans, the audit trail. Then the one worth
the most attention: **open a support session** on City Logistics, with a
reason, for the shortest duration offered.

**You should see** a banner on every carrier page naming you, the reason and
the countdown, with an "End session" button that ends the *grant* rather than
just your cookie. Make a change while you are in there, then look at the
carrier's own **Admin → Audit** — the row should carry a **"via support"** tag
beside the staff member's name.

Try it read-only first (no adopted user), then adopted. Adopted, you hold that
person's permissions **except** the three that would mint access outliving the
session — you cannot create a user, a role or an API key.

---

## What not to chase

These are known and deliberate. Finding them is not a bug report.

- **No SMS is sent.** Every SMS template ships inactive because DLT
  registration takes one to three weeks per carrier and an unregistered
  template is dropped by the operator with no delivery report. The code and the
  gateway are in place; the registration is not started.
- **Email sends only if a relay is configured.** With none, the log records the
  send as simulated and says so on the screen.
- **Damage capture does not exist.** The permission, the event type, the
  exception kind and its escalation ladder are all there and nothing writes a
  damage record, so damaged-package counts are permanently zero.
- **Sort bins are not seeded**, so the bin control never appears.
- **An exception cannot be raised by hand** — all of them come from detectors.
- **`shipment.correct_status` is held only by Super Admin**, so a branch cannot
  repair its own mis-scan without you.
- **The offline bar appears on the pickup screens, which do not queue
  anything.** If a pickup is submitted with no signal it fails, and at present
  nothing on the screen says so. The delivery screens do queue properly.
- **A field user signing in normally lands on `/dashboard`**, not on their own
  screen. Bookmark `/pickups/today` or `/delivery`.

---

## If you want the short version

One consignment, ten minutes, and it exercises the spine:

1. `9333000002` — book Gurugram → Jaipur, **Needs pickup off**
2. `9333000003` — Hub → Scan console → Inbound → the LR
3. `9333000003` — Hub → Scan console → Sort
4. `9222000004` — manifest it, trip it, gate it out
5. `9444000003` — gate in, inbound receipt, scan it
6. `9444000001` — build a delivery run
7. `9444000006` — deliver it on a phone

If that runs clean, the spine is intact. Everything else in this document tests
what happens when it does not.
