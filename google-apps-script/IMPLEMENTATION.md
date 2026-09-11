# Facebook Page Analytics Apps Script — implementation

## What this script creates

Running `setup()` in a Google Sheet creates these tabs and installs three time-based triggers:

| Tab | Columns | Purpose |
| --- | --- | --- |
| `followers` | `date`, `followers` | Daily `page_follows` / `followers_count` snapshots; this is the followers-evolution history. |
| `gained_lost` | `date`, `gained`, `lost` | Derived from consecutive follower snapshots because Meta retired direct adds/removes metrics. |
| `impressions` | `date`, `impressions` | Daily `page_media_view`, retained under the existing dashboard's `impressions` field name. |
| `reach` | `date`, `reach` | Daily `page_total_media_view_unique`, retained under the existing dashboard's `reach` field name. |
| `engagement` | `date`, `engagement_rate`, `followers`, `reactions`, `comments`, `shares`, `page_post_engagements`, `post_media_views` | Daily calculated engagement and its supported inputs. |
| `reactions` | `date`, `reactions` | Daily aggregate of reactions returned by `post_reactions_by_type_total`. |
| `comments` | `date`, `comments` | Daily aggregate from each post's comments summary. |
| `posts` | `post_id`, `media_available`, `reactions`, `comments`, `shares`, `fetched_at` | Latest fetched posts for the dashboard table. |
| `summary` | monthly summary fields | Rows created by the monthly trigger. |

The script upserts by `date`, so manually running a refresh is safe and will update the same day's row instead of creating a duplicate. It retains historical rows.

## 1. Create the Meta access token

1. In [Meta for Developers](https://developers.facebook.com/), create or select an app and add the **Facebook Login for Business** product if needed.
2. Use a Facebook account with the Page task that permits insight reading.
3. Generate a long-lived user token with the permissions your app has been approved to use, then use it to retrieve the **Page access token for this exact Page** from `/me/accounts?fields=id,name,access_token,tasks`. Store that returned Page token—not the original user token. For the endpoints in this project, this normally includes `pages_read_engagement`, `pages_read_user_content`, and `read_insights`. Your exact permissions and availability depend on your app's Meta review and Page task configuration.
4. Find the Page ID in Meta Business Suite or by querying `/{page-id}?fields=id,name` with Graph API Explorer.

Do not put the token in a worksheet cell or commit it to source control.

## 2. Add the Apps Script

1. Create a blank Google Sheet.
2. Open **Extensions → Apps Script**.
3. Replace the generated `Code.gs` contents with [`Code.gs`](./Code.gs).
4. Click **Project Settings** (gear) → **Script properties** → **Add script property** and add:

   - `FB_PAGE_ID` — the numeric Facebook Page ID.
   - `FB_ACCESS_TOKEN` — the long-lived Page access token.
   - `ALERT_EMAIL` — optional; email address to receive failed-refresh alerts.

5. In the editor, select `testConnection` and click **Run**. Approve Google permissions when asked. It verifies both Page identity and protected Page-post access; its execution log should show the Page name and ID.
6. Select `setup` and click **Run**. This creates tabs, pulls the first 30 days of data, and schedules refreshes.

Apps Script time triggers run within the selected hour, rather than at an exact minute. Adjust the spreadsheet/script time zone in **Project Settings** before running `setup` if the Page should be measured in a particular local time zone.

## 3. Verify the data and schedules

- `followers` should gain a date/follower row. This daily snapshot is what makes followers evolution possible. The script requests `page_follows`; if it returns no data, it falls back to the Page's current `followers_count` field and logs that fallback.
- `gained_lost`, `impressions`, and `reach` should contain daily dates from the selected rolling lookback window.
- `posts` should contain up to 25 recent Page posts. The Page's access rights can limit which historic post insights Meta returns; unavailable per-post metrics are logged and treated as zero, without failing the entire refresh.
- Open **Triggers** (clock icon) to confirm the daily refresh at approximately 2 AM, weekly repair at approximately 3 AM Monday, and monthly summary at approximately 4 AM on day one.

You can run `dailyRefresh`, `weeklyRefresh`, or `monthlySummaryGeneration` manually at any time. The last successful time and latest error are recorded in Script Properties as `LAST_SUCCESSFUL_REFRESH` and `LAST_API_ERROR`.

## 4. Expose the normalized JSON for the dashboard

1. In Apps Script, select **Deploy → New deployment**.
2. Choose **Web app**. Set **Execute as** to *Me*. Choose the narrowest audience that can access the dashboard (for a public static dashboard, this must be an audience that includes its visitors).
3. Deploy, approve access, and copy the Web app URL.
4. Request the URL with `?resource=dashboard`, for example:

   ```text
   https://script.google.com/macros/s/DEPLOYMENT_ID/exec?resource=dashboard
   ```

The response is the project JSON schema. The dashboard built in the next section will consume this endpoint directly. Redeploy a new version after code changes.

## Operational notes

- Meta access tokens expire. Replace `FB_ACCESS_TOKEN` before expiration; a token error is saved to Script Properties and can be emailed via `ALERT_EMAIL`.
- Graph API fields and eligibility differ by Page type, app mode, token role, privacy region, and Meta version. If a metric fails, first check the error in **Executions**, then validate the token and endpoint in Graph API Explorer with the same token. The refresh continues when an unavailable Page insight is rejected and logs its exact metric name. Direct follower additions/removals are not available from Meta, so the script derives gained/lost from snapshots.
- `engagement_rate` follows the requested formula: `(reactions + comments + shares) / followers × 100`. The script also stores `post_engaged_users` and `post_impressions` as supporting inputs, but does not substitute them into that formula.
- The existing `monthlySummaryGeneration` writes a summary row only. Automated formatting and email delivery will be added in the reporting section.
