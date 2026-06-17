# INT2 Work Journal

---

## 2026-06-17 — Scheduled PM Review

**Sources reviewed:** CRM (Supabase), Granola (last 30 days, 54 meetings), Gmail (sent, last 14 days), Google Calendar (Jun 10–Jun 30).

---

### CRM Updates Made This Run

#### Marked Complete
| Item | Contact | Reason |
|------|---------|--------|
| `744cedce` | Alex Jones / FF | IN2<>FF Jun 16 debrief call happened (Granola: "In2<>FFReconnect") |
| `07d4b7ed` | Alex Jones / FF | Deep Seas readout + follow-up call completed Jun 16 |

#### New Follow-Ups Added
| ID | Contact | Due | Summary |
|----|---------|-----|---------|
| `d4b0826a` | Chaz Gerads / FF | Jun 18 | **URGENT** Send updated Deep Seas proposal: POC $5K + roadmap $10K (confirmed Jun 16, was $2.5–5K range before) |
| `794ec441` | Alex Jones / FF | Jun 18 | Matthew to share MSA + contract docs with FF before kickoff |
| `c3987f73` | Chaz Gerads / FF | Jun 19 | Follow up: confirm Chaz reviewed subcontractor clause + shared 20-hr recordings + data room |
| `cbb43e86` | Chaz Gerads / FF | Jul 1 | Schedule staffing-agent scoping call (~2 wks from Jun 16; Chaz pulling biz logic detail first) |
| `2dec96e2` | Taylor Kwait / Beartooth | Jun 19 | James Grenzebach departed Beartooth (confirmed Jun 15 email). Taylor is new POC — intro, confirm WO2 authority, clarify scraper/dashboard scope |

---

### Key Findings by Contact / Project

#### FF (Fast Forward) — Deep Seas CPQ
- **Jun 16 Granola:** Pricing locked: POC = **$5K**, roadmap/discovery = **$10K**. One-month total engagement.
- Discovery covers full sales motion (SDR, AE, account manager). Data room + 20-hr assessment recordings to be shared by Chaz before kickoff.
- Risk: client may feel roadmap should've come from the 20-hr assessment. Chaz's framing: existing reps aren't following good process anyway; new workflows need parallel building.
- **New opportunity logged:** Staffing agent (flat-file MSP/VMS data → proactive outreach triggers). Not ready to scope yet — Chaz pulling more business logic detail first (~2 weeks).
- Auth path: Chaz reviewing FF client contract for subcontractor language before onboarding IN2. Matthew and Renner stay client-facing; internal team handles build hours.
- Separate: FF may pay IN2 to build an agent for another FF prospect (details TBD with Chaz).

#### Service By Veteran (Brad Harrop / Mike Townsend)
- **Jun 17 calendar:** SBV x IN2 follow-up call 11 AM MT — Matthew covering (Renner in Europe).
- Decision point today: fixed project ($12.5K/1 mo) vs. embedded team ($6K/mo, 3-mo min, scales to ~$15K/mo).
- Maintenance flat rate: $350/mo covers all hosting; AI model costs separate and paid by SBV.
- Pre-call items still open: send James Grenzebach reference to Mike, share IN2 case study link.

#### Sierra Nevada Alliance (Jenny Hatch / Drew / Lisa)
- Jenny out of country for 4 weeks (Jun 14 – ~Jul 12). Working contacts: Drew (drew@sierranevadaalliance.org) + Lisa Hogan (lisa@raiseshine.org).
- Matt Brady / Volley Solutions mutual NDA: sign and return — **due Jun 18** (`4c397c61`).
- Share consolidated SNA research folder with Matt Brady once NDA signed — **due Jun 18** (`84a2c93d`).
- Matthew x Cody Rose call confirmed **Wed Jun 18 at 3 PM** (context already sent to Matthew).
- Praxis OS NDA: Renner sent counter (mutual NDA request) to Maggie Amato (maggie.amato@praxisglobal.ai) Jun 16. Awaiting response (`4dfd8ec7`, due Jun 19).

#### Beartooth Group
- **CRITICAL:** James Grenzebach no longer at Beartooth (Taylor's Jun 15 email confirmed). Taylor Kwait (taylor@beartoothgroup.com) is new day-to-day contact.
- Taylor mentioned "Faye" handles scraper issues — clarify Faye's role/authority.
- Dashboard approval and >$3K invoice items in CRM already linked to Taylor (`ab6f47e4`, `28813666`) — confirm authorization chain.
- Case study / publish items (`eff99bb5`) need re-routing: no longer go through James.

#### VOTF / Jennifer Stark
- Jun 16 email thread active: Jennifer asking about client-match memory, River Run 1-4 invoices captured incorrectly, wants May invoice batch run tomorrow (Jun 17) or Thursday.
- Open: `e9c77c67` (run May batch + resolve River Run 1-4), `8c109d2e` (cross-reference question), `82f56df4` (irrigation reconciliation routine, due Jun 29).
- Jul 1 in-person QBO fix session needs confirmation (`793ffab4`).
- Element calendar compression bug (bi-weekly jobs doubling Aug/Sep) — ticket not yet filed (`e6d5db60`).

#### VFP / Campfire AI Engine
- **Jun 17 calendar:** VFP testing session 1 PM MT — Campfire Option 2 rebuild. Back end + UI targeted for today per Jun 10 planning.
- Change order for Stephanie (revised success metrics: 95% on clean types, ~50% on full-requirement batches) still open (`cf7ec11f`, `ee0c7984`, `063d22aa`).
- Architecture diagram + Claude cost-benefit analysis promised to Ty/Stephanie/Tomi (`97b61633`), still open.

#### Bruce Weaver (contractor / VFP build)
- Multiple open items for W9 + signed contract — payment held (`8761219d`, `c98069a8`, `48111e0c`, `fdc01247`). Due Jun 11–13; check if resolved.

#### Interviews (FDE Hiring)
- Round 2 sent Jun 15 to Kevin Cheng, Sakshi Asati, Connor Seale.
- Sakshi booked: **Jun 23**. Connor booked: **Jul 2**.
- **Kevin Cheng not yet booked** — follow up today (`011c1a3c`). Repo access must go out 48 hrs before each interview.

#### Ethan Faure / BBG Contractors
- $5K proposal (Claude Desktop + Sage Estimates/PM + Bluebeam pipeline) not yet sent. Due **Jun 17** (`c1d2868f`). Start date ~Jun 29. Pre-send: research Sage/Bluebeam APIs, test PDF sq-ft extraction on sample drawings.

#### AI Fluency / Cody Rose
- Matthew x Cody call booked **Wed Jun 18 at 3 PM**.
- Renner: complete AI Fluency profile + set rates; finish Anthropic API course (`10b138d3`).

#### SimplSecurity / smplsecurity.ai
- Email to hello@simplsecurity.com bounced permanently Jun 14. Correct domain: smplsecurity.ai (Bozeman).
- Renner has direct line to CEO + CTO from Jun 10 Salesforce user group meetup. Find working contact and re-send security review request (`7a350c69`).

#### Flowsiti / Younes
- Meeting pushed ~2 weeks (Younes's son hospitalized with heart condition). Reach out ~Jun 25 to rebook (`d75c3a77`, `c689eef9`, `4fac36fd`).

#### Arrow Electronics / Tom Harshbarger
- Re-engagement email sent Jun 8. Still awaiting reply. Items: `0e93b08a`, `c54b6ca9`.

#### Mark Callahan
- Calendar reminder **TODAY Jun 17, 5 PM Vienna / 9 AM MT** (`ebc11848`). Met at Kiln Jun 3. Determine next step.

#### Aquionix / Jonathan Ooms
- Renner suggested a call Jun 8; no response. Follow up: `b17939fc`, `a9ead67d`.

---

### Overdue / Stale Open Items (due ≤ Jun 12, not completed)

Triage on return from Europe:

| Item | Contact | Due | Note |
|------|---------|-----|------|
| `7700fff9` | Chris Alvino / Fay Ranches | Jun 9 | Re-engage; reschedule never materialized |
| `4f15173d` | Matt Henningsen / Fay Ranches | Jun 9 | Never connected since Apr 9 email |
| `ad122cd3` | Brad Collins | Jun 9 | Set up QuickBooks + chart of accounts |
| `8de53ba0` | Bruce Weaver | Jun 10 | Validator + demo prep |
| `2feda630` | Bruce Weaver | Jun 11 | Agentic + parsing logic |
| `0e93b08a` | Tom Harshbarger / Arrow | Jun 11 | Re-engage; no reply |
| `9bcf948c` | Brad Harrop / SBV | Jun 11 | Post-Jun-10 call follow-up (proposal doc) |
| `eff99bb5` | Beartooth (re-route to Taylor) | Jun 12 | Publish case study |
| `84a35579` | Jonathan Distad | Jun 12 | Follow-up after Jun 11 catch-up |
| `cf7ec11f` | Stephanie / VFP | Jun 12 | Change order with revised success metrics |
| `10b138d3` | Cody Rose / AI Fluency | Jun 12 | Complete AI Fluency profile + finish Anthropic API course |

---

### This Week's Priority List (Jun 17–20)

| Date | Action | Owner |
|------|--------|-------|
| Jun 17 (today) | Mark Callahan follow-up (9 AM MT calendar reminder) | Renner |
| Jun 17 (today) | SBV x IN2 decision call 11 AM MT | Matthew covers |
| Jun 17 (today) | VFP Campfire testing session 1 PM MT | Matthew |
| Jun 17 (today) | Kevin Cheng — follow up if Round 2 not booked | Renner |
| Jun 17 (today) | VOTF May invoice run with Jennifer | Renner |
| Jun 18 | **URGENT:** Send updated Deep Seas proposal to Chaz ($5K POC + $10K roadmap) | Renner |
| Jun 18 | Matthew x Cody Rose call 3 PM — brief Matthew first | Matthew |
| Jun 18 | Sign Volley Solutions mutual NDA | Renner |
| Jun 18 | Share SNA research folder with Matt Brady (post-NDA) | Renner |
| Jun 18 | Matthew shares MSA + contracts with FF | Matthew |
| Jun 19 | Follow up Chaz: recordings + data room + subcontractor clause | Renner |
| Jun 19 | Await Maggie Amato (Praxis) mutual NDA response | — |
| Jun 19 | Beartooth/Taylor: intro + confirm WO2 authority | Renner |

---

### Opportunities Pipeline Snapshot

| Contact | Company | Stage | Value |
|---------|---------|-------|-------|
| Alex Jones (2 records) | FF / Deep Seas | Proposal | $18K + $75K |
| Brad Harrop | Service By Veteran | Proposal | $18K |
| Jenny Hatch | Sierra Nevada Alliance | Proposal | $20K |
| Ethan Faure | BBG Contractors | Proposal | $5K |
| Nolan Mabie | Ranchland Capital | Prospect | $100K |
| Samantha Severin | Nielsen | Prospect | $20K |
| Ethan Aragon | Sterling CMG | Prospect | $15K |
| Jonathan Ooms | Aquionix | Prospect | — |

---

*Auto-generated by scheduled PM review agent. Next run appends a new dated entry.*
