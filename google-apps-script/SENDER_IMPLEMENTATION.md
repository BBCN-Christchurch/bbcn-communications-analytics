# Sender.net weekly analytics implementation

This integration tracks regular email campaigns only. It does not request workflow/automation or transactional-email data.

## Install

1. In Sender.net, open **Settings → API access tokens** and create a read-capable API token.
2. Open the same Google Sheet and Apps Script project used for Facebook analytics.
3. Add a new script file named `Sender.gs` and paste in the complete contents of [`Sender.gs`](./Sender.gs).
4. Replace `Facebook.gs` with the latest project version. Its `doGet` function now supports `?resource=sender` without changing the existing Facebook response.
5. Open **Project Settings → Script properties** and add:
   - Name: `SENDER_API_TOKEN`
   - Value: the token only, with no `Bearer` prefix or quotation marks.
6. Run `testSenderConnection()`. The execution log should show the number of visible campaigns and subscribers.
7. Run `setupSenderAnalytics()` once. It creates the tabs, performs the first sync, and installs a Monday trigger at approximately 5 AM in the script's time zone.

## Sheets created

### `sender_campaigns`

One row per regular sent campaign from the rolling 13-month window:

| Column | Meaning |
| --- | --- |
| `campaign_id` | Stable Sender campaign identifier used for upserts. |
| `title` | Campaign report title. |
| `subject` | Email subject line. |
| `sent_at` | Campaign send timestamp. |
| `recipients` | Contacts selected to receive the campaign. |
| `sends` | Send attempts. |
| `delivered` | API delivery count when supplied; otherwise `sends - bounces`. |
| `bounces` | Failed deliveries. |
| `unique_opens` | Explicit unique-open field when supplied; otherwise Sender's campaign `opens` count. |
| `last_synced` | Last API reconciliation timestamp. |

### `sender_subscribers_weekly`

One row per weekly snapshot:

| Column | Meaning |
| --- | --- |
| `week_ending` | Snapshot date and upsert key. |
| `period_start` | Day after the preceding snapshot, or seven days before the first snapshot. |
| `total_subscribers` | Active subscribers at snapshot time. |
| `new_subscribers` | Records created during the weekly interval. |
| `unsubscribed` | Explicit opt-outs when timestamps are exposed; otherwise the minimum churn needed to reconcile totals. |
| `net_change` | Current active total less the prior active total. |
| `last_synced` | Refresh timestamp. |

Only aggregate counts are stored. Subscriber email addresses and profiles are read temporarily during the weekly calculation and are never written to the Sheet.

## Dashboard JSON

After deploying the Apps Script web app, request:

```text
https://script.google.com/macros/s/DEPLOYMENT_ID/exec?resource=sender&from=2026-01-01&to=2026-03-31
```

`from` and `to` are optional and inclusive; the default is the last 30 days. The response contains campaign rows, campaign totals, subscriber growth for the selected period, the last 12 months of weekly growth, and the short metric tooltip text requested for the dashboard.

## Operational notes

- Weekly data means selected-period subscriber totals are aligned to stored weekly snapshots, not individual days.
- The first run can backfill campaigns from Sender's API, but subscriber growth becomes fully reliable from the first stored snapshot onward unless Sender returns historical unsubscribe timestamps.
- Each refresh updates existing campaigns because opens and bounces can continue changing after a campaign is sent.
- The script retains 13 months, providing a 12-month chart plus a small comparison buffer while keeping the workbook compact.
- Sender API source: https://api.sender.net/ and campaign details: https://api.sender.net/campaigns/get-one/
