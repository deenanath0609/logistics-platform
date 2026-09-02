# Carrier office staff manual

For the counter, the dock and the back office: booking executives, hub operators, dispatch managers, branch managers and accounts.

This is written to be opened at the moment you need it, not read through. Find your job in the contents, read that section, go back to work.

Two things are true of this product everywhere, and knowing them saves most of the confusion:

**Nobody types a status.** A consignment's status is worked out from the events recorded against it — a scan at the dock, a gate-out, a signature at the door. You record what happened; the status follows. There is one exception, a status correction, and it is described at the end because it is dangerous.

**A refusal is usually the product doing its job.** This system refuses a great deal on purpose: weighing something before it has been received, closing a manifest onto an overloaded truck, cancelling freight the carrier is already holding. Every refusal you are likely to meet on a normal day is in this manual with the reason behind it. If you find yourself inventing a way round one, that is worth a conversation with your branch manager rather than a workaround.

---

## Contents

1. [Signing in](#1-signing-in)
2. [Finding your way around](#2-finding-your-way-around)
3. [Booking a consignment](#3-booking-a-consignment)
4. [Collections](#4-collections)
5. [Receiving freight at the dock](#5-receiving-freight-at-the-dock)
6. [Weighing](#6-weighing)
7. [Sorting](#7-sorting)
8. [Sending freight out: manifest, trip, loading, gate](#8-sending-freight-out-manifest-trip-loading-gate)
9. [Receiving an inbound manifest](#9-receiving-an-inbound-manifest)
10. [The exception tower](#10-the-exception-tower)
11. [Complaints](#11-complaints)
12. [Delivery runs and COD day end](#12-delivery-runs-and-cod-day-end)
13. [Changing a consignment after it is booked](#13-changing-a-consignment-after-it-is-booked)
14. [Customers, masters and rate cards](#14-customers-masters-and-rate-cards)
15. [Invoices and receivables](#15-invoices-and-receivables)
16. [Reports](#16-reports)
17. [What a branch manager sees that a booking executive does not](#17-what-a-branch-manager-sees-that-a-booking-executive-does-not)
18. [What is not built yet](#18-what-is-not-built-yet)
19. [Reference: who may do what](#19-reference-who-may-do-what)

---

## 1. Signing in

The address is `https://city-logistics.lms.credohrms.com`. Sign-in is at `/login`.

The sign-in box has two tabs.

| Tab | Who it is for | What you enter |
| --- | --- | --- |
| **Password** | Office staff — counter, dock, dispatch, accounts, managers | **Mobile number** (10 digits) and **Password**, then **Sign in** |
| **Mobile OTP** | Field staff — pickup executives, delivery agents, drivers | **Mobile number**, **Send code**, then the 6-digit **Verification code** and **Verify and sign in** |

The screen says so itself: "Office staff use a password. Field staff use a one-time code."

Your mobile number is your login. In the seeded demo network the number tells you the branch and the post: `9` then the branch digit three times, then `00000`, then the post digit.

| Branch | Prefix | Branch Manager `…1` | Booking Executive `…2` | Hub Operator `…3` | Dispatch Manager `…4` |
| --- | --- | --- | --- | --- | --- |
| HO-DEL — Head Office, Delhi | `9111` | 9111000001 | 9111000002 | 9111000003 | 9111000004 |
| HUB-DEL — Delhi Hub | `9222` | 9222000001 Meera Kapoor | 9222000002 Arjun Malhotra | 9222000003 Sunil Tomar | 9222000004 Farhan Sheikh |
| BR-GGN — Gurugram Branch | `9333` | 9333000001 Neha Bhatia | 9333000002 Gaurav Saini | 9333000003 Dinesh Rawat | 9333000004 Shalini Ahuja |
| HUB-JAI — Jaipur Hub | `9444` | 9444000001 Alka Sharma | 9444000002 Mahesh Choudhary | 9444000003 Bhanu Pratap | 9444000004 Kirti Jain |
| BR-BOM — Mumbai Branch | `9555` | 9555000001 | 9555000002 | 9555000003 | 9555000004 |
| BR-FBD — Faridabad Branch | `9666` | 9666000001 | 9666000002 | 9666000003 | 9666000004 |
| HUB-AMD — Ahmedabad Hub | `9777` | 9777000001 | 9777000002 | 9777000003 | 9777000004 |

Post digit `5` is the pickup executive and `6` the delivery agent at each branch; both are field staff and sign in with a one-time code, not a password. The password on every seeded office login is `Admin@123`.

Accounts is not one of the six branch posts. The seeded accounts login is `9999900010` (Priya Menon), and it works across the whole network rather than at one branch.

### When sign-in fails

Every failed password sign-in gives the same sentence, whatever went wrong:

> Those details did not match. After 5 failed attempts the account locks for 15 minutes.

That one message covers a wrong password, a mobile number the system does not know, a suspended or deactivated account, an account already locked, and signing in on the wrong carrier's address. It is deliberately the same in every case — telling you which one it was would let somebody outside the company work out who has an account here.

So if you are certain of the password and it is still refused, the useful questions are: is this the right web address, and has somebody deactivated the account. Your branch manager or an administrator can check both on the Users screen; you cannot tell from the login page.

Five failures locks the account for fifteen minutes. A successful sign-in clears the count, and so does a password reset by an administrator. A session lasts twelve hours.

### When you must change your password

If your account was set up by somebody else — an administrator created it and handed you the password, or reset it for you — the first thing you see after signing in is not the dashboard. It is the password screen, and nothing else in the product will open until you have used it.

> **Choose your own password**
> Your account was set up with a password somebody else chose and handed to you. Replace it before you go any further — until you do, whoever wrote it down can sign in as you.

Three boxes: **The password you were given**, **New password**, **Confirm new password**, then **Set password**.

The new password must be **at least 8 characters, with at least one letter and at least one digit**, and it must be different from the one you were given. If the two new boxes do not match you get "The two passwords do not match"; if you re-type the old one you get "Choose a password you have not used here before"; if you mistype the current one the banner reads "That is not your current password."

You can change your password at any time afterwards from the user menu at the top right — **Change password**. It asks for the current one even though you are already signed in, because an unattended session is the ordinary way an account gets taken over.

Two accounts that will never see this screen: a field user, who has no password at all ("This account signs in with a one-time code, so it has no password to change"), and the seeded demo logins, which are deliberately left ready to sign into.

### Signing out

The user menu at the top right, then **Sign out**.

---

## 2. Finding your way around

### The menu is not the boundary

The left-hand menu shows only what your login can actually open. If a colleague has a menu entry you do not, that is one of two different problems with two different people who can fix it:

- **A permission your role does not hold.** Your branch manager or an administrator can grant it on the Roles screen. No system change is needed.
- **A part of the product your company has not bought.** Nobody inside the company can turn it on. Typing the URL directly gets you a page headed "*Something* is not on your plan" which says so plainly: "Only whoever manages your company's subscription with us can add it. A branch manager or an administrator here cannot grant it — there is no permission to turn on."

If you type a URL your role cannot open, you land on a page headed **You do not have access to this**, which tells you to ask your branch manager.

### The menu, in full

Only the groups relevant to office staff are listed here; you will see a subset.

| Group | Entries |
| --- | --- |
| Overview | Dashboard |
| Operations | Shipments, Pickups, Bulk upload, Customers |
| Hub | Dock, Scan console, Weighment, Inbound receipts |
| Dispatch | Manifests, Trips |
| Delivery | Delivery runs, COD |
| Fleet | Vehicles, Drivers, Field staff, Vehicle types, Document expiries |
| Network | Branches & hubs, Cities, Pincodes, Zones, Routes, SLA policies |
| Masters | Service types, Package types, Charge heads, Tax rates, Reason codes, Number series |
| Control tower | Exceptions, Live tracking, Reports, Insights |
| Finance | Overview, Invoices, Receivables, Rate cards, Settlements, Vendors |
| Customer care | Complaints, Notification log, Templates |
| Administration | Users, Roles & permissions, Audit trail, API keys, Webhooks |
| Help | How this works |

**How this works** at the foot of the menu is open to everybody, whatever permissions they hold. It lists every status a consignment can wear, what puts it there, and what the customer is told instead. It is the fastest way to settle an argument about what a status means.

### Your branch

Next to your name at the top right there is a small code — `BR-GGN`, `HUB-DEL`. That is your home branch, and it is read-only. **There is no branch switcher.** How far you can see is fixed by your roles:

| Reach | What you see |
| --- | --- |
| Own records only | Only work assigned to you personally. Field staff. |
| Their branch | Your one home branch. Booking executives, hub operators, branch managers. |
| Assigned branches | Your home branch plus any others ticked on your user record. Dispatch managers. |
| Whole network | Every branch. Operations managers, accounts, customer support, administrators. |

If you hold several roles you get the widest reach among them. If you are branch-scoped and nobody has set your home branch, you see **nothing** — that is deliberate, and the fix is an administrator setting your primary branch on the Users screen.

### Searching

There is no global search box. Each list screen has its own, in the top right of the page, and it searches that list only:

| Screen | What the box accepts |
| --- | --- |
| Shipments | LR, phone, name, reference |
| Pickups | Number, name, phone, PIN |
| Weighment | LR number or name |
| Exceptions | Number, LR or description |
| Complaints | Number, subject or LR |
| Users | Search name, mobile, code |
| Audit trail | Search reference, id, user |
| Notification log | Recipient or LR number |

To find one consignment, go to **Shipments** and type the LR number.

> [SCREENSHOT: /dashboard — the full ops shell signed in as 9333000001, showing the left menu, the branch chip and the user menu open]

---

## 3. Booking a consignment

**Operations → Shipments → New booking**, or the direct path `/shipments/new`. You need the `shipment.create` permission; booking executives and branch managers have it.

### A consignor is at your counter with three boxes for Jaipur

Work down the form. It is one page, in six blocks, with a summary bar that stays at the bottom of the screen.

**Service and route.** Pick the **Service** first — it decides more than it looks. The service sets the volumetric divisor used to work out chargeable weight, the transit expectation, and whether To-Pay and COD are offered at all. **Mode** fills itself in from the service and cannot be edited. **Origin branch** defaults to your own counter and only lists branches you work at. **Destination branch** is the whole network, because a consignment goes wherever it is addressed.

The seeded services are `FTL-STD` (Full Truck Load — Standard), `PTL-EXP` (Part Load — Express), `PTL-STD` (Part Load — Standard) and `CRR-EXP` (Courier — Express).

**Consignor.** If the sender has an account, pick it under **Account** and the name, phone, GSTIN and saved pickup address fill in. Otherwise leave it on **Walk-in / cash booking** and type the details. Phone must be exactly ten digits; PIN exactly six.

**Consignee.** The same fields plus **Landmark**. The consignee's phone is worth getting right — the help text says so: "Delivery OTP goes here."

Type the destination PIN and wait a moment. The form checks it against the network and tells you the answer before you have filled in the rest of the page:

- **Not in the network** — a red bar at the bottom: "**302099** is not in the network, so this booking cannot be made. Change the destination PIN, or add it under Network → Pincodes." The **Book shipment** button is disabled. There is no way round this from the counter.
- **Suspended** — "Delivery to *Jaipur* is suspended. Only someone with the serviceability override permission can book to it." A booking executive does not have that permission; a branch manager does not either. Send the consignor to your operations manager or take the booking to a serviceable PIN.
- **Out of delivery area (ODA)** — an amber bar: "*Jaipur* is out of delivery area. An ODA charge applies and transit will take longer — tell the consignor before you book." This is a warning, not a refusal. Tell them before you save, not after.

**Goods.** **Packages**, **Package type**, **Actual weight (kg)** and **Declared value (₹)** — the declared value sets the claim ceiling. Then **Length**, **Breadth** and **Height** in centimetres, *per package*.

Beside the dimensions a box shows **Chargeable weight** live, with the working underneath: "volumetric 14.40 @ ÷5000 — billing on volumetric". Volumetric weight is length × breadth × height × package count ÷ the service's divisor, and whichever of actual and volumetric is greater is rounded up to the next half kilogram. Enter the dimensions if the goods are light and bulky; if you leave them blank the box reads "enter dimensions for volumetric" and you are billing on actual weight alone.

**Goods description** is required — two characters minimum, and it is what gets printed on the LR and the e-way bill, so write what is in the box.

Two switches sit under the instructions:

- **Fragile** — "Flags it on the label and the manifest."
- **Needs pickup** — on by default. See below.

**Charges.** What you see here depends on your permission.

Without `shipment.override_rate` — which is most people, including booking executives and branch managers — there are no boxes at all, just a sentence: "The tariff decides the freight, the fuel surcharge and the tax. You will see the figures on the consignment once it is booked." The summary bar reads "priced on save".

With the override permission you get one box per charge head, and typing anything into any of them replaces the rate card for the whole consignment. Do not use it to add a charge on top of the tariff — one line of ₹1 suppresses the tariff entirely. The tariff is still calculated and stored alongside, and the override is written to the audit trail as an override with both figures on it. If somebody without the permission manages to post charges anyway, the booking is refused: "Freight is priced from the rate card. Entering charges by hand is a rate override, which needs a permission this account does not have."

**Payment and references.** Four payment types:

| Option | Meaning |
| --- | --- |
| Paid — consignor pays now | The sender pays at the counter |
| To-Pay — consignee pays freight | Greyed out if the chosen service does not allow it |
| TBB — billed to account | Billed to the consignor's account |
| COD — collect on delivery | Greyed out if the service does not allow it; opens a **COD amount (₹)** box, which must be more than zero |

Then **Customer reference** (their PO or order number), **E-way bill** ("Part-B updates at each transshipment"), **Invoice number**, **Invoice value**, and a **Reverse charge** switch — on for GTA supplies, where the recipient pays the tax and the invoice must say so.

Press **Book shipment**. The LR number is issued at that moment, inside the same transaction as the consignment, so an abandoned form never burns a number. You land on the consignment with the number at the top.

> [SCREENSHOT: /shipments/new — the whole booking form filled in for a Gurugram-to-Jaipur consignment, with the chargeable-weight box and the sticky summary bar visible, signed in as 9333000002]

### Counter drop-off: "Needs pickup" switched off

The switch says "Off means the consignor is delivering to the branch." Turn it off when the goods are on your counter, or when the consignor is bringing them in later themselves.

This is not cosmetic. It changes three things:

1. **No collection is raised.** With the switch on, booking creates a pickup request in the same transaction — same number series, dated today, slot "Anytime", unassigned — and it appears on **Pickups** for somebody to send a van for. With it off, no pickup exists and nobody is waiting for a van.
2. **The consignment enters the network by a scan, not by a collection.** With the switch on, the path is *Booked → Pickup assigned → Picked up → Received at origin*. With it off, an inbound scan at your own dock takes it straight from *Booked* to *Received at origin*. You do not need to invent a pickup and complete it for a van that never left the yard.
3. **It appears in a different place on the Shipments list.** The chip **Awaiting pickup** counts only consignments a van has to be sent for. Counter drop-offs sit under **Coming to the counter**. Both are still *Booked*; the difference is who is doing the moving.

So for the consignor standing in front of you with three boxes: switch **Needs pickup** off, book it, print the labels, stick them on, and then scan the three boxes in on the scan console in Inbound mode. That is the whole counter flow.

> [SCREENSHOT: /shipments/new — the Goods block with "Needs pickup" switched off, signed in as 9333000002]

### Why a booking is refused

| The message | What has happened |
| --- | --- |
| Check the highlighted fields. | Something failed validation. The fields go red; a phone that is not ten digits and a PIN that is not six are the usual two. Nothing you typed is lost. |
| You can only book at a branch you work at. | The origin branch is outside your reach. |
| That customer account is outside the branches you cover. | You have named an account belonging to another branch. |
| That destination PIN code is not in the network. | The PIN has never been added under Network → Pincodes. |
| That PIN code is not serviceable. An override permission is needed to book it. | Delivery there is suspended. |
| COD is not offered on *PTL-STD*. / To-Pay is not offered on *CRR-EXP*. | The service does not allow that payment type. |
| Enter the amount to collect on delivery. | COD chosen with no amount. |
| *PTL-EXP* is a PTL service, not FTL. | The service and the mode disagree. You cannot normally cause this from the form. |
| Freight is priced from the rate card. Entering charges by hand is a rate override… | Charges typed without the override permission. |
| *The account's own message* | The consignor's account is blocked, past terms, or over its credit limit. See [Customers](#14-customers-masters-and-rate-cards). |
| That booking appears to have been saved already. Refresh and check before retrying. | A double submit. Check the Shipments list before booking again. |
| Booking failed. Nothing was saved. | Something unexpected. Nothing was written — no LR number was used. |

One thing that is deliberately *not* a refusal: if the rate card has no rule covering this lane, the booking still goes through, at zero freight, and lands on the coverage-gaps report for accounts to fix. A consignor standing at the counter should not be sent away because a tariff row is missing.

### Printing the LR and the labels

On the consignment, **Print LR & labels** (needs `shipment.print`). You get a print preview: the consignment note on top — both parties, the goods, the weights, the charges, the reverse-charge line where it applies, and three signature blocks (**Consignor signature**, **Booking clerk**, **Received in good order**) — and below it one label per package, each carrying its own barcode.

Barcodes are the LR number with a two-digit suffix: `CL20260902-0041-01`, `-02`, `-03`. That per-package barcode is what makes shortage detection possible later — a manifest of seventeen that scans fifteen can only name the missing two because each box has its own label.

Press **Print**. The conditions of carriage print only if your company has written them; there is no default text, because a claim window invented by the software would be worse than none.

### Booking a whole day's work at once

**Operations → Bulk upload** (`/shipments/bulk`), needs `shipment.bulk_upload`. Download the template, fill it in, upload the CSV or XLSX, and check the rows. Invalid rows can be corrected in place and re-checked. Then commit: "Valid rows book and invalid rows stay here for correction — a file with seven bad rows still books the other hundred and ninety-three."

---

## 4. Collections

**Operations → Pickups.** The screen shows **one day at a time** — the heading names it, "Tuesday 2 September · 14 scheduled, 3 unassigned". Along the top is a strip of your branch's pickup executives with their load for the day, as `2 · 31 pkg`: two collections, thirty-one packages between them.

Most collections are already here. A booking taken with **Needs pickup** on raises one automatically, dated today, unassigned.

### Raising one for a consignor who telephones

**New pickup** (needs `pickup.create`). The dialog explains what it is for: "For the consignor who telephones. A collection booked at the counter already has one — this is the one nobody has written down yet, so it carries no consignment until the goods arrive."

Fields: **Collecting branch**, **Account (optional)**, **Whom to ask for**, **Phone**, **Address**, **City**, **PIN code**, **Landmark**, **Collect on**, **Slot** (Anytime, Morning, Afternoon, Evening), **Priority**, **Packages expected**, **Weight expected (kg)**, **What is being collected**, and **Notes for the executive** — "Gate code, which dock, when the office shuts".

There is no LR number on this. The consignment gets booked when the goods reach the counter.

### Sending somebody for it

**Assign** on the row (needs `pickup.assign` — a **branch manager**, not a booking executive; the Booking Executive role deliberately does not hold it). The dialog lists the branch's executives with their load, and marks one **Suggested**, titled "Lightest load today". The description explains the measure: "Load is measured in packages, not stops — ten single-carton collections are not the same job as one forty-package load." You can also give the collection a **Stop number**.

Once assigned the button becomes **Reassign**.

### Calling one off

**Cancel** on the row. The dialog names who is carrying it — "Pankaj Yadav is carrying this stop. Cancelling takes it off their run." — and asks why, minimum three characters, "Give a reason — it goes on the record."

### What the office cannot do

The office raises, assigns and cancels collections. It does not complete them. Only the pickup executive, from their phone, records that the goods were collected or that the attempt failed — and a failed attempt is history rather than a status change, because the consignment is still owed a collection. If you need a collection marked done and the executive cannot do it, that is a status correction, not a shortcut.

### Refusals

| The message | What has happened |
| --- | --- |
| Check the highlighted fields. | Usually "Choose an executive". |
| That pickup no longer exists. | It was cancelled or removed while your screen was open. |
| That pickup is outside your scope. | Another branch's collection. |
| That executive is no longer available. | The person has been deactivated, or is not a field user at your branch. |
| Give a reason — it goes on the record. | Cancelling with fewer than three characters of reason. |

One trap worth knowing: the list shows exactly one calendar day. A collection raised for tomorrow is not missing, it is on tomorrow. Use the `?date=YYYY-MM-DD` parameter in the address bar to look at another day — there is no date picker on this screen.

---

## 5. Receiving freight at the dock

**Hub → Scan console** (`/hub/scan`). The heading tells you the posture: "Point the gun and pull. Each read is written the moment it lands, and the consignment's status follows from it — nobody types a status here."

If your account covers more than one branch you are asked to pick first — "Scans are written against a branch, so pick the one you are standing in before you start." If you have no branch at all, "No branch is assigned to you. Ask an administrator to set your primary branch."

### The six modes

Across the top are mode buttons. You only see the modes your role can use.

| Mode | What it does | Permission |
| --- | --- | --- |
| **Inbound** | Receiving freight off a vehicle. Moves the consignment to received at this branch. | `scan.inbound` |
| **Sort** | Routing a package to a bin after receipt. Moves it to processed. | `scan.sort` |
| **Load** | Putting a package on a vehicle against a loading sheet. | `loading.execute` |
| **Outbound** | A dock record of freight leaving. Dispatch itself happens at gate-out on the trip. | `scan.outbound` |
| **Unload** | Taking a package off a vehicle at this branch. | `scan.inbound` |
| **Stock audit** | Counting what is physically here. Records the sighting and moves nothing. | `scan.inbound` |

Two of these change nothing about the consignment on purpose. **Outbound** is a dock record only — freight is dispatched at gate-out on the trip, not by waving a gun at a box. **Stock audit** writes the sighting and moves nothing at all, because an audit that disagrees with the system is precisely the thing worth finding, and a count that quietly corrects what it counts is not a count.

A hub operator holds Inbound, Sort, Load, Outbound, Unload and Stock audit. A dispatch manager holds Load and Outbound only. A booking executive has no scanning permissions at all and gets "Your role has no scanning permissions."

### Scanning

The console reads a barcode gun that sends Enter, and one that does not — it picks the read up from the keystroke burst. You can also type an LR number, which resolves to the whole consignment rather than one box; that is how you handle a customer reading a number down the phone.

Each read comes back immediately in one of three colours, with a running tally above the list: **Scanned**, **Accepted**, **Warnings**, **Rejected**.

| Colour | Message you will see | What it means |
| --- | --- | --- |
| Green | `CL20260902-0041 · box 2 of 3` | Recognised, expected, and it moved. |
| Amber | Already recorded — this scan was retried. | The same trigger pull reached the server twice. Nothing was duplicated. |
| Amber | A refusal sentence from the state machine, e.g. "Cannot record received from Received at hub." | The scan is written down, but the consignment could not move — usually a box scanned inbound twice, or one sorted before it was received. |
| Red | Not a known barcode. Recorded as unexpected. | Nothing in the system matches. It is still recorded. |
| Red | `CL20260902-0041 is not on this list — recorded as excess.` | Recognised, but not on the paperwork in front of you. |

Every scan is written whether or not it moves the consignment. That is the point: "the evening reconciliation needs to know what was in the operator's hand."

> [SCREENSHOT: /hub/scan — the console mid-session showing the six mode buttons, the tally and a feed with one green, one amber and one red row, signed in as 9222000003]

### Refusals on a scan

| The message | What has happened |
| --- | --- |
| You do not have permission to scan *inbound*. | Your role does not hold that mode's permission. |
| You cannot scan at that branch. | The branch is outside your reach. |
| That bin does not exist here. | The bin is gone or deactivated. |
| Bin *L4* belongs to another branch. | You have named a bin on somebody else's floor. Refused rather than dropped, because a scan that did not put the box where you said it went is worse than a refusal. |
| Empty scan ignored. | Nothing came off the gun. |
| The scan could not be recorded. Try again. | Something unexpected. Nothing was written. |

### Sort bins

**Sort bins are not set up.** In Sort mode the console offers a row of bin buttons — **No bin**, then one per bin — but only when bins exist at that branch, and nothing in the product creates them. There is no masters screen for them and the seed does not make any. Until somebody loads them into the database, sorting works and simply records no bin, which means the floor's answer to "which lane is this box in?" is empty. Sorting itself is unaffected.

---

## 6. Weighing

**Hub → Weighment** (`/hub/weigh`), needs `weight.capture` — hub operators and branch managers. The heading states the stakes: "What the scale reads is what bills."

The list shows consignments **already received at a branch or hub** and nowhere else. That is the same rule the state machine enforces, so you are never invited to weigh something you cannot weigh. Press **Weigh** on a row.

Three boxes:

| Field | Note under it |
| --- | --- |
| **Scale reading (kg)** | What the weighbridge shows. |
| **Chargeable override (kg)** | Leave blank to recompute from the scale and the volumetric figure. |
| **Weighbridge slip** | Ticket number, for the dispute six months from now. Maximum 80 characters. |

### Check the price first

There are two buttons, and the order matters.

**Check the price first** prices the reading without applying anything. You get a line like:

> Would charge **35.500 kg** · ₹1,240.00 → **₹2,980.00** (₹1,740.00, 140.32%)
> Past the 10.00% tolerance — recording this opens an exception and notifies the consignor.

Nothing has been applied to the consignment. If the figure looks wrong — 700 typed for 70 — you have caught it here. Use this button. Recording a weight reprices the consignment, raises a debit note and tells the customer in one step, and none of that is undone from this screen.

**Record weight and reprice** commits it.

### What a revision actually does

Five things, in order:

1. **The consignment is re-priced** on the revised weight, and a second calculation is stored. The booking figure is never overwritten — what the customer was quoted at the counter survives, so the two sit side by side for good.
2. **`Weight captured` goes on the timeline**, carrying both weights, both totals and the difference. The status does not change; a weighing is not a movement.
3. **If the consignment has already been invoiced**, a debit note is raised, because an issued invoice cannot be edited.
4. **If the increase is past tolerance**, an exception is opened against the branch and the consignor is notified before the invoice reaches them.
5. **It is written to the audit trail** with the before and after figures.

The confirmation is explicit about which happened:

> Weight recorded. The change is past tolerance, so it has been raised and the consignor told.
> `CL20260902-0041` · 12.000 kg → **35.500 kg** · ₹1,240.00 → **₹2,980.00** (₹1,740.00, 140.32%)
> Debit note `DN…` · Exception `EXC0000123`

### Refusals when weighing

| The message | What has happened |
| --- | --- |
| Enter what the scale read. | Both weight boxes are empty. |
| *CL…* is booked. A consignment is weighed once it has been received at a branch or hub — scan it in first. | The commonest one. Receive it before you weigh it. |
| Actual weight cannot be zero — that is not a weighing. | Zero or a negative number. |
| That actual weight is not a number. | Non-numeric input. |
| *CL…* is already billed on *INV/2627/DEL/0412*. Revising the weight now raises a debit note, which needs the post-invoice weight permission. | The consignment is on an issued invoice. `shipment.edit_weight_post_invoice` is a separate sensitive permission; no seeded operational role holds it. |
| *CL…* has not been anywhere near your branches. Weighing it here would reprice another branch's consignment. | The consignment has never been at, from, or bound for any branch you cover. |
| That consignment is cancelled. Nothing to reweigh. | Self-explanatory. |
| You cannot weigh at that branch. | The branch is outside your reach. |
| Your account has no home branch, so there is no weighbridge to record against. | Shown instead of the form. An administrator sets your primary branch under Administration → Users. |

Two warnings you may see alongside a successful weighing rather than instead of it: "No rate rule matched this lane, so the revision priced at zero and the consignment stays on the coverage-gaps report", and "The timeline would not accept the weighing" — in both cases the money was saved and the message is telling you what else needs attention.

> [SCREENSHOT: /hub/weigh — the weigh form with a preview showing a past-tolerance increase, signed in as 9222000003]

---

## 7. Sorting

Sorting is a scan, not a screen of its own. Go to **Hub → Scan console**, choose **Sort**, pick a bin if any exist, and scan. Each read moves the consignment from *Received* to *Processed*.

This matters more than it looks, because **processed is the gate into dispatch**. A manifest will only accept consignments that are processed: "a booking that has not been sorted has no confirmed route, and manifesting it is how freight ends up in the wrong city." If a dispatch manager tells you a consignment will not go onto tonight's manifest, the usual answer is that nobody has sorted it.

The **Branch floor** screen (`/hub`) counts this for you as **Pending sort** — "Received but not routed", against **Awaiting dispatch** — "Sorted, ready for a manifest".

---

## 8. Sending freight out: manifest, trip, loading, gate

Four things happen in order, on three screens. A manifest is the paperwork for one leg. A trip is the vehicle. A loading sheet is the count as the boxes go on. Gate-out is the moment the network agrees the freight has left.

### The manifest

**Dispatch → Manifests → New manifest.** "One leg, one document. You can add consignments and assign a vehicle after it exists." Choose **From**, **To**, optionally a **Vehicle** — that is a planned trip, and attaching one now "is what makes the capacity bar meaningful" — and **Remarks**.

Open the manifest and use **Awaiting dispatch** to add lines. Tick the consignments going on this truck; the panel shows the destination code against each, green when this leg is its final destination and amber when it transships onward. As you tick, the footer projects the load: "4 selected · would take the truck to 78%".

A consignment can be refused a place on the manifest, one by one, with its own reason — you are told which and why, and the rest still go on:

| Reason given | What it means |
| --- | --- |
| Is *booked*, not processed — sort it first | The commonest. Sort it. |
| Is at *HUB-DEL*, not at this manifest's origin | The freight is standing somewhere else. |
| On hold | Somebody has held it. See [holds](#13-changing-a-consignment-after-it-is-booked). |
| FTL consignments bind to a trip directly and never sit on a manifest. | Full-truck freight goes onto a trip, not a manifest. |
| Already on this manifest | Duplicate tick. |
| Would put *HR26AB1234* over its rated payload — 240.000 kg of headroom left, and this consignment is 380.000 kg | The truck is full. |
| Not found | The consignment is gone. |

**Close for dispatch** freezes the lines: "After this the lines are frozen — they are what the receiving hub reconciles against." The dialog shows the utilisation, amber below 60%.

Closing is refused if the manifest is empty ("An empty manifest has nothing to dispatch."), if it is already closed ("*M000123* is already closed."), if it belongs to another branch, or if the load is over the rated payload — "*M000123* is over the rated payload — … Take a consignment off, or put it on a larger vehicle."

**Reopen** is possible only before the vehicle gates out, needs `manifest.reopen`, and asks why in at least four characters. The reason goes to the audit trail. Once the truck has left: "*M000123* has already been dispatched. Raise an exception instead of editing it."

### The trip

**Dispatch → Trips → Plan trip.** "A vehicle, a driver, and a lane. Gate-out happens later, from the trip screen."

Pick **PTL** ("Carries manifests for one leg") or **FTL** ("One consignment, no manifest"), then **From**, **To**, **Vehicle**, **Driver**, **Route**, **Planned departure**, **Expected arrival**, **Seal number** and **Remarks**.

Planning is refused for a reason that is nearly always a real-world fact rather than a software problem:

| The message | What has happened |
| --- | --- |
| A trip runs between two different branches. | Origin and destination are the same. |
| That vehicle is not available. | Deactivated or deleted. |
| *HR26AB1234* is maintenance and cannot be assigned. | Off the road. |
| *HR26AB1234*: *its fitness certificate expired on 12 Aug 2026* | Mandatory vehicle paperwork has lapsed. The same rule and the same words as the fleet screens. |
| *HR26AB1234* is in transit on *TRIP-2026-00412*. Close that trip before sending it out again. | The truck is already out. |
| *Balwinder Singh* is on leave. | Self-explanatory. |
| *Balwinder Singh*: *licence expired on 3 Jul 2026* | Licence, suspension or deactivation. |
| *Balwinder Singh* is out on *TRIP-2026-00412*. Close that trip first. | The driver is already out. |
| *CL…* is a PTL consignment. Put it on a manifest instead of binding a whole truck to it. | FTL binding on part-load freight. |

On the trip, **Attach a manifest** offers "Draft and closed manifests running the same leg, not already on another truck", and tells you the headroom left. Everything on an attached manifest gates out with this vehicle.

### The loading sheet

From the trip, **Loading sheet**. Open one, then scan each package as it goes on. "Scan each package as it goes on. The sheet will not close while something on the paperwork is unscanned, or something scanned is not on the paperwork."

The tally has four numbers: **On paperwork**, **Loaded**, **Not loaded**, **Not on paperwork**. **Close loading sheet** stays disabled until the last two are both zero. If you force it through another route the service says so:

> 3 packages on the paperwork are not scanned onto the vehicle, and 1 scanned package is not on the paperwork. Resolve both before closing — a sheet that closes over a mismatch is worth nothing at the other end.

There is no override. Find the boxes, or take them off the manifest.

Once the sheet is closed the trip can gate out. Opening a new sheet starts the count again.

### Gate-out

On the trip, **Gate out**, needs `trip.dispatch` — dispatch managers and branch managers.

> **Dispatch this trip**
> 17 consignments will be marked dispatched in one go. This is the moment the network considers the freight to have left.

Fields: **Odometer (km)**, **Seal number** — "The receiving branch checks this against the seal on the door. A mismatch is an exception, not a formality." — and **Remarks**. The button is **Dispatch**.

Gate-out is refused for:

| The message | What has happened |
| --- | --- |
| A loading sheet is still open. Close it first — until then the floor has not confirmed that what is scanned is what is on the vehicle. | Shown in the dialog; the button is disabled. |
| *M000123* is still in draft. Close for dispatch first. | An attached manifest was never closed. |
| *TRIP-2026-00412* is over the rated payload — … Take a manifest off, or move the load to a larger vehicle. | Two manifests can each pass the check alone and overload the truck together. This is the last moment the load is yours; after it, the overload is a driver at a weighbridge with a challan. |
| There is nothing on this trip to dispatch. | No manifest, no FTL consignment. |
| *TRIP-2026-00412* has already been dispatched. | Self-explanatory. |
| That trip departs from another branch. | Outside your reach. |

There is also **Vehicle at gate** before it, which simply records that the truck has reported.

### Arrival at the far end

The receiving branch uses **Gate in** on the same trip, which asks for the **Odometer**, the **Seal** — **Intact and matching**, **Broken, missing, or a different number**, or **Not checked** — and remarks. That moves every consignment on the trip to *Arrived at hub*.

Gate-in is a movement of the vehicle. It is not a receipt of the freight. The receipt is the next section, and it is the one that matters.

---

## 9. Receiving an inbound manifest

This is the most consequential act in the building. Closing an inbound receipt converts every unscanned line into a **shortage** and every unexpected box into an **excess**, automatically, **owned by the branch that dispatched the manifest**. It is not undone from this screen.

**Hub → Inbound receipts** (`/hub/inbound`). Three sections:

- **Open on the dock** — half-scanned receipts, first, because they are the work in progress. Each card shows `12 / 17 packages` and a **Continue scanning** link.
- **Expected here** — manifests dispatched to this branch. A manifest that has been closed but not gated out carries the tag **not gated out**.
- Closed receipts below, marked **Clean** or **Discrepancies**.

### Opening a receipt

Press **Receive** on the manifest. Before the doors come open, the dialog asks one question:

> **Seal on arrival**
> ○ Intact — matches the number on the paperwork
> ○ Broken or missing
> ○ Not checked *(the default)*
>
> A broken seal is recorded as a discrepancy against HUB-DEL when the receipt closes.

Answer it now. After forty boxes are on the floor nobody can honestly say.

Then **Open receipt**. A receipt that is already open is resumed rather than duplicated — the dock walks away from a half-scanned truck all the time, and a second receipt would split the scans across two reconciliations.

Opening is refused for:

| The message | What has happened |
| --- | --- |
| *M000123* has not been closed for dispatch yet — nothing has left the origin branch. | The manifest is still in draft at the other end. |
| *M000123* has not been gated out — *TRIP-2026-00412* is still at the origin. Receiving it now would record the boxes and move none of them. Ask the dispatching branch to gate the vehicle out first. | **The important one.** The truck is standing in front of you but the network still believes the freight is at the origin. If you receive it anyway the lines tick green, the reconciliation comes out clean, and not one consignment moves — you would have signed for freight nobody dispatched. Ring the dispatching branch. |
| *M000123* has already been received and reconciled. Anything found afterwards belongs on the existing receipt's discrepancies, not on a second one. | A manifest is reconciled once. |
| *M000123* is consigned to another branch. Receiving it here would hide a misroute — raise it as an exception instead. | The manifest is addressed elsewhere. |
| *M000123* was cancelled. | Self-explanatory. |
| You cannot receive at that branch. | Outside your reach. |

### Scanning against it

The console checks every read against the manifest: "Every read is checked against *M000123*. A barcode that is not on it goes red and becomes an excess against HUB-DEL at close."

The tally is four numbers — **Expected**, **Received**, **Still missing**, **Unexpected** — and beside them a line per consignment ticking from grey to amber to green as its last box lands, shown as `2/3`.

### Closing it

**Close & reconcile.** If everything matched:

> All 17 packages are accounted for. Closing files the receipt as clean.

If it did not:

> Closing raises these against the dispatching branch. It cannot be undone from this screen.
>
> Short — never scanned here **3**
> Excess — not on this manifest **1**

The dialog asks the seal question again — **Intact**, **Broken or missing**, **Not checked** — and offers **Remarks**: "Anything the dispatching branch should know — pallet condition, late arrival, driver's account of a missing box." Then **Close receipt**. The other button is **Keep scanning**.

### What closing does

| Then | Result |
| --- | --- |
| Every declared package nobody scanned | A **SHORT** discrepancy, owned by the dispatching branch: "Declared on M000123, never scanned at this hub." |
| Every scanned package the manifest did not declare, but the system recognises | An **EXCESS**: "Scanned here but not listed on M000123 — likely misrouted." |
| Every scanned barcode the system does not recognise at all | An **EXCESS**: "Scanned here; the barcode matches nothing in the system." |
| A seal reported broken | A **SEAL_BROKEN** discrepancy: "Seal reported broken on arrival." |
| Each affected consignment | One `Discrepancy raised` entry on its own timeline — "3 packages short against M000123" — not one per box |
| The exception tower | One exception per affected consignment, plus a single one folding together every unidentified barcode, plus one for a broken seal. Owner: the dispatching branch. They escalate to the branch manager after a day and the operations manager after two. |
| The manifest | Marked **Reconciled** if clean, **Received** if not |
| The receipt | Marked **Reconciled** if clean and sealed, **Closed** otherwise |

The exception detail is written to be read by somebody at the other branch: "*M000123* declared 3 packages (CL…-01, CL…-02, CL…-03) that were never scanned at the receiving hub. The dispatching branch loaded them and owns the shortage until it can show otherwise."

### Closing is refused for

| The message | What has happened |
| --- | --- |
| You do not have permission to close a receipt. | `receipt.close`. Hub operators **do not have it** — the console tells them so: "You can scan into this receipt but not close it. Closing raises discrepancies against another branch, which needs the receipt.close permission." Branch managers and operations managers do. |
| This receipt has already been closed. | Somebody else got there first. |
| You cannot close that branch's receipt. | Outside your reach. |
| This receipt has no manifest to reconcile against. | Should not happen from the screen. |

### After it is closed

The receipt shows four tiles — **Expected**, **Received**, **Short**, **Excess** — then the **Discrepancies** table (Kind, Consignment, Barcode, What happened, Owner, Status) and **Lines as reconciled** with a Difference column.

A discrepancy is never deleted. **Resolve** (needs `discrepancy.resolve` — branch managers, not hub operators) adds the outcome beside it: "What was the outcome?" with an example, "Found in the sort area and scanned in. Origin branch confirmed it was loaded." At least four characters, or "Say what the outcome was." The footer says it plainly: "Discrepancy rows are permanent; resolving one records the outcome beside it rather than removing it."

> [SCREENSHOT: /hub/inbound/[id] — an open receipt part-scanned, showing the four-number tally and the per-consignment tick list, signed in as 9444000003]

> [SCREENSHOT: /hub/inbound/[id] — the Close & reconcile dialog open, showing three short and one excess and the seal question, signed in as 9444000001]

---

## 10. The exception tower

**Control tower → Exceptions.** "Everything wrong in the network right now, worst first and oldest first within that. Nothing closes without a resolution note."

### Where exceptions come from

**You cannot raise one by hand.** There is no "new exception" button anywhere in the product. Every exception is opened by the system, from five places: the SLA scanner, the hub dwell and POD monitors, an inbound receipt closing short or excess, a weighing past tolerance, and the GPS monitors. This is worth knowing when somebody asks you to "raise an exception for this" — the honest answer is a complaint, or a note on the exception the system has already opened.

They are de-duplicated on the problem rather than the moment, so a repeated scan does not open a second one and the age clock keeps counting from the first detection.

### The views

| Chip | What it shows |
| --- | --- |
| **Open** | Everything live — open, acknowledged or in progress. The default. |
| **Critical** | Live, and critical or high priority. |
| **Mine** | Live and assigned to you. |
| **Unassigned** | Live with nobody on it. Where a duty manager starts. |
| **Escalated** | Live and past its escalation clock. |
| **Resolved** | Resolved, closed or dismissed. |

You see exceptions owned by or found at your branches, plus anything assigned to you personally. Columns: Exception, What is wrong, Kind, LR, Owner branch, Assigned to, Age, Status.

Empty is not necessarily good news, and the screen says so: "No open exception in your branches. That is either a good shift or a scanner that has not run."

### The kinds you will actually see in a branch

| Kind | Default owner | Escalates after |
| --- | --- | --- |
| SLA at risk | Origin branch manager | 30 minutes |
| SLA breached | Operations manager | 2 hours |
| Short received | Dispatching branch | 1 day |
| Excess received | Dispatching branch | 1 day |
| Delivery failed | Destination branch | 4 hours |
| Idle at hub | Hub in-charge | 12 hours |
| POD pending | Destination branch | 2 days |
| COD shortfall | Branch accounts | 8 hours |
| Customer complaint | Customer support | 4 hours |
| Route deviation / Vehicle stopped / No GPS update | Transport desk | 30 min – 2 hours |
| Document expired | Transport desk | 1 day |

The escalation clock runs from **detection**, not from the last thing that happened. When it fires, a line goes on the thread: "Escalated to level 2 — OPS_MANAGER. Nobody had acted after 4 hours."

### Working one

Open it. The left column is **What has been done** — the thread. The right rail has **This exception** (opened, age, owner branch, found at, assigned to, escalates) and **The consignment** (lane, consignee, SLA, due, against promise, inferred cause).

Assign it with the **Owner** select and **Assign** — that also acknowledges it. Clearing the owner puts it back to Open.

Then the buttons, which change with the status:

| Button | Needs | Note required |
| --- | --- | --- |
| Acknowledge — "You have seen it and it is yours." | `exception.assign` | no |
| Start work — "Something is being done about it right now." | `exception.assign` | no |
| Resolve — "Say what was done. This is what the next person reads." | `exception.resolve` | **yes** |
| Dismiss — "Not a real problem. Say why, so the detector can be fixed." | `exception.resolve` | **yes** |
| Close — "Signed off. No further action." | `exception.resolve` | no |
| Reopen — "It came back, or the fix did not hold." | `exception.resolve` | **yes** |

The note box is blunt about why: "Nothing closes without this. The next person to see this consignment reads your note, not the status." It must be at least five characters, or:

> A resolution note is required. Write what was actually done — the next person reads this, not the status.

Other refusals: "That exception belongs to another branch and is not assigned to you.", "An exception cannot go from closed to acknowledged.", "You cannot resolve this." (you lack the permission).

You can also add a plain note without changing the status — **Add to the thread**. Empty gets "Say something."

---

## 11. Complaints

**Customer care → Complaints.** "Every complaint carries two clocks: how long the customer waited to hear from a person, and how long they waited for an answer. Nothing closes without a resolution note."

Unlike exceptions, you do log these by hand: **Log complaint**, needs `complaint.create` — branch managers and customer support.

| Field | Notes |
| --- | --- |
| **Category** | Delay, Damage, Missing, Wrong delivery, Billing, POD issue, Pickup issue, Behaviour, Other |
| **Priority** | Low, Normal, High, Critical |
| **LR number** | Optional, typed. "Optional — links the complaint to the consignment and routes it to the delivering branch." |
| **Subject** | e.g. "Consignment two days late, customer chasing" |
| **What happened** | "In the customer's words, with anything they have already been told." |
| **Owner** | "Leave blank to open it unassigned for the duty manager to route." |

As you pick the category and priority the dialog shows the clock you are starting: "Respond within 4h, resolve within 48h." Both clocks start the moment you save, and they are wall-clock, not working hours.

The thread has two buttons and the difference matters: **Internal note** is not visible to the customer, **Reply to customer** is, and it is what stops the response clock. Messages are badged **Internal** or **Customer sees this**.

Refusals: "Say what this is about" (subject under five characters), "Describe what happened" (under ten), "No consignment with that LR number.", "That complaint belongs to another branch.", "Resolve needs a note explaining it.", "Choose who owns this complaint."

Reopening keeps the original deadlines on purpose — "The customer came back. The original SLA stands."

---

## 12. Delivery runs and COD day end

### Building a run

**Delivery → Delivery runs.** "One agent, one day, an ordered list of doors. The COD total on each run is what that agent is accountable for at day end." The screen shows one date at a time, with arrows either side, and a badge counting what is waiting: "23 awaiting delivery at your branches".

**New run** (needs `delivery.assign`): **Branch**, **Agent**, **Vehicle** — "Optional — many runs go out on foot or on a two-wheeler that is not on the fleet" — and **Date**. One open run per agent per day; a second is refused with "*Sohan Lal* already has run *RUN-JAI-260902-01* open for that date. Add the stops to it instead."

Open the run and use **Waiting at HUB-JAI** to add stops. Candidates are consignments received at that branch, not on hold, not already on another run, with the most-attempted first. Tick them; the footer totals the COD the agent will be carrying. Anything skipped is named: "Not added: CL… (on hold), CL… (is out for delivery)."

**Sequence stops** reorders the list with up and down arrows — "The agent works down this list. Put the far end of the area first if the traffic runs that way." There is no route optimiser.

**Remove a stop** (needs `delivery.reassign`) takes it off the run without losing it: "Stop removed. The shipment stays at the branch." It only works while the stop is still pending — "The agent has already started this stop — record the outcome instead."

**Return** (needs `delivery.rto`) sends a consignment back to the sender. The dialog tells you where the attempt allowance stands: "2 of 3 attempts made on the consignee. The allowance is not spent yet; returning early is a decision you own." Pick a reason and add a note — "What the consignor will be told."

Once the run has left, the screen says so: "This run has left the branch. Stops can no longer be added or removed — record the outcome instead."

### What the office cannot do

Everything at the door belongs to the agent's phone. The office cannot mark a stop delivered, record a failed attempt, capture a signature, take the OTP, or collect the cash. There is no office control for any of it. If a delivery genuinely happened and the agent's phone did not record it, that is a status correction by somebody who holds the permission — see [section 13](#13-changing-a-consignment-after-it-is-booked).

The agent also closes the run, and cannot close it while a stop has no outcome: "3 stops have no outcome yet. Every one needs a delivery or a reason."

### COD day end

**Delivery → COD.** "What the agents took at the doors against what has reached the branch."

Per agent, for one branch and one day: **Runs**, **Stops paid**, **Due**, **Collected**, **Deposited**, **Counted**, **Shortfall**. Anybody with a shortfall sorts to the top, and a badge at the top totals it: "₹4,200 outstanding across 2 agents".

Two separate jobs, deliberately held by different people.

**Record deposit** (`cod.deposit` — branch managers) is the cash coming over the counter. **Amount handed over**, **Mode** (Cash, UPI, Transfer, Cheque, Card), **Reference** for anything but cash, and **Remarks**. The form warns live as you type: "₹500 short of what was collected." Recording it covers every one of that agent's outstanding collections at that branch.

> Deposit recorded in full.
> Deposit recorded. ₹500 short of what was collected — an exception has been raised.

**Count** (`cod.reconcile` — accounts, not branch managers) is somebody else counting it. **Amount counted**, **Remarks**. It compares your count against **what was collected at the doors**, not against the slip, and flags either mismatch:

> Counted and reconciled.
> The count is ₹200 under the slip. ₹700 of what was collected at the doors is still outstanding. The deposit is disputed and its collections stay open.

A disputed deposit leaves its collections open until somebody sorts it out. A deposit can only be counted once — "That deposit has already been counted." Nothing to deposit is refused too: "This agent has nothing outstanding to deposit."

The screen's own footer describes the whole chain: "States run COLLECTED → DEPOSITED → RECONCILED → REMITTED. A deposit that counts short stays disputed and its collections stay at DEPOSITED until somebody resolves it. Remittance to the customer runs on their contracted cycle and arrives with billing in Phase 6." **Remittance is not built** — nothing in the product moves a collection to REMITTED.

### Proof of delivery

`/delivery/pod/[shipmentId]`, needs `pod.read`. The signature and photograph the agent captured, the receiver's name and relationship, the attempt number, GPS, OTP reference, the COD box, and every visit made to the address including the ones that failed — "Every visit made to this address is listed, including any that did not result in a handover. This record is append-only."

The only output is your browser's **Print**. There is no PDF download.

---

## 13. Changing a consignment after it is booked

All four live on the consignment itself: **Shipments**, find the LR, open it. The buttons that appear depend on your permissions *and* on where the consignment is — the screen only offers what would actually work.

### Cancel

**Cancel booking**, needs `shipment.cancel` — branch managers, not booking executives.

> The booking is not deleted and the number is not reissued — it stays on the record as cancelled, with this reason against it. Any collection raised for it is called off.

Pick a **Why** from the cancellation reasons — Cancelled by customer, Duplicate booking, Booking error, Destination unserviceable — and optionally add detail.

**You can only cancel before the goods are collected.** *Booked* and *Pickup assigned*, and nothing later. Once a van has taken the boxes:

> The goods are already with us — *picked up*. A consignment in the network is returned to the consignor, not cancelled.

That is not an oversight. Cancelling would put a terminal status on freight physically sitting on a shelf, with nothing owed to anybody to bring it back. Returning the consignor's goods is a return to origin, with its own permission, its own charge and its own delivery — and a Cancel button is not where that decision belongs.

### Hold

**Hold**, needs `shipment.hold` — branch managers.

> The consignment stays exactly where it is and keeps its status. A hold is what stops it being loaded onto the next vehicle.

A hold is not a status. Nothing moves, nothing changes on the timeline except the hold itself; what it does is make dispatch refuse the consignment when somebody tries to manifest it ("On hold") or add it to a delivery run.

Reasons: Hold requested by customer, Credit limit / payment block, Documents pending (e-way bill), Regulatory / legal hold. The example in the box is the commonest use: "Consignor's account is 40 days past terms. Accounts asked for it to be stopped at Delhi."

**Release hold** asks what changed, at least three characters: "The hold was placed for a reason and the record should show why it no longer applies." Example: "Payment received against invoice INV/2026/DEL/0412. Accounts confirmed release."

Refused with "This consignment is already on hold." or "This consignment is not on hold."

### Amend

**Amend**, needs `shipment.update`. What you may change depends on one thing: whether the carrier is holding the goods.

**Before collection** — *Booked* or *Pickup assigned* — the dialog says: "Nothing has been collected yet, so the whole booking is still a piece of paper and every figure on it can be corrected. Changing the weight or the package count reprices the consignment." Everything on the list below is editable.

**After the goods are in the network** — anything from *Picked up* onwards — the dialog says: "The goods are already with us, so only the details that describe people can still be corrected. The count, the weight, the pickup address and the description of the goods are now physical facts — they are revised at the dock, not here."

| Field | Before collection | After |
| --- | --- | --- |
| Both parties' name, company, phone, email, GSTIN | yes | yes |
| Consignee address and landmark | yes | yes — "Correctable right up to dispatch — a consignee who has moved is the commonest amendment there is." |
| Special instructions | yes | yes |
| Packages | yes — "Adding boxes mints new barcodes. Removing takes them off the end, and only while none has been scanned." | no |
| Actual weight | yes — "Reprices the consignment off the rate card." | no — the hub weighs it |
| Pickup address | yes | no — "the van already went there" |
| Goods description | yes | no |
| Service, mode, origin, destination, either city or PIN, payment type, COD amount, freight | **never** | **never** |

That last row is the one people ask about. Those fields decide the lane, the price and the money. Changing one makes it a different consignment, and the honest way to do it is to cancel the booking and take a new one. If the goods are already in the network, that means a return to origin.

A blank box means "leave this alone", not "clear it". Amending nothing gets "Nothing was changed."

Amending is refused entirely after dispatch — the button is not offered.

### Correct status

**Correct status**, needs `shipment.correct_status`. **No seeded operational role holds this** — not a branch manager, not an operations manager. Only Super Admin.

> This moves the consignment to a status nothing that happened would have taken it to. Use it when a scan went onto the wrong LR or a device replayed a stale queue — never to record something that has actually happened, which belongs on its own screen.
>
> The correction is written to the chain of custody as its own entry naming you, both statuses and your explanation, and to the audit trail as an override. Neither can be edited or removed.

You choose the status it should be, a reason (Incorrect scan, System / sync error, Backdated entry) and a written explanation of at least ten characters — "Explain what went wrong". The example is a good model: "Inbound scan at JAI was made against this LR instead of CL20260830-0044. The consignment never left DEL."

Three statuses cannot be asserted by a correction — **Delivered**, **POD uploaded** and **RTO delivered** — because each carries evidence a correction cannot manufacture: a receiver, a signature, a photograph, a COD reconciliation. The refusal reads "*Delivered* is recorded at the door with a receiver and proof. A correction cannot assert it." Correcting *away* from a wrong delivery is allowed, and is exactly what this is for.

### When any of them is refused

A consignment that has reached a terminal status — Closed, Cancelled, Lost, RTO delivered — refuses everything:

> Shipment is *closed* — no further events can be recorded. Use a status correction if this is wrong.

And any of the four is refused for "That consignment is outside your scope." if it has never been near a branch you cover.

---

## 14. Customers, masters and rate cards

### Customers

**Operations → Customers.** "Accounts you book against. GSTIN drives the reverse-charge decision on the consignment note, so it is worth capturing at account level rather than per booking."

Search takes name, code, phone or GSTIN. **New customer** (needs `customer.create` — booking executives have it) opens a dialog whose description explains why it is worth the two minutes: "Saved addresses make booking a two-field job instead of a twelve-field one."

| Field | Notes |
| --- | --- |
| **Account code** | Required. Letters, digits, hyphen and underscore, 2–20 characters. |
| **Type** | Corporate — credit account · Retail — regular walk-up · Walk-in — cash, one off |
| **Trading name** / **Legal name** | "As it should appear on the invoice, if different." |
| **Phone**, **Alternate phone**, **Email** | Phone is ten digits. |
| **Owning branch** | "Decides who can see this account." Left blank it takes your home branch. |
| **GSTIN** | "Needed to decide reverse charge on the consignment note." |
| **PAN**, **Billing address**, **Billing city**, **Billing PIN** | |
| **Payment term** | Cash on booking · Prepaid / advance · Credit account |
| **Credit days**, **Credit limit (₹)** | |
| **Notes**, **Active** | "Inactive accounts cannot be booked against." |

**You cannot set credit terms unless you hold `customer.manage_credit`**, which accounts holds and branch staff do not. The screen says so at the foot of the list: "Credit terms are read-only for your role. Accounts sets limits and payment days — a booking clerk creating an account cannot also grant it credit." If you try:

> Setting credit terms needs the credit permission. Save the customer as Cash and ask accounts to set the limit.

Open a customer to add **saved addresses** — **Label**, **Used for** (Pickup, Delivery or Billing), contact name and phone, address, city, PIN, landmark, and **Default for this purpose**, which is what the booking form picks up. Edits apply from the next booking: "Consignments already raised keep the address they were booked with."

Other refusals: "That branch is outside your scope.", "That customer is outside your scope.", "Another customer already uses that code.", "Leave the owning branch set — an account with no branch is only visible to network-wide roles."

### When credit stops a booking

Credit is checked at booking, before anything is written, for every way in — the counter, bulk upload, the customer portal and the partner API. The refusal you see at the counter is the account's own message, verbatim:

| What you see | What it means |
| --- | --- |
| Account is blocked: *reason* | Somebody has blocked the account. The reason is whatever accounts typed — the credit-terms dialog says "Shown to the booking clerk verbatim." |
| Account is blocked for new bookings. | Blocked with no reason recorded. |
| Oldest invoice is 47 days past due against agreed terms of 30 days. Clear it before booking on credit. | Past terms. |
| This booking takes the account to ₹412,000 against a limit of ₹400,000. It needs a limit increase or a payment. | Over the limit. |

None of these can be overridden from the counter. Book it as a walk-in cash booking if the consignor will pay now, or send them to accounts.

Two warnings, which do not stop a booking: "No credit limit is set on this account, so nothing is being enforced. Accounts should set one." and "Account is at 91% of its ₹400,000 limit. ₹36,000 of headroom is left."

### Masters

**Masters** and **Network** in the menu. All are readable with `master.read` (everybody who works in the office); editing needs `master.manage`, which no seeded operational role holds — it is an administrator's job.

Four of them decide whether a booking works at all:

- **Pincodes** — "The booking screen checks this list as the clerk types, so a PIN missing here cannot be booked to." Each row carries **Serviceable** ("Off blocks booking to this PIN unless the clerk holds the override permission") and **Out of delivery area (ODA)** ("Triggers the ODA charge and a longer transit expectation"). PINs can be imported in bulk from **Network → Pincodes → Import**: download the **Template**, choose the file, **Check the file**, then **Import**. Bad rows are named individually and the rest still import — "Re-importing is safe: a PIN that already exists is updated, not duplicated." A PIN cannot be deactivated; use the Serviceable switch.
- **Service types** — every booking must name one. The volumetric divisor, the transit expectation, the delivery-attempt allowance and whether COD and To-Pay are offered all live here.
- **Charge heads** — the billable lines a consignment can carry. Only heads marked **Show to customer** become invoice lines; "Off means the cost is absorbed internally, not printed on the invoice."
- **Number series** — every numbered document fails without one, with a message naming the screen: "No invoice number series is configured. Set one up under Masters → Number series." **This screen is read-only in this release**: "Changing one mid-year risks re-issuing a number that is already printed on a document."

**Reason codes** are worth knowing because they are what the dialogs elsewhere in this manual offer you. They are grouped by category — Pickup failure, Delivery failure, Exception, Cancellation, Hold, Damage, Shortage / excess, Return to origin, Status correction — and each carries flags that change what the product then demands: **Photo mandatory** ("The field app will not submit without one"), **Remarks mandatory**, **Open an exception**, **Create a re-attempt task**, **Chargeable to the customer**, **Notify consignor**, **Notify consignee**. If a dialog tells you "No cancellation reasons are set up. Add them in masters before a booking can be cancelled", this is the screen.

**Cities**, **Zones** and **Routes** are read-only lists. **Tax rates** are versioned by effective date: "Historical invoices reprice at the rate in force on their date."

**SLA policies** (needs `sla.manage`) set the transit promise per lane. Without one a consignment reads "No SLA" and there is nothing for the on-time reports to measure against.

### Rate cards

**Finance → Rate cards** (`ratecard.read` to look, `ratecard.manage` to change — accounts). "What a customer pays, versioned by effective date so a historical invoice always reprices at what was agreed at the time. A customer card outranks the published tariff on every lane it covers."

A card is a code, a name and optionally a customer — leave the customer blank and it is the published tariff, the fallback for every lane. Under the card are numbered versions, and under each version:

- **Rate slabs**, the base-freight matrix. Every dimension is optional and blank means "any": service, mode, origin and destination city, origin and destination zone, vehicle type, and a weight band. "The most specific matching slab wins: a city pair beats a zone pair beats a blanket rate." Each slab has a basis (per kg, per package, flat, per km, per trip, per vehicle), a rate, a minimum charge and a minimum chargeable weight.
- **Charge rules**, everything that is not base freight — surcharges, handling, ODA, insurance, the COD fee. Each names a charge head, a basis, optional minimum and maximum, and up to four conditions: only when the destination is ODA, only on COD, only when a value is declared, only on fragile consignments. "A rule that does not apply is still recorded on the trace, with the reason."
- The **fuel surcharge** is not on the card. It is one dated rule for the whole company, applied as a percent of base freight to any card that does not price fuel itself — "a dated rule rather than a constant, so a diesel revision is a data change."

**Approving freezes a version.** This is the rule that surprises people:

> Approving freezes this version. Invoices will reference it, and it cannot be edited afterwards — the only way to change a rate is a new version.

After that, every editing control on the version is disabled with the same explanation, and the server refuses too: "This version is approved and cannot be edited — invoices reference it. Create a new version instead."

**New version** copies the slabs and rules forward from whichever version you pick, "so a revision is a handful of edits rather than a retype". Approving a version with no slabs at all is refused: "This version has no rate slabs. Approving it would price every lane as unrated — add at least one before approving."

### Coverage gaps

**Finance → Overview → Coverage gaps** (there is no menu entry; reach it from the finance landing page or the tile on the rate-cards screen).

> Consignments no rate rule matched. They booked with an unrated flag rather than silently at zero, which is the whole point — a lane that prices at nothing looks fine on every screen until the month-end invoice is short.

This is where a booking that went through unpriced ends up, with a column saying why it could not be priced and a panel listing the lanes to fix, most frequent first. Add the missing slab, then **Re-rate** the consignment — "Runs the engine again against today's cards. The original calculation is kept — a second one is stored, and the delta is recorded." A reason is required.

Re-rating something already billed is refused unless you can also raise invoices: "*CL…* is already billed on *INV/2627/DEL/0412*. Re-pricing it now raises a debit note against that invoice, which needs the permission to raise invoices. Nothing was changed."

---

## 15. Invoices and receivables

This is accounts' work. Branch staff can see invoices where they hold `invoice.read`, but generating, approving, cancelling and crediting all belong to the Accounts role.

### Raising an invoice

**Finance → Invoices.** Two buttons, both needing `invoice.create`.

**New invoice** bills one customer for a window: **Customer**, **Billing branch**, **From**, **To**, **Delivered consignments only** (on by default — "Off bills everything booked in the window, delivered or not"), and notes. "Consignments already on a live invoice are excluded automatically."

**Bill run** does the month: "One consolidated invoice per credit account for the window, or one per account per branch. Accounts with nothing billable are skipped, not failed." The **Branch-wise invoices** switch decides which — "One invoice per account per originating branch, rather than one covering the network."

Only **Paid** and **TBB** consignments are billable. COD and To-Pay are excluded by design, which is what the commonest refusal is telling you:

> Nothing billable for that customer in that window — either it is all billed already, or the consignments are COD and To-Pay.

Every line traces back to the consignment it came from and to the stored calculation, and the invoice screen offers a **Why?** link per line that opens it.

### The lifecycle

| Status | What it means |
| --- | --- |
| **Draft** | Raised, not issued. Still editable by cancelling and re-billing. |
| **Issued** | Approved and gone to the customer. |
| **Partially paid** / **Paid** | Money allocated against it. |
| **Credited** | Credit notes have reached the full value. |
| **Cancelled** | Withdrawn before any money arrived. |

**Approve & issue** (`invoice.approve`) asks what you checked, and the wording is deliberate: "Once issued the document has left the building. The only correction after this is a credit note."

It refuses a stale draft, which is the one worth reading in full:

> 2 consignments have been re-rated since this draft was cut: *CL…* (₹1,240 → ₹2,980), *CL…* (₹880 → ₹1,150). Cancel this draft and bill them again — issuing it now would send the customer the old figure, and an issued invoice can only be corrected with a debit note.

**Cancel invoice** (`invoice.cancel`) is only possible while no money has been received: "Money has been received against this invoice. Raise a credit note instead — cancelling would orphan the receipt." Cancelling releases the consignments back into the billable pool.

**Credit note** (`invoice.cancel`) reduces an issued invoice without touching it: "A credit note leaves the invoice exactly as issued. The pair together is the trail." Under reverse charge the tax portion is forced to zero, because no tax was charged. Credits cannot exceed the invoice.

**Debit note** (`invoice.create`) bills what the invoice under-charged — nearly always a revised chargeable weight: "A supplementary invoice for what this one under-billed — a revised chargeable weight, usually. The original is left exactly as issued." It is numbered `DN/…` and is otherwise an invoice in its own right; a reduction is a credit note, not this.

Every one of these asks for a reason, with the same note underneath: "This is written to the audit trail against your name and cannot be edited later."

### Weight revisions and invoices

This is where the hub and accounts meet. If a hub reweighs a consignment that has already been invoiced, three things follow automatically: the consignment is re-priced, a debit note is raised against the issued invoice, and — if the increase is past the 10% tolerance — an exception is opened and the consignor is told before the bill reaches them.

But the reweigh is refused outright unless the person doing it holds `shipment.edit_weight_post_invoice`, and **no seeded role holds it**:

> *CL…* is already billed on *INV/2627/DEL/0412*. Revising the weight now raises a debit note, which needs the post-invoice weight permission.

So in practice, a hub that finds a wrong weight on an invoiced consignment has to go to accounts. Two related messages you may see instead of a debit note: "*INV/…* is still a draft. Regenerate it rather than debiting a document that has not left the building." and "This consignment is not on a live invoice yet — the revised weight will be billed when it is."

### Printing

**Print / PDF** on the invoice gives an A4 preview headed **Tax invoice** or **Debit note**: supplier and recipient, the lines with HSN/SAC, a tax summary split CGST/SGST for an intra-state supply and IGST otherwise, the totals, the amount in words, the declaration and a signature block. A draft prints with a warning that its number is provisional.

One warning to act on rather than ignore: "Neither the billing branch nor the customer carries a GSTIN or a state, so the supply could not be placed. It has been stated as inter-state (IGST). Set the branch GSTIN or the customer's billing city before this is filed."

### Receivables

**Finance → Receivables** (`payment.read`). "Who owes what, and for how long. Money sitting unallocated on an account nets against the ledger, so an account is never chased for a payment already banked."

Tiles: **Total book**, **Overdue**, **90+ days**, **Accounts open**, **Over limit** — the last with the hint "Bookings are blocked". Then an ageing profile and a row per account across the buckets **Not yet due**, **0–30 days**, **31–60**, **61–90**, **90+**.

The screen reads at most 5,000 open invoices in a pass and tells you when it has hit that: "Every figure here covers the 5,000 oldest-due open invoices and is a floor, not the total. Narrow it with the search box, or take the full ageing from a statement."

Open an account for its ledger: the credit banner if it is blocked or near its limit, **Open invoices**, **On account** ("received but not yet applied to an invoice"), and a **Statement of account** covering three months back by default.

**Record payment** (`payment.record`):

| Field | Notes |
| --- | --- |
| **Amount received (₹)** | Required. |
| **TDS deducted (₹)** | "Settles invoice value without arriving as cash." |
| **Mode** | NEFT, RTGS, UPI, Cheque, Cash, Card, Adjustment. |
| **Received on** | Defaults to today. |
| **Reference** | UTR or cheque number. |
| **Apply to** | "Leave on oldest-first unless the customer named an invoice." |
| **Notes** | |

The dialog explains why allocation happens here rather than later: "Applied in the same transaction it is recorded in — a receipt that lands unapplied leaves the customer being chased for money they have already sent." Left on oldest-first it settles open invoices by due date. Anything left over sits **On account** and can be applied later with the **Apply** button — "The receipt is not re-banked — this is the allocation, not a new payment."

Refusals: "₹5,000 is more than the ₹3,200 still open on *INV/…*.", "The allocations come to more than the payment plus its TDS.", "One of the invoices selected is not open on this account.", "*INV/…* is outside your branch scope.", "Only ₹1,800 is left unallocated on *RCT/…*."

**Credit terms** on the same screen (`customer.manage_credit`) sets the limit, the credit days and the block: "The limit is enforced at booking: a consignment that would take the account past it is refused, not warned about." **Block reason** is "Shown to the booking clerk verbatim", and blocking without one is refused — "A blocked account needs a reason on it."

### Settlements

**Finance → Settlements** (`settlement.read`). "Trip earning less advances, less approved expenses, less deductions. Only approved expenses count — paying an unapproved claim and approving it afterwards is how a settlement stops reconciling."

**Prepare** needs `settlement.prepare`; **Approve** needs `settlement.approve`, and the two cannot be the same person: "A settlement cannot be approved by whoever prepared it." A deduction needs an explanation — "Required if you deduct anything — the driver will ask."

---

## 16. Reports

**Control tower → Reports.** The library is open to anyone signed in, but each report needs its own permission, and you only see the ones you can run. If you can run none: "Running reports needs one of the reporting permissions. Ask an administrator for operational, financial or management reporting."

Every report takes the same filter bar — **From**, **To**, **Branch**, **Customer**, **Lane origin**, **Lane destination**, **Service type**, **Mode**, **Search** — then **Apply filters**. The default window is 30 days and the ceiling is 400.

**Operational reports** (`report.operations` — branch managers, dispatch managers, operations managers):

Booking register · Pickup performance · Dispatch & manifest · In-transit status · Delivery & undelivered · Pending POD · Exception register · Hub inbound / outbound & dwell · Vehicle utilisation · Document expiry · Customer-wise shipments · Customer-wise on-time % · Complaint register & ageing

**Financial reports** (`report.financial` — accounts):

Customer billing register · Outstanding & ageing · Revenue by lane · COD collected, pending & remitted · Trip expense register · Vendor payable & reconciliation

**Management reports** (`report.management`): Branch scorecard · Driver scorecard · Delivery agent scorecard, and the **Insights** dashboard.

**Save this view** stores the filters, not the numbers — "Opening it tomorrow runs the report again against whatever the network has done since." You can share a view with the team; anyone who can run that report will see it, still limited to their own branches.

**CSV** and **XLSX** need `report.export` **as well as** the report's own permission. Without it the buttons are replaced by "Exporting needs the bulk export permission." CSV goes up to 100,000 rows; XLSX is capped at 50,000 because the whole workbook is built in memory. Every export is written to the audit trail before any bytes leave, so an abandoned download still shows up.

If your account has no branch: "You have no branch assigned, so this report covers nothing. Ask an administrator."

---

## 17. What a branch manager sees that a booking executive does not

A booking executive holds eleven permissions. A branch manager holds every read permission plus about thirty more. In practice these are the things the counter has to escalate.

| The branch manager can | The booking executive cannot |
| --- | --- |
| **Assign a collection to an executive** (`pickup.assign`) | Raise one, but not send anybody for it |
| **Scan** — inbound, sort, outbound (`scan.*`) | Nothing on the scan console at all, including receiving their own counter drop-offs |
| **Weigh** (`weight.capture`) | — |
| **Close an inbound receipt** and **resolve a discrepancy** (`receipt.close`, `discrepancy.resolve`) | — |
| **Build, add to and close manifests**; **plan trips**, **load** and **gate out** | — |
| **Plan delivery runs** and **move stops between agents** | — |
| **Cancel a booking** and **hold or release** a consignment | Amend, but not cancel and not hold |
| **Work the exception tower** — assign and resolve | Not see it at all |
| **Log and resolve complaints** | — |
| **Record a COD deposit** (`cod.deposit`) | — |
| **Run operational reports** | — |

That is why a branch has to be staffed with a manager and not only a counter: without `scan.inbound` a branch cannot receive its own counter drop-offs, and without `pickup.assign` it cannot send its own van. Neither is in the Booking Executive role, deliberately.

Some things a branch manager also cannot do:

- **Override the rate card** at booking (`shipment.override_rate`) — no seeded operational role holds it.
- **Book to a suspended PIN** (`shipment.override_serviceability`) — operations managers only.
- **Correct a status** (`shipment.correct_status`) — Super Admin only.
- **Revise weight after invoicing** (`shipment.edit_weight_post_invoice`) — nobody, in the seeded roles.
- **Count a COD deposit** (`cod.reconcile`) — accounts only. Handing cash in and counting it are two jobs on purpose.
- **Reopen a manifest** (`manifest.reopen`) — operations managers only.
- **Run financial reports** or touch invoices — accounts.
- **See other branches.** A branch manager is scoped to one branch. A dispatch manager covers an assigned set; an operations manager, accounts and customer support see the whole network.

---

## 18. What is not built yet

Said plainly, so you do not hunt for a control that is not there.

**Damage capture does not exist.** There is a `damage.record` permission, a DAMAGE_RECORDED event, an exception kind called Damaged with its own escalation ladder, and four damage reason codes in the masters. None of it can be reached: nothing in the product writes a damage record, the damaged-package count on an inbound receipt is permanently zero, and no Damaged exception can ever be raised. The Insights loss-and-damage figure says so on its face — "Shortages only — nothing in the product records damage yet." If a box arrives crushed, record it as a receipt remark and log a complaint.

**SMS is switched off, pending DLT registration.** Every SMS template ships inactive. Indian operators will not deliver a transactional SMS until both the sender header and the exact message text are registered on the DLT portal, and they accept an unregistered one and drop it without telling anybody. Registration takes one to three weeks per carrier. Until it comes back, customers hear nothing on SMS — and for a consignor with no email address on file, nothing at all. Trying to activate an unregistered template is refused: "This SMS template has no DLT id. Activating it would send messages the operator drops silently. Save it inactive, register the text on the DLT portal, then switch it on."

Worth knowing alongside it: **no SMS gateway is connected** on a default deployment, and **WhatsApp is a stub**. Email is the only channel that actually delivers. The notification log warns you: a row marked SENT with **simulated** beside it "was rendered, written down and thrown away. Nothing reached a customer."

**Sort bins are not seeded**, and there is no screen to create them. Sorting works; it just records no bin.

**No exception can be raised by hand.** Everything in the tower is machine-detected.

**COD remittance to the customer is not built.** The REMITTED state is described on the COD screen and nothing writes it.

**Delivery runs cannot be cancelled** from the product, though a cancelled state exists.

**There is no route optimiser.** Stop order is a manual up-and-down list.

**A partial COD collection is refused with no way round it** — "Short by ₹X. A part collection needs a branch override" — and no branch-override control exists anywhere.

**The vendor payable report returns nothing**, by design: "Available once billing is live." **Revenue by lane** shows booked value only.

**Proof of delivery has no PDF.** Browser print is the only output.

**GPS is simulated** unless a real provider has been attached; the tracking map says "Running on simulated positions" when it is.

**Hub dwell, POD-pending and COD thresholds have no settings screen.** They are configuration values an administrator edits in the database.

**Four master screens are read-only in this release** — Number series, Cities, Zones and Routes. Each says so on the screen and gives the reason. Number series in particular: "Changing one mid-year risks re-issuing a number that is already printed on a document."

**A rate-card version cannot be un-approved.** The only route back from a frozen version is a new one.

**A PIN code cannot be deactivated.** Use the Serviceable switch on the row instead.

**Coverage gaps and Profitability are not in the menu.** Reach them from **Finance → Overview**.

**Some help text on screen still names build phases** — "Enforced at booking from Phase 6" on the customer credit limit, for example, which is in fact enforced today. Read those as leftovers, not as statements about what works.

---

## 19. Reference: who may do what

The thirteen roles the product ships with. Your company may have renamed these or added its own; **Administration → Roles & permissions** shows what yours actually hold.

| Role | What they do | Sees |
| --- | --- | --- |
| Super Admin | Unrestricted access across the network. | Whole network |
| Management | Read-only visibility of the whole network, plus dashboards. | Whole network |
| Operations Manager | Runs network operations end to end, excluding finance. | Whole network |
| Branch Manager | Full operational control of one branch. | Their branch |
| Booking Executive | Takes bookings at the counter. | Their branch |
| Hub Operator | Receives, sorts, and loads at the dock. | Their branch |
| Dispatch Manager | Builds manifests and trips, and sends vehicles out. | Assigned branches |
| Transport Desk | Owns the fleet, drivers, and vehicle documents. | Whole network |
| Pickup Executive | Field collection. Sees only their own tasks. | Own records only |
| Delivery Agent | Last-mile delivery. Sees only their own run. | Own records only |
| Driver | Line-haul driving. Sees their own trips. | Own records only |
| Accounts | Billing, receivables, settlements. | Whole network |
| Customer Support | Answers customers; can correct addresses, not money. | Whole network |

A role bundles permissions; its scope decides how far those permissions reach. Both are checked on the server, so a missing menu entry is a convenience rather than the boundary — the screen behind it refuses too.

### Where each job is done

| The job | The screen |
| --- | --- |
| Book a consignment at the counter | `/shipments/new` |
| Find an LR and read everything that has happened to it | `/shipments` |
| Load a day's bookings from a spreadsheet | `/shipments/bulk` |
| Raise a pickup against a customer's address | `/pickups` |
| Receive freight arriving at the dock | `/hub/scan` |
| Weigh a consignment and correct the charge | `/hub/weigh` |
| Reconcile an arriving manifest | `/hub/inbound` |
| Build tonight's manifest for a lane | `/dispatch/manifests` |
| Send a vehicle out and record the gate-out | `/dispatch/trips` |
| Plan a delivery run for a rider | `/delivery/runs` |
| Reconcile the cash a rider brought back | `/delivery/cod` |
| See where the vehicles are right now | `/tracking` |
| Work what is late or stuck | `/exceptions` |
| Answer a customer's complaint | `/complaints` |
| Run the day's operational numbers | `/reports` |
| Raise an invoice, or chase what is owed | `/finance/invoices` |
| Check who changed what, and when | `/admin/audit` |

### If you are still stuck

Start with your branch manager. Most of what goes wrong is a permission or a master that has not been set up, and both are fixed inside the product. Anything refused because it is not on your plan can only be changed by whoever manages your company's subscription.

**Help → How this works** is open to everybody and lists every status, what puts a consignment there, and what the customer is told instead.
