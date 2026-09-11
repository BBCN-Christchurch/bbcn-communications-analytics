# BBCN analytics dashboard

A dependency-light static dashboard for the BBCN Facebook, Hail/GA4, and Sender.net collectors. It can be hosted directly on GitHub Pages; there is no build step and no API token is stored in the site.

## Connect the live spreadsheet data

1. In the Google Sheet, open **Extensions → Apps Script**.
2. Ensure `Code.gs`, `Sender.gs`, and `GA4.gs` are in the same Apps Script project.
3. Deploy with **Deploy → Manage deployments → New deployment → Web app**.
4. Set **Execute as** to **Me**. For a public GitHub Pages dashboard, set **Who has access** to **Anyone**.
5. Copy the deployed URL ending in `/exec`.
6. Open `dashboard/config.js` and paste it into `appsScriptUrl`:

   ```js
   window.BBCN_DASHBOARD_CONFIG = {
     appsScriptUrl: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',
     useSampleDataWhenUnconfigured: true
   };
   ```

7. Save and push the change. The sample dataset is used only while the URL is blank.

The page calls three read-only JSON endpoints:

- `?resource=dashboard&from=YYYY-MM-DD&to=YYYY-MM-DD` for Facebook
- `?resource=ga4&from=YYYY-MM-DD&to=YYYY-MM-DD` for Hail/GA4
- `?resource=sender&from=YYYY-MM-DD&to=YYYY-MM-DD` for Sender.net

If Apps Script code changes later, create a new version under **Manage deployments → Edit → Version → New version → Deploy**. The `/exec` URL remains the same.

## Publish on GitHub Pages

The repository includes `.github/workflows/pages.yml`, which publishes only the contents of `dashboard/`.

1. Create or open the GitHub repository and push these files to its `main` branch.
2. In GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Open the **Actions** tab and wait for **Deploy BBCN dashboard to GitHub Pages** to finish.
5. The deployment summary contains the public website URL.

The workflow also has a manual **Run workflow** button and redeploys whenever a file in `dashboard/` changes.

## Dashboard controls

- Select 30 days, 90 days, 12 months, this year, or a custom range.
- Switch website charts between weekly, monthly, and yearly periods.
- Compare headline metrics with the immediately preceding period of the same length.
- Review the five highest-engagement Facebook posts published in the selected dates.
- Review website acquisition by channel and detailed source/medium.
- Sort Hail articles and Sender campaigns.
- Hover or focus the small `i` icons for Sender metric explanations.
- Refresh all three sources without reloading the page.

Each data source loads independently. If one endpoint fails, the page shows the other sources and names the failing source in the warning banner.

## Cross-channel attribution

GA4 can distinguish Email, Social, Search, Referral, Direct, and other acquisition channels. For reliable campaign-level attribution, use consistent UTM parameters on every link pointing to the Hail website.

- Sender example: `?utm_source=sender&utm_medium=email&utm_campaign=monthly_newsletter`
- Facebook example: `?utm_source=facebook&utm_medium=social&utm_campaign=community_update`

Use lowercase, stable names with underscores. Do not change a campaign's UTM value after links have been published. The dashboard will immediately show channel-level GA4 attribution; the `source_medium` table also exposes correctly tagged sources.

## Upgrade after adding attribution

1. Replace `Code.gs`, `GA4.gs`, and `Sender.gs` in Apps Script with the updated project files.
2. Run `dailyRefresh` once to add Facebook post dates, messages, and links to the existing `posts` tab.
3. Run `weeklyGA4Refresh` once to create and populate `ga4_sources`.
4. Deploy a new Apps Script web-app version.
5. Reload the dashboard. Earlier Facebook posts can only be ranked after they have been collected with their publication date.

## Privacy and maintenance

GitHub Pages is a public static host. Anyone who can open the dashboard can also read the aggregate JSON returned by the Apps Script web app. Do not return subscriber email addresses, access tokens, or other personal data. For private analytics, use an authenticated host instead of public GitHub Pages.

Keep the weekly Sender and GA4 triggers running, check Apps Script execution failures periodically, and update the Chart.js version in `index.html` when deliberately testing a newer release. Visual styles are in `styles.css`; all rendering and date filtering are in `app.js`.

## Troubleshooting

- **Sample data is still shown:** `appsScriptUrl` is blank or `config.js` was not pushed.
- **All live requests fail:** confirm the `/exec` deployment is accessible in a private browser window without signing in.
- **Only one section fails:** open that resource URL directly and read its returned `error` value.
- **New Apps Script code is ignored:** deploy a new Apps Script version; saving code alone does not update an existing versioned deployment.
- **GitHub action fails:** check the repository's **Settings → Pages** source and the failed run in **Actions**.
