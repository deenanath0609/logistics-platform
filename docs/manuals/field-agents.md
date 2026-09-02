# Field agents — pickup executives and delivery agents

Everything you do on the phone. Four screens, two buttons at each door.

You have one of two jobs, and the app gives you only that job:

| Job | Where your work is |
| --- | --- |
| Pickup executive — collecting from consignors | `/pickups/today` |
| Delivery agent or driver — delivering | `/delivery` |

---

## 1. Signing in

Open **https://city-logistics.lms.credohrms.com** in the phone's browser. Bookmark it or add it to the home screen — there is no app to install.

1. **Mobile number** — your 10-digit number. Example: `9333000005` (Gurugram pickup executive), `9333000006` (Gurugram delivery agent).
2. **Password** — `Admin@123` on a new account. Change it when asked.
3. Tap **Sign in**.

If you have forgotten the password, use the **Mobile OTP** tab instead: type your number, tap **Send code**, then type the 6-digit code and sign in. The code arrives by SMS.

After signing in, go to your own screen: `/pickups/today` if you collect, `/delivery` if you deliver. Sign-in does not always land you there, so keep the bookmark on the right one.

> [SCREENSHOT: /login — the Password and Mobile OTP tabs with the mobile field filled, phone width]

The bar across the top of every screen shows your name, your branch code and your number. If the branch code is wrong, you are on somebody else's login — stop and call the branch.

---

## 2. The coloured bar under your name

It is only there when there is something to say. Read it in one glance.

| The bar says | What it means | What you do |
| --- | --- | --- |
| Nothing — no bar | Everything on this phone has reached the office | Carry on |
| **Offline — N saved on this phone. They will go up on their own.** | No signal. Your work is safe in the phone | Carry on working. Do not redo anything |
| **Sending N…** | Signal is back and the phone is catching up | Nothing. Tap it if you want to push it now |
| **N actions the office rejected. Show this phone to your branch.** | Something could never be accepted — a stop closed at the desk, a reason code withdrawn | Ring the branch, and show them the phone at the end of the run |

The delivery screens save what you tap **on the phone first**, then send it. That is why a stop goes green straight away even in a basement.

---

## 3. Collections — pickup executive

### Your day

`/pickups/today` shows every stop assigned to you, numbered from the top. Today's stops plus anything still open from yesterday. Work down the list.

Each card shows the consignor's name, address and landmark, phone, how many packages are expected and the promised slot. Two labels matter:

- **On the way** — you already tapped "On the way" at this stop.
- **Attempt 2** (or 3) — somebody has been here before. Read the previous visits before you knock.

When there is nothing: *Nothing is assigned to you right now. New collections appear here as soon as the branch assigns them — no need to refresh.*

> [SCREENSHOT: /pickups/today — three numbered stops, one with an "Attempt 2" label, signed in as 9333000005, phone width]

### At the door

Tap the stop. Above the buttons you get the address, a tap-to-call number, packages and weight expected, the slot, the goods description, any note from the branch, and **Previous visits** — what happened last time and why. Read that before the consignor tells you.

Tap **On the way** when you set off. It only records that you are moving; if the tap fails, tap it again.

Then one of two buttons: **Collected** or **Could not collect**.

> [SCREENSHOT: /pickups/task/[id] — the two outcome buttons "Collected" and "Could not collect", signed in as 9333000005, phone width]

### Collected

| Field | Compulsory? |
| --- | --- |
| **Packages collected** | Yes. At least 1. Pre-filled with what was booked |
| **Weight, if you have it (kg)** | No |
| **Handed over by** | No |

Change the package count if it is wrong. *What you enter is what is recorded* — six booked and five handed over is stored as five against six. Do not round it to keep the paperwork tidy; the difference is money and the office has to see it.

Tap **Confirm collection**. You get *Collected — attempt 1.*

### Could not collect

Tap **Could not collect**, pick one reason under **Why not?**, add anything useful under **Anything to add**, tap **Record the visit**.

**The reason is compulsory.** Nothing saves without one. The list comes from your carrier's own masters — things like premises closed, shipment not ready, consignor unreachable, documents not ready, cancelled by consignor. Pick the one that is true; the branch runs tomorrow's round off it.

It is not a cancellation. *This comes back to you on the next working day. The consignor is still owed a collection — it is not closed.*

---

## 4. Deliveries — delivery agent

### Your run

`/delivery` is one run, one list. The top card carries your run number, the branch, how many stops are **left**, and three tallies: **Stops**, **Delivered**, **Attempted**. If there is COD on the run, an amber strip shows **Cash you owe the branch** — what you have taken so far, of what is due.

If there is no run: *Your branch has not built your run for today. Check with the desk before you set off.* Ring the desk; you cannot build your own run.

### Out-scan — do this before you leave

Tap **Start run · N stops** at the branch, once the parcels are loaded. That is the out-scan: the office can then see the parcels are with you. Until you do, every stop carries the line *Scan out at the branch before you set off*.

Tapping it in a loading bay with no signal is fine. It sits on the phone and goes up later, and it does **not** block you from delivering.

> [SCREENSHOT: /delivery — the run card with the "Cash you owe the branch" strip and the "Start run" button, signed in as 9333000006, phone width]

### Reading a stop card

Name, address, landmark, LR number, package count. Then, when they apply:

- **Collect ₹…** in amber — money to take before you hand anything over.
- **attempt 2** — somebody has been before.
- A blue line — the customer's special instructions. Read it.

**Navigate** and **Call** sit under the card, away from the tap target, so you cannot hit them by accident.

### At the door

Open the stop. The panel at the top says **Attempt N of M** and either *First visit.*, *N attempts left.*, or — the one to notice — *This is the last attempt before it goes back to the sender.* If you see that, try harder: ring the number, try the neighbour, try the guard. After this one it goes back to the sender and the customer pays for it.

Two buttons: **Deliver** or **Could not deliver**.

> [SCREENSHOT: /delivery/task/[id] — a COD stop showing "Collect before handing over", the attempt panel, and the two outcome buttons, signed in as 9333000006, phone width]

### Delivering

Tap **Deliver**. The form, top to bottom:

| Part | Compulsory? | Notes |
| --- | --- | --- |
| **Delivery code** (OTP) | No | Tap **Send code**; it goes to the consignee's phone, never yours. Ask them to read it out |
| **Who is receiving it** | Yes | Pre-filled with the consignee's name. Change it if somebody else takes it |
| **Relationship to the consignee** | — | Self, Family member, Neighbour, Security guard, Reception, Colleague, Other |
| **Cash on delivery** | Yes when there is COD | See below |
| **Signature** | One of these two | Sign here with your finger. Tap **Clear** to redo |
| **Delivery photograph** | One of these two | **Take photo** — the parcel at the door, or with the person receiving it |
| **Note** | No | |

**Signature or photograph — you must have one.** Without either you get *Take a signature or a photograph — one of the two is proof.* Take both when the handover is at all unusual: a neighbour, a guard, a parcel left at a reception.

The code is optional and is a second proof, not a replacement. If you send it and then type it wrong you get *That code is not valid* — resend and try again, or leave the code blank and use the signature.

Tap **Mark delivered**. The screen confirms and returns you to the run immediately, whether or not you have signal.

### COD — take it in full

The amber block shows the amount due. **Amount taken** is pre-filled with it. Pick the mode: **Cash**, **UPI**, **Card**, **Cheque**, **Transfer**. Anything except cash needs a **Reference** — the UPI, cheque or transaction number.

**There is no part payment.** Enter less than the full amount and the app refuses: *₹1,750 is due. Collect it in full.* If it reaches the office short, the answer is the same: *Short by ₹250. A part collection needs a branch override.*

If the consignee will not or cannot pay the full amount, do not hand the goods over. Record it as **Could not deliver** with the payment reason and take the parcel back.

### Could not deliver

Tap **Could not deliver** and pick from **What happened**. Each reason carries its own labels, so you can see what it costs before you pick it:

| Label on the reason | What it means for you |
| --- | --- |
| **another visit** | The branch will schedule a fresh attempt |
| **chargeable** | The customer will be charged for the failed visit |
| **photo needed** | You cannot submit this reason without a photograph |

Then:

- **Photo** — compulsory when the reason says so (*This reason cannot be submitted without one.*). Otherwise optional, and worth taking: *it settles arguments later*.
- **Note** — compulsory on some reasons, and asked for on all: *What did you find? Anything the next agent should know.*

Tap **Record attempt**. You get *Attempt recorded. The branch will schedule another visit.* or *Attempt recorded. The branch has been told.*

*This does not cancel the delivery. The parcel comes back to the branch and stays owed — every visit is kept on the record.*

**Bring the parcel back to the branch the same day.** A failed attempt is not a status the parcel sits in; it goes back on the floor.

### What happens after a failed attempt

| Situation | What the office does |
| --- | --- |
| Attempts left, and the reason earns another visit | A fresh stop is raised for the next working day |
| Attempts left, but the reason needs a decision — wrong address, refused, damaged | It is held for the office. Nobody drives back until they say so |
| The attempt allowance is spent | It is proposed for return to the sender. A manager decides, not you |

You cannot send a consignment back yourself, whatever the screen shows. That decision costs the customer money and belongs to somebody holding the authority for it.

### Closing the run

When no stops are left, **Finish run** appears. Tap it: *Run closed. Hand the cash in at the branch.*

It will not close while any stop still has no outcome. The refusal names the number: *2 stops have no outcome yet. Every one needs a delivery or a reason.* Go back and record them.

---

## 5. Handing in the cash

Hand the cash to the branch at day end. The clerk records the handover on their own screen; you do not.

What matters for you personally:

- The shortfall is measured against **what you collected at the doors**, not against what your slip says. Declaring less than you took does not make it go away.
- Any shortfall raises an exception the same day, in your name, and the deposit is marked disputed rather than quietly accepted.
- Your name stays on the branch's day-end list, showing the amount outstanding, until it is settled.

So: hand over every rupee you took, on the day you took it. If a note is genuinely missing, say so to the clerk at the counter rather than letting the screen find it.

---

## 6. When the phone has no signal

**Deliveries.** Keep working. Every **Deliver**, **Could not deliver**, **Start run** and **Finish run** is saved on the phone with its own stamp and the time you actually tapped, and goes up on its own when signal returns. The confirmation you see is real.

**What still needs signal:**

| Action | Why |
| --- | --- |
| Loading a stop you have not opened yet | The screen is fetched fresh each time |
| **Send code** (the delivery OTP) | It has to reach the consignee's phone now |
| Everything on the collections screens | Pickups are not queued — they go straight up |

So: for deliveries, open the stops you need **before** you go into a basement or a lift lobby. For collections, if the tap does nothing, step outside and try again.

### Pressing the button twice

Harmless. Every submission carries its own stamp, and the office ignores the second copy of the same one. On a collection you will see **Already recorded** — that is the app telling you the first tap worked. It is not an error, and it does not mean two collections or two deliveries.

The same goes for a stop that shows as done and then re-appears while the phone catches up. Leave it. Do not record it again.

---

## 7. When the screen refuses you

Every one of these is the app protecting the record. None of them is a fault of yours.

| The message | What happened | What you do now |
| --- | --- | --- |
| **This pickup has been reassigned to somebody else.** | The branch moved it to another executive while you were out | Leave it. It is off your list. Ring the branch if you are already at the door |
| **That pickup belongs to another executive.** / **That pickup is no longer on your list.** | Not your stop | Go back to `/pickups/today` and work the list you have |
| **That pickup is already complete.** | It has an outcome already — yours or the office's | Nothing to do. Move on |
| **Choose a reason** | A failed collection with no reason chosen | Pick one under "Why not?". It will not save without one |
| **Enter how many packages you collected** | The count is blank or zero | Type the real count. At least 1 |
| **No pickup-failure reasons are configured.** | The branch has not set up its reason list | Ring the branch. You cannot record the visit until they do |
| **This stop is already recorded as delivered.** | Somebody closed it — you, earlier, or the desk | Do not deliver again. Ring the branch if the parcel is still in your hand |
| **An outcome has already been recorded for this stop. A correction is a new visit, never an edit.** | The stop was closed with a different outcome | Ring the branch. Nothing on this phone can change it |
| **This stop was taken off your run. Call the branch.** | Cancelled at the desk | Call the branch. Do not hand anything over |
| **This consignment has been sent back to the sender. Call the branch.** | A return was raised while you were out | Call the branch. Bring the parcel back |
| **That stop belongs to another agent.** | Not your run | Go back to `/delivery` |
| **Take a signature or a photograph — one of the two is proof.** | Neither was captured | Get one. There is no way past it |
| **Who received it?** | The receiver's name is blank or too short | Type the name of the person in front of you |
| **₹1,750 is due. Collect it in full.** / **Short by ₹250.** | COD short | Take the full amount, or record it as a failed attempt and bring the parcel back |
| **Enter the transaction reference.** | Non-cash COD with no reference | Type the UPI, cheque or transaction number |
| **This reason needs a photo.** / **This reason needs a note.** | The reason demands evidence | Take the photograph, or write what you found |
| **That code is not valid.** | Wrong, expired, or already used | Resend the code, or leave it blank and use the signature |
| **No failure reasons have been configured. Call the branch.** | The branch has not set up its reason list | Call the branch |
| **N stops have no outcome yet. Every one needs a delivery or a reason.** | Closing the run too early | Go back and record the missing stops |
| **That run is closed.** | The run was closed at the desk | Ring the branch before you do anything else |
| **N actions the office rejected. Show this phone to your branch.** | The office could never accept something on this phone | Show the phone to the branch at the end of the run |

---

## 8. What is not built yet

Say this to a customer plainly rather than promising something the app cannot do.

- **There is no part-collection override for COD.** The message says a part collection needs a branch override; no such override exists anywhere in the system today. Full payment, or no delivery.
- **The collections screens do not work offline.** Only the delivery screens queue on the phone. A pickup recorded with no signal does not go anywhere — you have to be in coverage when you tap.
- **There is no installable app.** It runs in the phone's browser, so a page you have not opened will not load without signal.
- **You cannot send a consignment back to the sender.** Only somebody at the office can.
- **You cannot build, change or re-sequence your own run**, and you cannot assign yourself work. The branch does that.
