# Lead Finder Engine (cloud)

Runs on GitHub Actions, so no PC needs to be on.

| Job | When (IST) | What it does |
|---|---|---|
| **Daily Lead Engine** | 7:47 AM full run, 5:53 PM jobs only | Finds people at the firms in the sheet's **Targets** tab, guesses and checks their emails, adds them to the **Daily - …** tabs, hands verified leads (with drafts) to the outreach tabs, and adds job openings to **Jobs - Openings** |
| **Email Checker** | every hour at :25 | Checks each unsent lead's email once, next-to-be-sent first. Verified = released. Dead = "Email failed check". Can't tell = "Shady", sent only from `SHADY_SENDER` |

The schedule times are approximate, because GitHub can start a scheduled job a few minutes late.

**Keys:** one repository secret named `KEYS_TXT` holds the whole `keys.txt` (`NAME=value` per line). Nothing secret is in this code.

**Run now:** go to the **Actions** tab, pick the job, and press **Run workflow**.

**Memory between runs** (email patterns per company, daily quota counters) is kept in the Actions cache.

The engine code is the same as the n8n version: `workflows/*.json` are the exported workflows, and `engine/run.js` runs them without n8n. If a step fails it is logged and skipped, and the rest still runs and writes to the sheet.
