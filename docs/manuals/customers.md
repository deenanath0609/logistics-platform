# Tracking and booking your freight

A guide for customers

---

There are two ways to use this system, and most people only ever need the first.

If someone has sent you a tracking link, or given you a consignment number, you need no account at all. Open the link and you will see where the goods are. **Part one** covers that, and it is the larger half of this guide, because it is what most readers came for.

If your company has an account with us, you also have a portal: a place to book consignments, ask for collections, download proofs of delivery, look at invoices and raise a complaint. **Part two** covers that.

Throughout, the web address used in examples is `https://city-logistics.lms.credohrms.com`. Your carrier's address will be their own — the one on your paperwork or in the email that invited you. Everything else works exactly as described.

---

# Part one — Following a consignment

## The tracking page

Go to `/track` and enter a consignment number. No sign-in, no account, no app.

The field is labelled **Consignment number** and accepts two things:

- the **LR number** — the number printed on the consignment note, the one everybody on both sides uses to refer to this shipment; or
- **your own reference** — the order or docket number you gave us when the consignment was booked, if you gave one.

Press **Track**.

If someone sent you a link that already contains a number — something ending `/track/` and then the LR number — the page opens straight onto that consignment. You can bookmark it, forward it, or paste it into an email to a customer of your own. It is a plain web page and it will keep working. Tracking links are deliberately kept out of search engines, so the only people who see one are the people you send it to.

> [SCREENSHOT: /track/<an LR number that has been delivered> — one consignment card with its status pill, the packages/booked/delivered facts, and the full milestone timeline beneath, not signed in]

## What the page shows you

**A heading line with the journey.** The city it came from, an arrow, the city it is going to. Beneath it, the LR number.

**Your own reference**, echoed back, if one was recorded against the consignment. This is what makes checking several at once readable.

**A status label** in a coloured pill. Grey means it has not started moving yet, blue that it is on its way, green that it has been delivered, red that something has gone differently — a return to sender, or a cancellation. The words themselves are explained in the table below.

**Three or four facts**: how many packages, the date it was booked, and then either the date and time it was delivered or the date it is expected. If neither has been set, that line is simply absent.

**A timeline**, newest at the top. Each line carries what happened, the date and time it happened, and — where the step took place somewhere with a name worth telling you — a city. The most recent line is the bold one at the top.

If nothing has been recorded yet, the timeline says so: *Nothing has been recorded against this consignment yet.* That is normal in the first hour or so after a booking, before anyone has physically touched the goods.

## Checking several at once

Separate the numbers with commas, spaces or line breaks. A column pasted straight out of a spreadsheet works. **Up to ten at a time.**

You get one card per consignment. Any numbers that matched nothing are listed together at the top, so a typo is visible rather than silently dropped. Each card carries a **Shareable link** you can copy for that one consignment.

## When nothing comes back

**"Nothing found."** Check the number and try again. If the consignment was booked in the last few minutes it may not be searchable yet.

This is also the answer you get for a real consignment that belongs to somebody else. The page cannot tell you which of the two happened, and that is deliberate: if it distinguished them, anyone could use it to work out which numbers are real. Nothing is wrong with your link — you are simply not the party it belongs to.

**"Too many lookups."** Tracking allows a generous number of searches a minute from any one place, which is plenty for a person and useless to a script. The message tells you how many seconds to wait. It is not a fault, and nothing is blocked afterwards.

## What each status means

These are the only status words tracking ever uses. Several steps inside our network share a single word on purpose — sorting, loading and each leg of a road journey all read as **In transit** — because the distinctions between them are ours to worry about and not yours.

| Status | What has actually happened | What to expect next |
|---|---|---|
| **Booked** | We have the consignment on paper and an LR number against it. Nothing has been collected. | Either a collection, or you bringing it to the counter yourself. |
| **Pickup scheduled** | Someone has been given the address and is coming for it. | Collection, usually within the slot that was asked for. |
| **Picked up** | It is in our hands and on its way to the branch it will travel from. | It reaches that branch and enters the network. |
| **In transit** | It is moving through the network. Sorting, loading and each leg of the road journey all show as this. | The next line you see is usually a new city. A consignment can sit on this for a whole night while a lorry runs between two cities — that is not a problem. |
| **Dispatched** | It has left on a vehicle for the next leg. | In transit, then arrival. |
| **Reached destination city** | It has arrived in the delivery city and is waiting to be put on a delivery run. | It joins a rider's list, usually the same day or the next working one. |
| **Out for delivery soon** | It is on a rider's list for a run that has not started yet. | Out for delivery. |
| **Out for delivery** | A rider has it and is on the way to the consignee. | Delivered, or a delivery attempt. |
| **Delivered** | Handed over and signed for. | The proof of delivery appears against the consignment shortly afterwards. |
| **Being returned to sender** | Delivery could not be completed, so it is coming back to you. | It travels back and is returned. If nobody has told you why, raise a complaint or telephone us. |
| **Returned to sender** | It is back with you rather than with the consignee. | Nothing further. |
| **Cancelled** | The booking was cancelled before anything moved. Nothing was collected. | Nothing further. Nothing is charged for carriage. |

Two more lines can appear in the timeline. They are records of something that happened, not statuses the consignment settles on:

| Timeline entry | What it means |
|---|---|
| **Pickup attempted** | Somebody went for it and came away without it. The consignment is still owed a collection and stays scheduled. |
| **Delivery attempted** | The rider reached the address and could not hand it over. The goods go back to the delivery branch and the consignment reads **Reached destination city** again, ready for another attempt. |

Neither line says *why*. If you need the reason, ask — through a complaint in the portal, or by telephone.

Very occasionally a consignment reads **In progress**. That is the page's way of saying the situation does not have a customer-facing word for it. It is not a status you should have to interpret; treat it as a prompt to speak to a person.

## What tracking deliberately does not show

Tracking gives you milestones, dates and city names. It does not give you:

- the name or code of any depot, hub or branch;
- vehicle or lorry numbers, or the name of any driver, rider or member of staff;
- freight charges, COD amounts, declared values or anything else about money;
- the consignor's or consignee's telephone numbers, addresses or email;
- internal notes, or the reason behind a failed attempt.

Some of that is commercial and some of it is other people's personal information. All of it is left off on purpose, including for the person who booked the consignment. If you have an account, your own commercial detail — weights, charges, references, proof of delivery — is in the portal, where you have signed in and we know who you are.

## Sending a tracking link to someone else

This is the intended way to keep a consignee informed. Copy the shareable link from the card, or build it yourself: the address of the tracking page, then the LR number.

**Your consignee cannot be given a portal login.** Only the party who booked the consignment and holds the account with us can sign in, because they are the only party we have verified. Everyone else follows the consignment by its number on the public page — which is why that page exists, and why it shows what it does.

---

# Part two — The customer portal

Everything in this part assumes your company has an account with us and you have been given a login. If you have not, the person who owns your account can create one for you, or we can.

## Signing in

Go to `/portal`. The page is headed **Customer sign in** and asks for the email address your account was set up on, and a password.

On the demo system used for training, three logins exist:

| Email | Account | Role |
|---|---|---|
| `priya@acme.test` | Acme Industries | Owner |
| `vikram@acme.test` | Acme Industries | Member |
| `anil@bharattex.test` | Bharat Textiles | Owner |

All three use the password `Portal@123`. These are demonstration accounts only; your own carrier's portal will have your company's real logins.

**The first time you sign in**, if your login was created by somebody else, you will be asked to replace the password you were given before you can go anywhere else. The new one needs at least ten characters, with a letter and a digit in it. The temporary password stops working the moment you do this, which is the point of it.

**If the details do not match**, you are told so, and told that after five failed attempts the login locks itself for fifteen minutes. Trying repeatedly from the same place will also slow you down for a few minutes regardless of whether the password was right. Both are there to stop somebody else guessing at your login.

**There is no "forgot password" link.** If you cannot get in: whoever owns your company's account can reset your password from the **People** screen and read the new one to you. If you *are* the account owner, telephone us and we will reset it. This is a deliberate choice — an emailed reset link is the commonest way an account gets taken over.

You can change your own password at any time from **Change password**, at the bottom of the menu.

## Finding your way around

Down the left-hand side, or across the top on a phone, you will find:

**Overview** · **Shipments** · **Book a shipment** · **Bulk upload** · **Pickups** · **Saved addresses** · **Invoices** · **Complaints** · **People** · **Help**

Above the menu is your company's name and account code, and the role your login holds. Not everyone sees all ten entries — **Book a shipment** and **Bulk upload** are hidden from read-only logins, and **People** is only for the account owner. **Help** is always there, for everyone.

Everything you see anywhere in the portal is your own account's traffic. There is no view of anybody else's, and no setting that would produce one.

## The overview

> [SCREENSHOT: /portal — the four tiles across the top and the "Latest shipments" table beneath, signed in as priya@acme.test]

Four numbers across the top:

**In flight** — everything booked and not yet finished, from a consignment still awaiting collection right through to one out for delivery. Click it and the shipment list opens filtered to exactly those.

**Delivered this month** — signed for since the 1st. This one is not clickable, because the shipment list has no month filter and a link would open a longer list than the number promised.

**Pending POD** — delivered, but the signed proof has not yet come back off the delivery device and been attached. It normally clears itself within hours. If a number sits here for days, that is worth a complaint.

**Outstanding** — what your account owes right now. Click it for the invoices. If it reads **Coming soon**, billing has not yet been switched on for your account; we would rather say that than show you a balance of zero we cannot stand behind.

Beneath the tiles, a line appears if you have open pickup requests or open complaints, with a link to each. Then your five most recent consignments, and a link to all of them.

## Saved addresses

Worth doing before anything else, because booking and collection both pick from this list rather than asking you to type an address.

**Saved addresses** holds your own collection and delivery points. Each one has:

- a name you choose — *Head office*, *Plant 2*, *Warehouse* — which is all anybody sees in the pickers;
- what it is used for: **Pickup**, **Delivery** or **Billing**;
- a contact name and a ten-digit telephone number, both optional;
- the address itself, a city, a six-digit PIN code and an optional landmark;
- a **Use this one by default** switch. One default per kind, so the booking form never has to guess.

Only **Pickup** and **Billing** addresses are offered as collection points on the booking and pickup forms.

Removing an address takes it out of the lists but does not erase it. Consignments and collections you have already raised keep the address they were raised against, which is what you want when you look at them a year later.

Read-only logins can see the address book but not change it.

## Booking one consignment

**Book a shipment** is one form, in four parts. It is headed with your account name, and a note that the collection address is one of your own and not something the form lets you change — bookings are always made as you.

**Collect from.** Choose one of your saved addresses; the full address, contact and telephone number appear underneath so you can check it is the right one. Choose a **Service** — the options are the products your carrier offers, each showing its mode. Then a switch, **Send someone to collect it**, which is on by default. Turn it off if you are bringing the consignment to the counter yourself.

**Deliver to.** Consignee name, company, a ten-digit telephone number, email, address, city, six-digit PIN code, landmark and the consignee's GSTIN. Name, telephone, address, city and PIN are required; the rest are not. The telephone number matters more than it looks — it is the number the delivery rider calls.

**Goods.** How many packages, what kind of package, and the actual gross weight in kilograms. Then a description of what is inside, which is printed on the consignment note, an optional declared value, and any special instructions. A **Fragile** switch flags it for handling.

Note the weight. We re-weigh at the hub, and that figure is the one that bills. Yours is what we plan around.

**Payment and references.** Choose **Paid** (you pay), **To-Pay** (the consignee pays) or **COD** (we collect from the consignee on delivery and pass it on). The last two only appear when the service you chose allows them. Choosing COD adds a field for the amount to collect. Then your own reference, an invoice number and an invoice value if you have them.

Your reference is worth filling in. It is shown back to you on the shipment list, on the tracking page, and on the invoice — and it works in the tracking box as an alternative to the LR number.

Press **Book consignment** and you land on the new consignment with its LR number at the top. That number is how everybody refers to it from then on.

**Freight is not priced here.** The **Freight** line on a new consignment reads *Not yet priced*. Rating happens against your rate card after booking, and the figure appears on the consignment and then on the invoice. The form has no charges section at all, which is intentional — nothing you type could set a price.

**Which of our branches handles the consignment is not something you choose.** It follows from the two PIN codes. There is no branch field on the form.

## Booking many from a file

For anything above a handful, use **Bulk upload** instead. The principle: upload the file, see exactly which cells we could not accept, correct them in place, then confirm. Valid rows book and the rest wait for you — **a file with seven bad rows still books the other hundred and ninety-three.**

### The file

CSV or XLSX, up to **5 MB** and up to **5,000 rows** in one file. A file saved straight out of Excel is fine — byte-order marks, smart quotes and semicolons are all handled.

**Download the template** from the upload box. It is generated from the same column definitions the checker reads, so it cannot drift out of date.

Headers are matched loosely. Case, spacing and punctuation are ignored, and common alternatives are accepted — *PCS* for Packages, *Gross Weight* for Actual Weight, *Delivery Pincode* for Consignee PIN, and many more.

**There is no account column.** Everything in the file books under your account, taken from your login. If your own export includes a column called *Customer Code*, *Bill To*, *Consignor Account* or anything similar, it is ignored, and the upload screen tells you it was ignored rather than leaving you to assume it was honoured.

### What the file may contain

| Column | Needed? | What goes in it |
|---|---|---|
| Service Code | Required | The service type code. The mode follows from it. |
| Origin Branch | **We fill this in** | Leave it blank. Worked out from the collection PIN code. |
| Destination Branch | **We fill this in** | Leave it blank. Worked out from the delivery PIN code. |
| Consignor Name | Required | Who is sending the goods. |
| Consignor Company | Optional | Legal name, if different from the contact. |
| Consignor Phone | Required | Ten digits, no country code. |
| Consignor Email | Optional | |
| Consignor Address | Required | Street address for collection. |
| Consignor PIN | Required | Six digits. The city is taken from it. |
| Consignor GSTIN | Optional | Needed on the consignment note for a GTA supply. |
| Consignee Name | Required | Who receives the goods. |
| Consignee Company | Optional | |
| Consignee Phone | Required | Ten digits. This is the number the delivery agent calls. |
| Consignee Email | Optional | |
| Consignee Address | Required | Street address for delivery. |
| Consignee PIN | Required | Six digits, checked against where we deliver. |
| Consignee Landmark | Optional | |
| Consignee GSTIN | Optional | |
| Packages | Required | Number of physical pieces. Each gets its own barcode. |
| Actual Weight (kg) | Required | Gross weight in kilograms. |
| Length (cm) | Optional | Per piece. Drives volumetric weight. |
| Breadth (cm) | Optional | Per piece. |
| Height (cm) | Optional | Per piece. |
| Declared Value | Optional | Sets the insurance and claim ceiling. |
| Goods Description | Required | What is inside. Printed on the consignment note. |
| Special Instructions | Optional | |
| Fragile | Optional | Yes or No. |
| Payment Type | Required | PAID, TO_PAY, TBB or COD. |
| COD Amount | Optional | Required when Payment Type is COD, and only then. |
| Customer Reference | Optional | Your own order number. Must be unique across all your consignments. |
| E-Way Bill | Optional | Twelve digits, where the consignment needs one. |
| Invoice Number | Optional | |
| Invoice Value | Optional | |
| Pickup Required | Optional | Yes or No. Defaults to Yes. |

The two branch columns are in the template because the same template serves our own counters. You do not need to know our network, so you do not have to fill them in, and anything you do put there is replaced.

### What happens to rows that fail

> [SCREENSHOT: /portal/bulk/<a batch with a mix of booked and failed rows> — the four tallies, the "Why rows were held back" chips, and the grid with red cells, signed in as priya@acme.test]

When the file has been read you land on a page showing your file back to you, exactly as you sent it, with our reasons written against the cells we could not accept.

Four counts across the top: **Rows**, **Ready**, **Booked** and **To fix**.

Under them, **Why rows were held back** — the commonest reasons with a count against each, so a large file has a headline rather than making you read every row.

Then the grid. Bad cells are marked with the reason. Correct them in place and save the row; it is re-checked immediately and either goes green or tells you what is still wrong. **Re-check** at the top runs every row again, which is useful after a run of corrections.

**Book N ready rows** books exactly what the button says — the rows currently valid, and no others. The ones still to fix stay where they are and lose nothing. You can come back, correct them, and book them later from the same page. Pressing the button twice is harmless: rows already booked are recognised and not repeated.

When it finishes you get a count, the new LR numbers as links, and any row that failed at the last moment with its reason.

Your files stay listed under **Bulk upload** with their status — *Uploaded*, *Checked*, *Part booked*, *Booked* — as a record of what you asked for. There is no way to delete one, and there does not need to be.

Read-only logins can open a file and read it but cannot correct it, re-check it, or book from it.

## Asking for a collection

**Pickups** is for saying *come and get something*, whether or not you have booked the consignment yet. You do not need to know what you are shipping when you raise one.

Choose which saved address to collect from, a date (today or later), and a slot — **Any time**, **Morning**, **Afternoon** or **Evening**. Then, optionally, roughly how many packages and roughly what they weigh, what we are collecting, and anything the executive should know: gate numbers, security procedures, who to ask for. That last box saves more wasted journeys than anything else on the form.

You get a pickup number back. The table beneath lists your requests with their number, the date wanted, the slot, where from, the approximate package count and a status:

| Status | Meaning |
|---|---|
| **Requested** | Raised, not yet given to anybody. |
| **Assigned** | Somebody has been given it. |
| **In progress** | They are on their way, or at your door. |
| **Completed** | Collected. |
| **Failed** | Attempted and not collected. |
| **Cancelled** | Called off. |

**Cancel** appears on a request while it is still *Requested* or *Assigned*, and the cancellation reaches the person who was going to collect. Once a collection is *In progress* the button is gone and you get: *That collection is already under way. Please call your branch to stop it.* A collection that has already been made cannot be undone.

If you ask to collect from a PIN code we do not serve, the request is refused at the point you raise it, with that reason.

Booking a consignment with **Send someone to collect it** switched on raises a collection for you; you do not need to raise a second one.

Read-only logins can see the pickup list but cannot raise or cancel anything.

## Following your consignments

> [SCREENSHOT: /portal/shipments — the list with the "With us" chip selected, signed in as priya@acme.test]

**Shipments** lists everything booked under your account, newest first, twenty to a page.

Search by LR number, your own reference or the consignee's name. Filter with the chips:

| Chip | What it holds |
|---|---|
| **All** | Everything. |
| **In flight** | Booked and not yet finished — the four groups below it rolled together. |
| **Awaiting pickup** | Booked, or scheduled for collection, but not yet collected. |
| **With us** | Collected and at a branch of ours: received, sorted, or waiting to be loaded. |
| **In transit** | Dispatched, on the road, or just arrived somewhere. |
| **Last mile** | In the delivery city — waiting for a run, on a run, or out with a rider. |
| **Delivered** | Delivered and closed. |
| **Exceptions** | Returns to sender and cancellations. |

Each row carries the LR number and your reference beneath it, the lane, the consignee, the number of packages, the booking date, the due or delivered date, and the status. A green tick at the end of the row means the proof of delivery is available.

### One consignment

Click the LR number. The page opens with the journey, the number, and what is in it.

The **Progress** timeline is the same one the public tracking page shows, and shows the same things — dates and cities, not the shape of our network. Signing in gets you your own commercial detail, not ours.

Down the right-hand side:

- **Consignee** — name, company, address, city, PIN code.
- **Consignment** — service, mode, packages, chargeable weight, declared value, booking date. The chargeable weight is the one that bills; it is what came off our scales.
- **Payment** — the terms, the amount to collect if it is a COD, and the freight. Freight reads *Not yet priced* until the consignment has been rated. There is a link through to your invoices.
- **Your references** — your reference, invoice number and e-way bill number, where you gave them.

Two buttons at the top: **Proof of delivery**, once there is one, and **Something wrong?**, which starts a complaint with this consignment already attached.

**A booked consignment cannot be edited or cancelled from the portal.** If something needs changing — a wrong address, a consignment that should not go — telephone us, or raise a complaint against it, and do it quickly.

## Proof of delivery

> [SCREENSHOT: /portal/shipments/<a delivered consignment>/pod — the printable proof-of-delivery sheet with the carrier's letterhead, signed in as priya@acme.test]

Once a consignment has been delivered and the proof has synced, **Proof of delivery** opens a single sheet laid out to print onto A4 and staple to an invoice. It carries your carrier's letterhead, not ours, because it is a record of your delivery.

On it: the LR number, who it was delivered to and at what address, your account name and code, **who actually received it**, their relationship to the consignee where the rider recorded one, the date and time, the number of packages, the chargeable weight and the goods description. If the recipient confirmed with a one-time code, the sheet says so.

At the foot, either a note that a signed copy has been generated and will be attached to your invoice, or a note that it is still being prepared — in which case printing this page gives you the same record in the meantime.

**Print / save as PDF** at the top does both. There is no separate download button; your browser's print dialogue offers to save the sheet as a PDF.

The customer copy does not name the individual who delivered it, or say where their phone was standing. If you need that — for an insurance claim, say — raise a complaint and ask.

## Invoices and what is outstanding

**Invoices** shows three figures and then the invoices themselves.

**Outstanding** — everything owed, with any credits already netted off, and how many invoices are open. If we owe you rather than the reverse, the tile says **In credit**.

**Overdue** — the part past its due date, and how many days the oldest one is late.

**Credits held** — credit notes and payments not yet applied to anything.

Beneath, an **Ageing** row splitting what is owed into *Not yet due*, *0–30 days*, *31–60 days*, *61–90 days* and *90+ days*.

Then each invoice: its status (**Due**, **Part paid**, **Paid**, **Cancelled** or **Credited**), number, total, the date it was raised and the date it falls due, the period it covers, how many consignments are on it, and how much is still owed. A **PDF** link downloads the document as issued. If it says *PDF still being prepared*, the figures are right and the document is still rendering.

Draft invoices are not shown — a draft is a working figure our accounts team is still arguing with, and you should not be paying it. Cancelled and credited invoices *are* shown, so that if you hold a copy of a document we have since withdrawn, you can see that we withdrew it.

**If a figure looks wrong, raise a billing complaint against the invoice rather than asking for it to be edited.** An invoice is a document; it is corrected by a credit note, and that is the trail both sides need.

If the whole page says **Your invoices are not available yet**, billing has not been switched on for your account. Ask us for a statement in the meantime. Proofs of delivery are unaffected and remain available on every delivered consignment.

**Invoices cannot be paid through the portal.** Pay by whatever arrangement you have with us.

## Raising a complaint, and following it

Raise it here rather than telephoning a branch. A complaint raised in the portal lands with the branch responsible, with your consignment attached and a clock running on it.

**Raise a complaint** asks for four things.

**What is it about** — one of nine:

| Category | Use it for |
|---|---|
| Late delivery | It has not arrived when it should have. |
| Damaged goods | It arrived, but not in one piece. |
| Missing consignment | Packages short, or nothing arrived at all. |
| Delivered to the wrong place | Someone else received it. |
| Billing or charges | An invoice, a rate or a COD amount looks wrong. |
| Proof of delivery | The POD is missing, unreadable or disputed. |
| Pickup problem | Nobody came, or came at the wrong time. |
| Staff behaviour | How someone conducted themselves. |
| Something else | Anything the list above does not cover. |

**Which consignment** — optional, but attaching one gets the complaint to the right branch immediately. The list only ever contains your own consignments.

**In one line** — a summary. *Two cartons arrived crushed.*

**What happened** — up to four thousand characters. Dates, package numbers and who you spoke to all help. You can add more later.

There is no urgency selector, and that is on purpose. The category carries the urgency, and it is applied consistently — a missing consignment is answered faster than a billing query, whoever raises it. The **Help** page inside the portal lists the reply and resolution windows for every category as they currently stand.

### Following it

**Complaints** lists everything your account has raised: status, complaint number, category, subject, when it was raised, how long it has been open, the LR number and the message count. A complaint nobody has yet answered is flagged **Awaiting our reply**.

Open one and you get the same facts, what you originally told us, our recorded resolution once there is one, and the conversation.

The conversation is a thread. Your messages and your colleagues' appear on one side, named; ours appear on the other under your carrier's name. Add a reply at any time.

Complaint statuses read: **Open**, **Assigned**, **Investigating**, **Action taken**, **Resolved**, **Closed** and **Reopened**.

**A settled complaint still takes replies.** If it was closed and the problem is not fixed, say so in the thread — that is the most important message in it. A reply does not reopen the complaint by itself; somebody reads it and decides, which means you should expect an answer rather than a silent change of status.

**You cannot attach photographs or documents to a complaint.** The thread is text. If you have pictures of damaged goods, say so in the description and we will tell you where to send them.

Read-only logins can follow complaints but cannot raise one or reply.

## People on your account

> [SCREENSHOT: /portal/users — the invite form open with the role selector and branch-visibility chips, plus the table of existing logins, signed in as priya@acme.test]

Only the account owner sees this screen.

**Invite a colleague** takes their name, email address and optional mobile number, and asks what they may do:

| Role | What they can do |
|---|---|
| **Owner** | Everything a member can, and manages the logins on the account. One per account. |
| **Member** | Books consignments, requests pickups, keeps the address book, uploads files and raises complaints. |
| **Viewer** | Reads consignments, invoices and complaints. Cannot book, cannot request a collection, cannot change an address, cannot raise or reply to a complaint. |

A viewer login is a genuine read-only login. The things it cannot do are hidden from the menu rather than offered and then refused — but if one is reached directly, the answer is a plain sentence saying the login can look but not act, and pointing at the account owner.

You can also narrow what a colleague sees to particular locations, so that someone running one plant sees that plant's traffic rather than the whole group's. The picker only ever offers places that have actually handled your consignments. Leave everything unticked and they see the whole account.

**The password is shown to you once.** When you create a login, a one-time password appears on screen. Read it to your colleague there and then; it is never shown again. They are made to choose their own the first time they sign in.

In the table you can **Disable** a login — which takes effect on their very next click, not at their next sign-in — **Enable** it again, or **Reset** the password, which produces a new one-time password and clears any lockout. You cannot change your own role or reset your own password from here; use **Change password** for that.

The owner's login cannot be altered from this screen, and ownership cannot be handed over here either. That is a conversation with us.

If you are told **no more logins can be added to this account**, ask us to raise the limit.

## Help, inside the portal

The **Help** screen carries a shorter version of this guide, always current: the four steps to sending something, what every status means, the reply and resolution windows for each complaint category as they stand today, what your own role can do, and your carrier's support telephone number and email address where they have published them.

---

# Things this portal deliberately will not do

Worth knowing before you go looking.

**A consignee cannot be given a login.** Only the consignor — the company that booked the consignment and holds the account — can sign in, because they are the party we have verified. Send your consignee the tracking link instead. It is designed for exactly that.

**There is no way to switch off messages from inside the portal.** If you or your consignee are getting texts or emails you do not want, telephone us or raise a complaint; it is not a setting you can change yourself.

**There is no self-service password reset.** No emailed reset link, no security questions. Your account owner resets a colleague's password; we reset an owner's.

**A read-only login may read and not act.** Not "read and occasionally act". If you have one and need to book, ask your account owner to make you a member.

**A booked consignment cannot be edited or cancelled here.** Telephone us.

**A collection already under way cannot be cancelled here.** Telephone us.

**Invoices cannot be paid here**, and figures cannot be edited. A wrong invoice is corrected by a credit note, which starts with a billing complaint.

**Complaints take no attachments.**

**You cannot choose which of our branches handles your freight.** It follows from the PIN codes, on a single booking and on a bulk file alike.

**Freight is not priced at the moment you book.** It is rated against your rate card afterwards.

**Tracking is limited to ten numbers per lookup**, and to a generous but finite number of lookups a minute from any one place.

**Tracking answers "nothing found" for a consignment that is not yours**, exactly as it does for a number that does not exist.

---

## If you are stuck

Raise a complaint against the consignment. It is the fastest route, because it arrives with everything already attached to it and against a clock, rather than as a telephone call somebody has to reconstruct.

For anything that is not about one consignment, your carrier's support telephone number and email address are on the **Help** screen inside the portal, and at the foot of the public tracking page.
