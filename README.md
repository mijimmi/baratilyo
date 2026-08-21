# Baratilyo

A browser extension that watches Facebook Marketplace with you and points out
the listings that are priced way below what everything else is going for.

*Baratilyo* — a bargain sale. Which is what you're hoping to find.

![status](https://img.shields.io/badge/status-working%20draft-green) ![browser](https://img.shields.io/badge/browser-Firefox%20%2F%20Zen-orange)

---

## What it does

You scroll Marketplace like you always do. In the background, Baratilyo quietly
notes what everything costs. Once it has seen enough of a given item, it knows
roughly what that item goes for — and it starts putting a little green badge on
anything priced well below that.

It also watches for three things that separate a real find from a waste of time:

- **Price drops.** If a seller quietly lowered their price since you last saw the
  listing, that shows up. Facebook doesn't tell you this.
- **How fresh it is.** A great deal posted 20 minutes ago is worth chasing. The
  same deal from five days ago is still sitting there for a reason.
- **How old the seller's account is.** Brand new accounts posting suspiciously
  cheap electronics are the oldest trick in the book. Baratilyo checks the
  seller's join year and hides anything from an account newer than 2021.

Everything stays on your computer. Nothing is uploaded anywhere, there's no
account to make, and it never posts, messages, or clicks anything for you.

## Install it

**Try it out** (takes a minute, disappears when you restart the browser)

1. Download `baratilyo.xpi` from the [Releases](../../releases) page — or zip up
   this folder yourself.
2. In Zen or Firefox, go to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on…** and pick the file.
4. Pin the icon to your toolbar from the puzzle-piece menu.

**Keep it for good** (Zen won't hold on to unsigned extensions)

1. Upload the same file to [addons.mozilla.org](https://addons.mozilla.org/developers/addon/submit/)
2. Choose **On your own** so it stays private — it won't be listed publicly.
3. Download the signed file they hand back, then go to `about:addons` → gear icon
   → **Install Add-on From File**.

## Using it

**Day one it knows nothing.** It has no idea what a used MacBook costs until it
has seen a bunch of them. So the first while, just browse normally — search
results pages teach it fastest, about 24 listings per scroll.

Click the icon to check on it. The line at the top counts what it has learned so
far. Once that number is climbing, it's working.

**The badges on listings:**

| | |
|---|---|
| 🟩 bright green | well below the going rate — look at this one |
| 🟢 pale green | somewhat below the going rate |
| 🟧 orange | cheap, but the seller's account is new — careful |
| ⬜ grey | priced about normal |

The number on the badge is how far below normal it is, plus an overall score out
of 100. Hover over it to see why it got that score.

**The popup** ranks everything it has flagged recently, newest and best first.
Click any of them to open the listing.

**Notifications** pop up when something scores really well, so you don't have to
sit there refreshing.

## Settings

Click the icon, then **Settings** at the bottom.

| Setting | What it means |
|---|---|
| Min discount | How far below normal a price has to be before it counts as a deal. Default 20%. |
| Min comps | How many similar listings it needs to see before it trusts its own sense of the price. Default 6. Drop it to 3 if you're impatient — you'll get more results and more false alarms. |
| Seller account from | The cutoff year for seller accounts. Default 2021 or older. |
| Seller age rule | *Hide new accounts* skips sellers it has confirmed are new. *Require verified old* is much stricter and quieter. *Ignore* turns the whole check off. |
| Alerts at score | How good something has to be before it interrupts you. 60 is a solid find; 75+ is drop-what-you're-doing. |
| Keep history for | How long it remembers old listings when working out normal prices. |
| Seconds between seller lookups | Leave this alone. See the note at the bottom. |

## If something seems off

**The counter is stuck at zero.** Facebook changed something on their end. This
is the expected failure and it's a small fix — see
[docs/how-it-works.md](docs/how-it-works.md).

**No deals showing up.** Usually just means it hasn't seen enough similar items
yet. Lower *Min comps* to 3 and browse a bit more.

**Seller years never fill in.** The listings count climbs but the sellers count
stays at zero. Also covered in the doc above.

## A couple of honest notes

Facebook's terms don't love automated tools. Baratilyo only reads what your own
browsing already loads, at human speed, and keeps it on your machine — but the
seller-age check does make a few extra requests. It's set to one every 14
seconds for a reason. Turning that down to one per second turns this into
something that gets accounts flagged.

It's also not an oracle. It compares prices against other listings, so if an
entire category is overpriced on Marketplace, it'll happily tell you the least
overpriced one is a steal. Still look at the photos and ask the questions.

---

Curious how it actually works under the hood? → [docs/how-it-works.md](docs/how-it-works.md)
