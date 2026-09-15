# BBCN Communications Analytics — Developer Help

This document explains how the BBCN Communications Analytics system is connected, where each part is hosted, and how to maintain it.

## 1. System overview

```text
Facebook Graph API ─┐
Sender.net API ──────┼─> Google Apps Script ─> Google Sheet database ─> Apps Script JSON API ─> GitHub Pages dashboard
GA4 / Hail website ─┘

Google Apps Script also generates scheduled refreshes and monthly reports.
```

The dashboard is a static HTML/CSS/JavaScript site. It does not store credentials. It requests live JSON from the deployed Apps Script web app.

## 2. Where everything is hosted

| Component | Location | Purpose |
|---|---|---|
| Source code | GitHub: https://github.com/BBCN-Christchurch/bbcn-communications-analytics | Version control and backup |
| Public dashboard | https://bbcn-christchurch.github.io/bbcn-communications-analytics/ | Public dashboard hosted by GitHub Pages |
| Dashboard source | `dashboard/` | `index.html`, `styles.css`, `app.js`, `config.js`, logo and documentation |
| Apps Script source | `google-apps-script/` | Facebook, GA4, Sender collectors and implementation notes |
| Google Sheet database | Google Drive: **BBCN Communications Analytics DB** | Persistent metric storage |
| Apps Script JSON endpoint | The deployed `/exec` URL stored in `dashboard/config.js` | Supplies `resource=dashboard`, `resource=ga4`, and `resource=sender` JSON |
| Scheduled jobs | Google Apps Script triggers | Daily/weekly refreshes and monthly summaries |

The Google Sheet must remain in Google Drive. Do not put the live Sheet or access tokens in GitHub.

## 3. Repository structure

```text
.
├── dashboard/
│   ├── index.html       # Dashboard layout
│   ├── styles.css       # Main visual design and responsive rules
│   ├── app.js           # Fetching, filtering, calculations and Chart.js rendering
│   ├── config.js        # Apps Script /exec URL and sample-data setting
│   ├── bbcn-logo.png    # BBCN logo
│   └── README.md
├── google-apps-script/
│   ├── Facebook.gs      # Facebook Graph API collector and JSON endpoint
│   ├── GA4.gs           # GA4 traffic, sources and Hail article collector
│   ├── Sender.gs        # Sender.net campaigns and subscriber collector
│   ├── IMPLEMENTATION.md
│   ├── GA4_IMPLEMENTATION.md
│   └── SENDER_IMPLEMENTATION.md
├── .github/workflows/pages.yml # GitHub Pages deployment workflow
└── DEVELOPER_HELP.md           # This handover guide
```

## 4. Google Apps Script project

All `.gs` files must be added to the same Google Apps Script project bound to the analytics Sheet:

- `Facebook.gs`: Facebook Page snapshots, post analytics, Sheet writes and `doGet` dashboard API branches.
- `GA4.gs`: GA4 Data API queries, website traffic periods, traffic sources and Hail article discovery.
- `Sender.gs`: regular Sender.net campaigns and weekly subscriber snapshots.

Important entry points:

- `setup()` — creates/repairs Sheet tabs and scheduled triggers, then performs a refresh.
- `dailyRefresh()` — Facebook refresh plus connected source refreshes as configured.
- `weeklyRefresh()` — longer historical reconciliation where configured.
- GA4 and Sender refresh functions are documented in their implementation files.
- `testConnection()` — confirms Facebook Page/token access.
- `doGet(e)` — serves JSON based on `resource` query parameter.

After any Apps Script code change:

1. Replace the complete file; do not append a second copy below the old code.
2. Save the project.
3. Run the relevant test/refresh function.
4. Use **Deploy → Manage deployments → Edit → New version → Deploy**.
5. Keep the existing `/exec` URL where possible.

## 5. Google Sheet tabs

The Sheet is the database. Main tabs include:

- `followers` — daily follower snapshots.
- `gained_lost` — daily movement derived from follower snapshots.
- `impressions` — daily Page media views used as impressions.
- `reach` — daily unique Page media viewers where Meta provides them.
- `engagement` — daily engagement-rate context and totals.
- `reactions` / `comments` — daily response history.
- `posts` — post ID, publication date, reactions, comments, shares, Views (`post_media_view`), title and permalink.
- `ga4_traffic` — weekly, monthly and yearly GA4 periods.
- `ga4_sources` — acquisition channels such as Email, Social, Search and Referral.
- `ga4_articles` — Hail articles discovered from GA4 page paths.
- `sender_campaigns` — regular campaign metrics.
- `sender_subscribers` — weekly subscriber snapshots.
- `summary` — monthly Facebook summary records.

Do not rename column headers manually unless the corresponding Apps Script header definition is updated as well.

## 6. Credentials and Script Properties

Credentials are stored in **Apps Script → Project Settings → Script properties**. Never commit them to GitHub or put them in dashboard files.

Typical properties:

```text
FB_PAGE_ID
FB_ACCESS_TOKEN
SENDER_API_TOKEN
GA4_PROPERTY_ID
GA4_INCLUDE_UNDATED_ARTICLES
HAIL_ARTICLE_PATH_PATTERN=/a/
REPORT_EMAIL
```

### Facebook token

Use a Page access token generated through a Meta Business system user. Graph API Explorer user tokens are short-lived and commonly cause expiry errors.

Support links:

- Meta Business Settings: https://business.facebook.com/settings/
- Meta Graph API Explorer: https://developers.facebook.com/tools/explorer/
- Meta Page access help: https://www.facebook.com/help/289207354498410/
- Meta Page access administration: https://www.facebook.com/help/187316341316631

Required access normally includes Page content/engagement and insights permissions. Test the exact Page ID before refreshing:

```text
/{page_id}?fields=id,name
/{page_id}/posts?fields=id,created_time&limit=1
```

### Sender.net token

Create or rotate the API token in Sender.net account/API settings, then update `SENDER_API_TOKEN` in Script properties.

Support links:

- Sender.net: https://www.sender.net/
- Sender help centre: https://help.sender.net/

Only regular campaigns are collected; automations and transactional emails are intentionally excluded.

### GA4 and Hail

GA4 must be installed on the Hail site and the Apps Script project must have the Analytics Data advanced service enabled. The GA4 property ID is stored in Script properties.

Support links:

- Google Analytics: https://analytics.google.com/
- GA4 Data API documentation: https://developers.google.com/analytics/devguides/reporting/data/v1
- Google Apps Script: https://script.google.com/
- Hail: https://hail.to/

GA4 traffic history cannot be reconstructed before GA4 was installed. Article discovery uses Hail `/a/` paths and embedded article JSON. Undated articles can be included with `GA4_INCLUDE_UNDATED_ARTICLES=true`.

## 7. Dashboard data contract

The dashboard calls the Apps Script endpoint with:

```text
?resource=dashboard&from=YYYY-MM-DD&to=YYYY-MM-DD
?resource=ga4&from=YYYY-MM-DD&to=YYYY-MM-DD
?resource=sender&from=YYYY-MM-DD&to=YYYY-MM-DD
```

`dashboard/app.js` applies a second client-side date filter as protection against stale deployments or unfiltered responses. When changing a metric, update both:

1. Apps Script transformation/JSON output.
2. Dashboard rendering and empty-state logic.

Facebook engagement rate is currently:

```text
(Reactions + Comments + Shares) ÷ Reach × 100
```

Facebook post Views use Meta’s supported `post_media_view` metric. This is total exposure, not unique reach.

## 8. GitHub Pages deployment

The workflow in `.github/workflows/pages.yml` publishes only the `dashboard/` directory. Apps Script source is backed up in GitHub but is not publicly served by the dashboard workflow.

After dashboard edits:

1. Commit changes to `main`.
2. Push to GitHub.
3. Wait for the Pages workflow to complete.
4. Hard-refresh the public site with `Ctrl+F5`.

Do not publish tokens, Sheet IDs, private API URLs or credentials in the repository.

## 9. Troubleshooting checklist

### Dashboard shows old values

- Hard-refresh the browser.
- Confirm the correct Apps Script `/exec` URL in `dashboard/config.js`.
- Redeploy Apps Script as a new version.
- Add cache-busting query parameters if testing a changed endpoint.

### Facebook refresh fails

- Run `testConnection()`.
- Check token type and expiry in Meta’s Access Token Debugger.
- Confirm the Page is assigned to the Business system user and app.
- Check Apps Script execution logs for unavailable metrics.

### Facebook post Views are zero

- Confirm `post_media_view` appears in the execution log with a numeric value.
- Run `setup()` once if the `posts` header is missing `views`.
- Run `dailyRefresh()` after updating the script.
- Remember that old rows may remain zero until refreshed.

### Hail articles are blank or have the wrong title

- Confirm `HAIL_ARTICLE_PATH_PATTERN` is `/a/`.
- Confirm GA4 has recorded page-path traffic.
- Set `GA4_INCLUDE_UNDATED_ARTICLES=true` if Hail does not expose dates.
- Run the GA4 refresh and inspect article-discovery log messages.

### Sender totals are wrong

- Confirm the selected date range and campaign `sent_at` dates.
- Check that only regular campaigns are present in `sender_campaigns`.
- Run the Sender refresh and inspect the `sender_campaigns` tab.

## 10. Safe maintenance rules

- Keep production credentials only in Apps Script properties.
- Make changes in small commits with clear messages.
- Back up the Google Sheet and Apps Script source before structural changes.
- Preserve existing Sheet headers and tabs unless the code is migrated at the same time.
- After changing a JSON field, test the Apps Script endpoint and the dashboard together.
- Record any new token, permission, tab, endpoint or scheduled trigger in this file.

_Last updated: 15 September 2026._