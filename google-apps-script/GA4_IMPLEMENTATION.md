# Hail website GA4 analytics implementation

This module reads a tagged Hail website through the Google Analytics Data API. It writes exact weekly, monthly, and yearly totals, compact weekly traffic-source attribution, and a rolling six-month article report.

GA4 starts collecting only after the Google tag is installed. It cannot backfill traffic from before installation.

## Before installing the script

1. Confirm the Google tag is published on the Hail website and article pages.
2. Visit the homepage and at least one article.
3. Confirm those visits appear in **Google Analytics → Reports → Realtime**.
4. Give the Google account that will run Apps Script at least **Viewer** access to the GA4 property.

Google's setup guide: https://support.google.com/analytics/answer/14183469

## Add the script

1. Open the Google Sheet used for the Facebook and Sender analytics.
2. Open **Extensions → Apps Script**.
3. Click **+ → Script** and name the new file `GA4`.
4. Paste the complete contents of [`GA4.gs`](./GA4.gs) into it and save.
5. Replace the existing `doGet` function in `Code.gs` with the current project version, or add its `resource === 'ga4'` branch. This exposes the GA4 data to the later dashboard.

## Enable the Google Analytics Data API

1. In the Apps Script editor, click **Services** in the left sidebar.
2. Click **Add a service**.
3. Select **Google Analytics Data API**.
4. Confirm its identifier is `AnalyticsData`, then click **Add**.
5. If Google asks you to enable the API in the linked Cloud project, follow that link and enable **Google Analytics Data API** there as well.

Apps Script service documentation: https://developers.google.com/apps-script/advanced/analyticsdata

## Script properties

Open **Project Settings → Script properties** and confirm these values:

| Property | Required | Recommended value |
| --- | --- | --- |
| `GA4_PROPERTY_ID` | Yes | The numeric property ID, such as `123456789`; do not use the `G-` Measurement ID. |
| `HAIL_SITE_URL` | Yes | `https://bbcn.org.nz` |
| `HAIL_ARTICLE_PATH_PATTERN` | No | `/article/` for the current Hail article URL format. |
| `GA4_TIMEZONE` | No | `Pacific/Auckland` |
| `GA4_INCLUDE_UNDATED_ARTICLES` | No | `false` for a strict six-month publication-date filter. |
| `ALERT_EMAIL` | No | Address that should receive refresh-failure messages. |

The public BBCN Hail articles currently use URLs such as `https://hail.to/.../article/...`, so `/article/` is the appropriate path pattern. If `HAIL_ARTICLE_PATH_PATTERN` was previously entered as `/a/`, change it to `/article/`.

## Test and initialise

1. Select `testGA4Connection` from the function list and click **Run**.
2. Approve the requested permissions.
3. Open **Execution log**. A successful message resembles:

   ```text
   Connected to GA4 property 123456789. Last 7 days: 12 sessions, 10 users, 18 views.
   ```

   A newly installed tag may legitimately return zero traffic at first.

4. Select `setupGA4Analytics` and click **Run** once.
5. The setup creates the sheets, performs the first import, and installs a Monday trigger at approximately 6 AM in the Apps Script time zone.

## Sheets created

### `ga4_traffic`

| Column | Meaning |
| --- | --- |
| `period_start` | First date of the reporting period. ISO weeks begin Monday. |
| `period_end` | Last date included. The current month and year end at yesterday. |
| `period_type` | `week`, `month`, or `year`. |
| `sessions` | Visits that began during the period. |
| `users` | Distinct active visitors within that exact period. |
| `views` | Page views, including repeat views. |
| `engaged_sessions` | Visits lasting over 10 seconds, containing a key event, or including at least two page views. |
| `last_synced` | API reconciliation timestamp. |

Weekly, monthly, and yearly rows are requested separately from GA4. This matters because distinct users cannot be calculated accurately by adding weekly user counts.

### `ga4_sources`

| Column | Meaning |
| --- | --- |
| `period_start` / `period_end` | ISO week covered by the attribution row. |
| `period_type` | Always `week`, keeping storage compact. |
| `channel_group` | GA4 acquisition group such as Email, Organic Social, Organic Search, Referral, or Direct. |
| `source_medium` | Detailed source and medium, such as `sender / email` or `facebook / social`. |
| `sessions`, `users`, `views`, `engaged_sessions` | Performance attributed to that source during the week. |
| `last_synced` | API reconciliation timestamp. |

This tab contains aggregate acquisition data only. It does not store visitor identities.

### `ga4_articles`

| Column | Meaning |
| --- | --- |
| `period_start` / `period_end` | Rolling six-month analytics interval. |
| `article_url` | Full Hail or custom-domain article URL reported by GA4. |
| `article_title` | Title read from the article page. |
| `publication_date` | Date read from structured metadata or the visible Hail article date. |
| `views`, `sessions`, `users`, `engaged_sessions` | Article performance during the interval. |
| `last_synced` | Refresh timestamp. |

By default, an article without a readable publication date is excluded because the script cannot prove that it was published during the last six months. Set `GA4_INCLUDE_UNDATED_ARTICLES` to `true` only if you want those pages included with a blank publication date.

The article tab is replaced on each refresh, so it remains a compact current report. The traffic tab is upserted by period and retains historical totals.

## Dashboard JSON

After adding the GA4 branch to `Code.gs`, redeploy the Apps Script web app as a new version. Request:

```text
https://script.google.com/macros/s/DEPLOYMENT_ID/exec?resource=ga4
```

Optional inclusive date filters:

```text
https://script.google.com/macros/s/DEPLOYMENT_ID/exec?resource=ga4&from=2026-01-01&to=2026-12-31
```

The response contains `traffic.weekly`, `traffic.monthly`, `traffic.yearly`, `traffic_sources`, a prior-period comparison, `recent_articles`, short metric explanations, and the last successful refresh time.

## Troubleshooting

- **AnalyticsData is not defined:** add the Google Analytics Data API under Apps Script Services.
- **Permission denied:** add the Apps Script Google account as a Viewer on the GA4 property.
- **Property not found:** use the numeric GA4 Property ID, not the `G-` Measurement ID.
- **Traffic sheets are empty:** verify Realtime data, wait until the next day, then rerun `weeklyGA4Refresh`; the collector intentionally reports through yesterday.
- **Article sheet is empty but traffic exists:** change `HAIL_ARTICLE_PATH_PATTERN` to `/article/`, confirm article visits are present in GA4, and review the execution log for missing publication dates.
- **Traffic sources are empty:** paste the updated `GA4.gs`, run `weeklyGA4Refresh`, and confirm the new `ga4_sources` tab contains rows.
- **Unexpected columns:** back up and rename or clear a manually created `ga4_traffic`, `ga4_sources`, or `ga4_articles` tab, then rerun setup. The script refuses to silently reinterpret existing data.
