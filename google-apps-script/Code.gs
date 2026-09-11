/**
 * Facebook Page Analytics -> Google Sheets
 *
 * One-time setup:
 *   1. Set script properties FB_PAGE_ID and FB_ACCESS_TOKEN.
 *   2. Run setup() and approve the Google permissions.
 *
 * This code uses the endpoint mapping requested for the project. It is
 * intentionally written as one Apps Script file so it can be pasted directly
 * into Extensions > Apps Script in a Google Sheet.
 */

const CONFIG = {
  // v26 contains Meta's current follow/media-view insight replacements.
  GRAPH_VERSION: 'v26.0',
  LOOKBACK_DAYS: 30,
  POSTS_LIMIT: 25,
  POST_HISTORY_DAYS: 730,
  HISTORY_DAYS: 365,
  TAB_HEADERS: {
    followers: ['date', 'followers'],
    gained_lost: ['date', 'gained', 'lost'],
    impressions: ['date', 'impressions'],
    reach: ['date', 'reach'],
    engagement: ['date', 'engagement_rate', 'followers', 'reactions', 'comments', 'shares', 'page_post_engagements', 'post_media_views'],
    reactions: ['date', 'reactions'],
    comments: ['date', 'comments'],
    // New columns are appended so existing rows remain aligned after upgrade.
    posts: ['post_id', 'media_available', 'reactions', 'comments', 'shares', 'fetched_at', 'created_time', 'message', 'permalink_url'],
    summary: ['generated_at', 'month', 'followers_end', 'followers_change', 'gained_followers', 'lost_followers', 'impressions', 'reach', 'engagement_rate', 'total_posts', 'total_reactions', 'total_comments', 'total_shares']
  }
};

/** Creates every required tab, header row, and scheduled trigger. */
function setup() {
  assertConfiguration_();
  ensureWorkbook_();
  createScheduledTriggers();
  dailyRefresh();
}

/**
 * Verifies that this is a usable Page analytics token, rather than merely a
 * token capable of reading the Page's public name.
 */
function testConnection() {
  const pageId = getRequiredProperty_('FB_PAGE_ID');
  const page = graphGet_('/' + pageId, { fields: 'id,name' });
  try {
    graphGet_('/' + pageId + '/posts', { fields: 'id', limit: 1 });
  } catch (error) {
    throw new Error(
      'The token can read this Page publicly but cannot read Page posts. ' +
      'Set FB_ACCESS_TOKEN to the Page access token returned for this exact Page, not a user token. ' +
      'Meta response: ' + error.message
    );
  }
  Logger.log('Connected to Facebook Page: ' + page.name + ' (' + page.id + ')');
  return page;
}

/** Runs each day. It is safe to run more than once: the current date is upserted. */
function dailyRefresh() {
  try {
    ensureWorkbook_();
    const payload = fetchAndTransformAnalytics_();
    writeAnalyticsToSheets_(payload);
    PropertiesService.getScriptProperties().setProperty('LAST_SUCCESSFUL_REFRESH', new Date().toISOString());
    return payload;
  } catch (error) {
    handleRefreshError_(error, 'dailyRefresh');
    throw error;
  }
}

/** Runs weekly to repair/extend the rolling daily insight series. */
function weeklyRefresh() {
  try {
    ensureWorkbook_();
    const payload = fetchAndTransformAnalytics_(90);
    writeAnalyticsToSheets_(payload);
    return payload;
  } catch (error) {
    handleRefreshError_(error, 'weeklyRefresh');
    throw error;
  }
}

/**
 * Runs on the first day of each month. This is the sheet-side monthly summary;
 * the email delivery automation can call this function later.
 */
function monthlySummaryGeneration() {
  ensureWorkbook_();
  const today = new Date();
  const previousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const summary = calculateMonthlySummary_(previousMonth);
  const sheet = getSheet_('summary');
  sheet.appendRow(CONFIG.TAB_HEADERS.summary.map(function(header) { return summary[header]; }));
  return summary;
}

/** Removes this project's old triggers and creates daily, weekly and monthly jobs. */
function createScheduledTriggers() {
  const handlers = ['dailyRefresh', 'weeklyRefresh', 'monthlySummaryGeneration'];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });

  ScriptApp.newTrigger('dailyRefresh').timeBased().everyDays(1).atHour(2).create();
  ScriptApp.newTrigger('weeklyRefresh').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  ScriptApp.newTrigger('monthlySummaryGeneration').timeBased().onMonthDay(1).atHour(4).create();
}

/**
 * Web-app endpoint for the later dashboard. Deploy this script as a web app
 * and call its URL with ?resource=dashboard. Output exactly matches the agreed
 * JSON schema.
 */
function doGet(e) {
  const resource = (e && e.parameter && e.parameter.resource) || 'dashboard';
  try {
    if (resource === 'sender') {
      return jsonOutput_(getSenderDashboardData(
        e && e.parameter ? e.parameter.from : null,
        e && e.parameter ? e.parameter.to : null
      ));
    }
    if (resource === 'ga4') {
      return jsonOutput_(getGA4DashboardData(
        e && e.parameter ? e.parameter.from : null,
        e && e.parameter ? e.parameter.to : null
      ));
    }
    if (resource !== 'dashboard') return jsonOutput_({ error: 'Unknown resource.' });
    return jsonOutput_(getDashboardData(
      e && e.parameter ? e.parameter.from : null,
      e && e.parameter ? e.parameter.to : null
    ));
  } catch (error) {
    return jsonOutput_({ error: error.message });
  }
}

/** Reads persisted data and returns the dashboard JSON schema. */
function getDashboardData(fromDate, toDate) {
  ensureWorkbook_();
  const followers = readRows_('followers');
  const gainedLost = readRows_('gained_lost');
  const impressions = readRows_('impressions');
  const reach = readRows_('reach');
  const engagement = readRows_('engagement');
  const reactions = readRows_('reactions');
  const comments = readRows_('comments');
  const posts = readRows_('posts');

  const allPosts = posts.map(function(row) {
    return {
      post_id: String(row.post_id || ''),
      media_available: toBoolean_(row.media_available),
      reactions: toNumber_(row.reactions),
      comments: toNumber_(row.comments),
      shares: toNumber_(row.shares),
      created_time: String(row.created_time || ''),
      message: String(row.message || ''),
      permalink_url: String(row.permalink_url || '')
    };
  });
  const range = dashboardDateRanges_(fromDate, toDate);
  const currentMetrics = facebookPeriodMetrics_(range.current, followers, gainedLost, impressions, reach, engagement);
  const previousMetrics = facebookPeriodMetrics_(range.previous, followers, gainedLost, impressions, reach, engagement);
  const recentPosts = allPosts.filter(function(post) {
    return dashboardDateInRange_(post.created_time, range.current.from, range.current.to);
  }).sort(function(a, b) {
    return String(b.created_time).localeCompare(String(a.created_time));
  });
  const topPosts = recentPosts.slice().sort(function(a, b) {
    return facebookPostScore_(b) - facebookPostScore_(a) || String(b.created_time).localeCompare(String(a.created_time));
  }).slice(0, 5).map(function(post) {
    return Object.assign({}, post, {
      total_engagement: facebookPostScore_(post),
      engagement_rate: currentMetrics.page_followers
        ? round_((facebookPostScore_(post) / currentMetrics.page_followers) * 100, 2)
        : 0
    });
  });

  return {
    period: range.current,
    page_followers: currentMetrics.page_followers,
    followers_evolution: followers.slice(-CONFIG.HISTORY_DAYS).map(function(row) {
      return { date: String(row.date), followers: toNumber_(row.followers) };
    }),
    gained_followers: currentMetrics.gained_followers,
    lost_followers: currentMetrics.lost_followers,
    gained_lost_followers_daily: gainedLost.slice(-CONFIG.HISTORY_DAYS).map(function(row) {
      return { date: String(row.date), gained: toNumber_(row.gained), lost: toNumber_(row.lost) };
    }),
    impressions: currentMetrics.impressions,
    reach: currentMetrics.reach,
    engagement_rate: currentMetrics.engagement_rate,
    // Additional history fields let the static dashboard apply its date filter
    // without changing the original data contract above.
    impressions_history: impressions.slice(-CONFIG.HISTORY_DAYS).map(function(row) {
      return { date: String(row.date), impressions: toNumber_(row.impressions) };
    }),
    reach_history: reach.slice(-CONFIG.HISTORY_DAYS).map(function(row) {
      return { date: String(row.date), reach: toNumber_(row.reach) };
    }),
    engagement_history: engagement.slice(-CONFIG.HISTORY_DAYS).map(function(row) {
      return { date: String(row.date), engagement_rate: toNumber_(row.engagement_rate) };
    }),
    reactions_history: reactions.slice(-CONFIG.HISTORY_DAYS).map(function(row) {
      return { date: String(row.date), reactions: toNumber_(row.reactions) };
    }),
    comments_history: comments.slice(-CONFIG.HISTORY_DAYS).map(function(row) {
      return { date: String(row.date), comments: toNumber_(row.comments) };
    }),
    recent_posts: recentPosts,
    top_performing_posts: topPosts,
    recent_posts_summary: {
      total_posts: recentPosts.length,
      total_reactions: recentPosts.reduce(function(total, post) { return total + post.reactions; }, 0),
      total_comments: recentPosts.reduce(function(total, post) { return total + post.comments; }, 0),
      total_shares: recentPosts.reduce(function(total, post) { return total + post.shares; }, 0)
    },
    comparison: Object.assign({ period: range.previous }, previousMetrics),
    last_refreshed: PropertiesService.getScriptProperties().getProperty('LAST_SUCCESSFUL_REFRESH') || null
  };
}

function facebookPeriodMetrics_(range, followers, gainedLost, impressions, reach, engagement) {
  const within = function(row) { return dashboardDateInRange_(row.date, range.from, range.to); };
  const followerRows = followers.filter(function(row) {
    const date = dashboardDateOnly_(row.date);
    return date && date <= range.to;
  });
  const engagementRows = engagement.filter(within);
  const followerEnd = followerRows.length ? followerRows[followerRows.length - 1] : null;
  return {
    page_followers: followerEnd ? toNumber_(followerEnd.followers) : 0,
    gained_followers: gainedLost.filter(within).reduce(function(total, row) { return total + toNumber_(row.gained); }, 0),
    lost_followers: gainedLost.filter(within).reduce(function(total, row) { return total + toNumber_(row.lost); }, 0),
    impressions: impressions.filter(within).reduce(function(total, row) { return total + toNumber_(row.impressions); }, 0),
    reach: reach.filter(within).reduce(function(total, row) { return total + toNumber_(row.reach); }, 0),
    engagement_rate: engagementRows.length ? toNumber_(engagementRows[engagementRows.length - 1].engagement_rate) : 0
  };
}

function facebookPostScore_(post) {
  return toNumber_(post.reactions) + toNumber_(post.comments) + toNumber_(post.shares);
}

function dashboardDateRanges_(fromDate, toDate) {
  const today = new Date();
  const toText = dashboardDateOnly_(toDate) || localDate_(today);
  const to = new Date(toText + 'T12:00:00');
  const defaultFrom = new Date(to.getTime() - (29 * 86400000));
  const fromText = dashboardDateOnly_(fromDate) || localDate_(defaultFrom);
  const from = new Date(fromText + 'T12:00:00');
  const dayCount = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1);
  const previousTo = new Date(from.getTime() - 86400000);
  const previousFrom = new Date(previousTo.getTime() - ((dayCount - 1) * 86400000));
  return {
    current: { from: fromText, to: toText },
    previous: { from: localDate_(previousFrom), to: localDate_(previousTo) }
  };
}

function dashboardDateOnly_(value) {
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function dashboardDateInRange_(value, from, to) {
  const date = dashboardDateOnly_(value);
  return date && date >= from && date <= to;
}

// ---------------------------------------------------------------------------
// Graph API fetching and transformation
// ---------------------------------------------------------------------------

/** Fetches API data and transforms it into the required JSON schema. */
function fetchAndTransformAnalytics_(lookbackDays) {
  assertConfiguration_();
  const days = lookbackDays || CONFIG.LOOKBACK_DAYS;
  const dateRange = graphDateRange_(days);

  // Current Meta Page Insights mapping. The previous page_fans,
  // page_fan_adds/removes and page_impressions metrics were retired.
  const pageFollows = getPageInsightOrEmpty_('page_follows', { period: 'day', since: dateRange.since, until: dateRange.until });
  const mediaViews = getPageInsightOrEmpty_('page_media_view', { period: 'day', since: dateRange.since, until: dateRange.until });
  const uniqueMediaViewers = getPageInsightOrEmpty_('page_total_media_view_unique', { period: 'day', since: dateRange.since, until: dateRange.until });
  const pagePostEngagements = getPageInsightOrEmpty_('page_post_engagements', { period: 'day', since: dateRange.since, until: dateRange.until });
  const rawPosts = getRecentPosts_();

  // page_follows may not return historic values for every eligible Page. The Page field
  // is a reliable current-count fallback and still provides the required daily
  // snapshot history from the first successful refresh onward.
  const followersEvolution = insightSeries_(pageFollows, 'followers');
  if (!followersEvolution.length) {
    const currentFollowers = getCurrentPageFollowers_();
    followersEvolution.push({ date: localDate_(new Date()), followers: currentFollowers });
    Logger.log('page_follows returned no data; saved a followers_count snapshot instead.');
  }
  // Meta has no replacement for direct adds/removes. Derive a conservative
  // daily net split from consecutive daily follower snapshots.
  const gainedLostDaily = deriveGainedLostFromFollowers_(followersEvolution);

  const recentPosts = rawPosts.map(transformPost_);
  const postTotals = recentPosts.reduce(function(totals, post) {
    totals.reactions += post.reactions;
    totals.comments += post.comments;
    totals.shares += post.shares;
    totals.post_media_views += post._post_media_views;
    return totals;
  }, { reactions: 0, comments: 0, shares: 0, post_media_views: 0 });

  const latestFollowers = last_(followersEvolution);
  const followerCount = latestFollowers ? latestFollowers.followers : 0;
  const engagementRate = followerCount > 0
    ? ((postTotals.reactions + postTotals.comments + postTotals.shares) / followerCount) * 100
    : 0;
  const today = localDate_(new Date());

  return {
    page_followers: followerCount,
    followers_evolution: followersEvolution,
    gained_followers: gainedLostDaily.reduce(function(total, row) { return total + row.gained; }, 0),
    lost_followers: gainedLostDaily.reduce(function(total, row) { return total + row.lost; }, 0),
    gained_lost_followers_daily: gainedLostDaily,
    // These preserve the existing dashboard contract while using Meta's new
    // definitions: impressions = media views; reach = unique media viewers.
    impressions: sumInsightValues_(mediaViews),
    reach: sumInsightValues_(uniqueMediaViewers),
    engagement_rate: round_(engagementRate, 2),
    // The Graph endpoint supplies cumulative reactions by type. We sum types
    // across the fetched posts and persist a daily aggregate.
    reactions_history: [{ date: today, reactions: postTotals.reactions }],
    comments_history: [{ date: today, comments: postTotals.comments }],
    recent_posts: recentPosts.map(stripPrivatePostFields_),
    recent_posts_summary: {
      total_posts: recentPosts.length,
      total_reactions: postTotals.reactions,
      total_comments: postTotals.comments,
      total_shares: postTotals.shares
    },
    _daily_context: {
      date: today,
      page_post_engagements: sumInsightValues_(pagePostEngagements),
      post_media_views: postTotals.post_media_views
    },
    _insight_series: {
      impressions: insightSeries_(mediaViews, 'impressions'),
      reach: insightSeries_(uniqueMediaViewers, 'reach')
    }
  };
}

/** /{page_id}/posts and post-level endpoint calls requested in the mapping. */
function getRecentPosts_() {
  const pageId = getRequiredProperty_('FB_PAGE_ID');
  const fields = 'id,created_time,message,permalink_url,shares,reactions.limit(0).summary(true)';
  const response = graphGet_('/' + pageId + '/posts', { fields: fields, limit: CONFIG.POSTS_LIMIT });
  return response.data || [];
}

function transformPost_(rawPost) {
  const postId = rawPost.id;
  const reactionTypes = getPostInsight_(postId, 'post_reactions_by_type_total');
  const postMediaViews = getPostInsight_(postId, 'post_media_view');
  // These deliberately use the explicit endpoints in the project mapping,
  // rather than relying solely on nested fields from /{page_id}/posts.
  const comments = getPostCommentCount_(postId);
  const attachments = getPostAttachments_(postId);
  const typedReactionTotal = sumReactionTypes_(reactionTypes);
  const fieldReactionTotal = summaryCount_(rawPost.reactions);

  return {
    post_id: String(postId),
    media_available: attachments.length > 0,
    // Prefer the post insight endpoint; fall back to reactions summary where
    // the Page's permission/version does not return a typed reaction map.
    reactions: typedReactionTotal || fieldReactionTotal,
    comments: comments,
    shares: toNumber_(rawPost.shares && rawPost.shares.count),
    created_time: String(rawPost.created_time || ''),
    message: String(rawPost.message || ''),
    permalink_url: String(rawPost.permalink_url || ''),
    _post_media_views: insightLatestValue_(postMediaViews)
  };
}

/** /{post_id}/comments?summary=true from the required mapping. */
function getPostCommentCount_(postId) {
  try {
    const response = graphGet_('/' + postId + '/comments', { summary: 'true', limit: 0 });
    return summaryCount_(response);
  } catch (error) {
    Logger.log('Comments unavailable for ' + postId + ': ' + error.message);
    return 0;
  }
}

/** /{post_id}/attachments from the required mapping. */
function getPostAttachments_(postId) {
  try {
    const response = graphGet_('/' + postId + '/attachments', { fields: 'media_type,media', limit: 10 });
    return response.data || [];
  } catch (error) {
    Logger.log('Attachments unavailable for ' + postId + ': ' + error.message);
    return [];
  }
}

function getPageInsight_(metric, parameters) {
  const pageId = getRequiredProperty_('FB_PAGE_ID');
  // Graph API exposes Page insight names as the `metric` query parameter on
  // the /insights edge. Appending the metric to the path produces (#100)
  // "The value must be a valid insights metric" on current Graph versions.
  return graphGet_('/' + pageId + '/insights', Object.assign({}, parameters || {}, { metric: metric })).data || [];
}

/**
 * Keeps an unavailable Page metric from preventing all other analytics from
 * refreshing. The metric name and Meta error are visible in Executions logs.
 */
function getPageInsightOrEmpty_(metric, parameters) {
  try {
    return getPageInsight_(metric, parameters);
  } catch (error) {
    Logger.log('Page metric unavailable: ' + metric + '. ' + error.message);
    return [];
  }
}

/** Current follower count fallback for Pages where page_fans is retired. */
function getCurrentPageFollowers_() {
  const pageId = getRequiredProperty_('FB_PAGE_ID');
  const page = graphGet_('/' + pageId, { fields: 'followers_count,fan_count' });
  return toNumber_(page.followers_count || page.fan_count);
}

function getPostInsight_(postId, metric) {
  try {
    // Post insight names follow the same /insights?metric=<name> convention.
    return graphGet_('/' + postId + '/insights', { metric: metric }).data || [];
  } catch (error) {
    // Some post insight metrics are unavailable for older posts or permissions.
    // The post itself remains usable, so record a warning and return zero.
    Logger.log('Post insight unavailable for ' + postId + ' / ' + metric + ': ' + error.message);
    return [];
  }
}

/** Performs a Graph API GET and turns token/API errors into useful messages. */
function graphGet_(path, parameters) {
  const token = getRequiredProperty_('FB_ACCESS_TOKEN');
  const params = Object.assign({}, parameters || {}, { access_token: token });
  const query = Object.keys(params).map(function(key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
  }).join('&');
  const url = 'https://graph.facebook.com/' + CONFIG.GRAPH_VERSION + path + '?' + query;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const status = response.getResponseCode();
  let body;
  try { body = JSON.parse(response.getContentText()); } catch (ignored) { body = {}; }
  if (status < 200 || status >= 300 || body.error) {
    const apiError = body.error || {};
    const isExpiredToken = apiError.code === 190;
    const message = (isExpiredToken ? 'Facebook access token is expired or invalid. ' : 'Facebook Graph API request failed. ') +
      (apiError.message || ('HTTP ' + status));
    const error = new Error(message);
    error.apiError = apiError;
    throw error;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Sheet persistence
// ---------------------------------------------------------------------------

function ensureWorkbook_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(CONFIG.TAB_HEADERS).forEach(function(tabName) {
    let sheet = spreadsheet.getSheetByName(tabName);
    if (!sheet) sheet = spreadsheet.insertSheet(tabName);
    const headers = CONFIG.TAB_HEADERS[tabName];
    const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (existing.join('|') !== headers.join('|')) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  });
}

function writeAnalyticsToSheets_(payload) {
  upsertRows_('followers', payload.followers_evolution.map(function(row) { return [row.date, row.followers]; }), 0);
  upsertRows_('gained_lost', payload.gained_lost_followers_daily.map(function(row) { return [row.date, row.gained, row.lost]; }), 0);
  upsertRows_('impressions', payload._insight_series.impressions.map(function(row) { return [row.date, row.impressions]; }), 0);
  upsertRows_('reach', payload._insight_series.reach.map(function(row) { return [row.date, row.reach]; }), 0);
  upsertRows_('reactions', payload.reactions_history.map(function(row) { return [row.date, row.reactions]; }), 0);
  upsertRows_('comments', payload.comments_history.map(function(row) { return [row.date, row.comments]; }), 0);

  const context = payload._daily_context;
  upsertRows_('engagement', [[
    context.date, payload.engagement_rate, payload.page_followers,
    payload.recent_posts_summary.total_reactions, payload.recent_posts_summary.total_comments,
    payload.recent_posts_summary.total_shares, context.page_post_engagements, context.post_media_views
  ]], 0);

  upsertPosts_(payload.recent_posts);
}

/** Upserts sheet rows by a stable key (date for every time-series tab). */
function upsertRows_(tabName, rows, keyIndex) {
  if (!rows.length) return;
  const sheet = getSheet_(tabName);
  const headers = CONFIG.TAB_HEADERS[tabName];
  const existingCount = Math.max(0, sheet.getLastRow() - 1);
  const existing = existingCount ? sheet.getRange(2, 1, existingCount, headers.length).getValues() : [];
  const byKey = {};
  existing.forEach(function(row) { if (row[keyIndex] !== '') byKey[String(row[keyIndex])] = row; });
  rows.forEach(function(row) { byKey[String(row[keyIndex])] = row; });
  const merged = Object.keys(byKey).sort().map(function(key) { return byKey[key]; });
  if (existingCount) sheet.getRange(2, 1, existingCount, headers.length).clearContent();
  if (merged.length) sheet.getRange(2, 1, merged.length, headers.length).setValues(merged);
}

function upsertPosts_(posts) {
  const headers = CONFIG.TAB_HEADERS.posts;
  const fetchedAt = new Date().toISOString();
  const rows = posts.map(function(post) {
    return [
      post.post_id, post.media_available, post.reactions, post.comments, post.shares, fetchedAt,
      post.created_time, post.message, post.permalink_url
    ];
  });
  upsertRows_('posts', rows, 0);
  pruneStoredPosts_();
}

function pruneStoredPosts_() {
  const sheet = getSheet_('posts');
  const headers = CONFIG.TAB_HEADERS.posts;
  const existingCount = Math.max(0, sheet.getLastRow() - 1);
  if (!existingCount) return;
  const cutoff = localDate_(new Date(Date.now() - (CONFIG.POST_HISTORY_DAYS * 86400000)));
  const kept = readRows_('posts').filter(function(post) {
    const created = dashboardDateOnly_(post.created_time);
    return !created || created >= cutoff;
  });
  sheet.getRange(2, 1, existingCount, headers.length).clearContent();
  if (kept.length) {
    const values = kept.map(function(post) {
      return headers.map(function(header) { return post[header]; });
    });
    sheet.getRange(2, 1, values.length, headers.length).setValues(values);
  }
}

function readRows_(tabName) {
  const sheet = getSheet_(tabName);
  const headers = CONFIG.TAB_HEADERS[tabName];
  const count = Math.max(0, sheet.getLastRow() - 1);
  if (!count) return [];
  return sheet.getRange(2, 1, count, headers.length).getValues()
    .filter(function(row) { return row[0] !== ''; })
    .map(function(row) {
      const object = {};
      headers.forEach(function(header, index) { object[header] = row[index]; });
      return object;
    })
    .sort(function(a, b) { return String(a.date || a.post_id).localeCompare(String(b.date || b.post_id)); });
}

function getSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Missing sheet tab: ' + name);
  return sheet;
}

// ---------------------------------------------------------------------------
// Monthly summary calculation
// ---------------------------------------------------------------------------

function calculateMonthlySummary_(monthStart) {
  const start = localDate_(monthStart);
  const end = localDate_(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0));
  const previousStart = localDate_(new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1));
  const followers = readRows_('followers');
  const gainedLost = readRows_('gained_lost');
  const impressions = readRows_('impressions');
  const reach = readRows_('reach');
  const engagement = readRows_('engagement');
  const reactions = readRows_('reactions');
  const comments = readRows_('comments');
  const posts = readRows_('posts');
  const inMonth = function(row) { return row.date >= start && row.date <= end; };
  const beforeMonth = followers.filter(function(row) { return row.date >= previousStart && row.date < start; });
  const thisFollowers = followers.filter(inMonth);
  const followersEnd = last_(thisFollowers) || last_(followers);
  const followersBefore = last_(beforeMonth);
  const sum = function(rows, field) { return rows.filter(inMonth).reduce(function(n, row) { return n + toNumber_(row[field]); }, 0); };
  const engagementRows = engagement.filter(inMonth);
  const engagementRate = engagementRows.length
    ? engagementRows.reduce(function(n, row) { return n + toNumber_(row.engagement_rate); }, 0) / engagementRows.length : 0;

  return {
    generated_at: new Date().toISOString(),
    month: start.slice(0, 7),
    followers_end: followersEnd ? toNumber_(followersEnd.followers) : 0,
    followers_change: (followersEnd ? toNumber_(followersEnd.followers) : 0) - (followersBefore ? toNumber_(followersBefore.followers) : 0),
    gained_followers: sum(gainedLost, 'gained'),
    lost_followers: sum(gainedLost, 'lost'),
    impressions: sum(impressions, 'impressions'),
    reach: sum(reach, 'reach'),
    engagement_rate: round_(engagementRate, 2),
    total_posts: posts.length,
    total_reactions: sum(reactions, 'reactions'),
    total_comments: sum(comments, 'comments'),
    total_shares: engagement.filter(inMonth).reduce(function(n, row) { return n + toNumber_(row.shares); }, 0)
  };
}

// ---------------------------------------------------------------------------
// Small transformation and utility functions
// ---------------------------------------------------------------------------

function insightSeries_(insights, outputField) {
  return (insights || []).reduce(function(series, insight) {
    (insight.values || []).forEach(function(point) {
      series.push({ date: graphDateToLocal_(point.end_time), [outputField]: toNumber_(point.value) });
    });
    return series;
  }, []).sort(function(a, b) { return a.date.localeCompare(b.date); });
}

function insightMap_(insights) {
  const map = {};
  insightSeries_(insights, 'value').forEach(function(row) { map[row.date] = row.value; });
  return map;
}

/**
 * Produces the requested gained/lost shape from cumulative follower snapshots.
 * A positive daily change is recorded as gained and a negative change as lost.
 * Meta no longer exposes direct, separate add/remove counts.
 */
function deriveGainedLostFromFollowers_(incomingFollowers) {
  const storedByDate = {};
  try {
    readRows_('followers').forEach(function(row) {
      storedByDate[String(row.date)] = toNumber_(row.followers);
    });
  } catch (ignored) {
    // setup may call this before the followers sheet has been created.
  }
  (incomingFollowers || []).forEach(function(row) {
    storedByDate[String(row.date)] = toNumber_(row.followers);
  });
  const dates = Object.keys(storedByDate).sort();
  let previous = null;
  return dates.map(function(date) {
    const followers = storedByDate[date];
    const difference = previous === null ? 0 : followers - previous;
    previous = followers;
    return { date: date, gained: Math.max(0, difference), lost: Math.max(0, -difference) };
  });
}

function insightLatestValue_(insights) {
  const values = insightSeries_(insights, 'value');
  return values.length ? toNumber_(last_(values).value) : 0;
}

function sumInsightValues_(insights) {
  return insightSeries_(insights, 'value').reduce(function(total, row) { return total + toNumber_(row.value); }, 0);
}

function sumReactionTypes_(insights) {
  let total = 0;
  (insights || []).forEach(function(insight) {
    (insight.values || []).forEach(function(point) {
      if (typeof point.value === 'object' && point.value !== null) {
        Object.keys(point.value).forEach(function(type) { total += toNumber_(point.value[type]); });
      } else total += toNumber_(point.value);
    });
  });
  return total;
}

function summaryCount_(field) {
  return toNumber_(field && field.summary && field.summary.total_count);
}

function stripPrivatePostFields_(post) {
  return {
    post_id: post.post_id,
    media_available: post.media_available,
    reactions: post.reactions,
    comments: post.comments,
    shares: post.shares,
    created_time: post.created_time,
    message: post.message,
    permalink_url: post.permalink_url
  };
}

function graphDateRange_(days) {
  const until = new Date();
  const since = new Date(until.getTime() - ((days - 1) * 86400000));
  return { since: Math.floor(since.getTime() / 1000), until: Math.floor(until.getTime() / 1000) };
}

function graphDateToLocal_(value) {
  return localDate_(new Date(value));
}

function localDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function uniqueSorted_(values) {
  const unique = {};
  values.forEach(function(value) { unique[value] = true; });
  return Object.keys(unique).sort();
}

function toNumber_(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  return isFinite(number) ? number : 0;
}

function toBoolean_(value) {
  return value === true || String(value).toLowerCase() === 'true' || value === 1;
}

function round_(value, places) {
  const factor = Math.pow(10, places || 0);
  return Math.round(toNumber_(value) * factor) / factor;
}

function last_(array) { return array && array.length ? array[array.length - 1] : null; }

function getRequiredProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error('Missing Script Property ' + key + '. Add it in Project Settings > Script properties.');
  return value;
}

function assertConfiguration_() {
  getRequiredProperty_('FB_PAGE_ID');
  getRequiredProperty_('FB_ACCESS_TOKEN');
}

function handleRefreshError_(error, jobName) {
  const message = '[' + jobName + '] ' + (error && error.message ? error.message : String(error));
  Logger.log(message);
  PropertiesService.getScriptProperties().setProperty('LAST_API_ERROR', new Date().toISOString() + ' ' + message);
  const email = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL');
  if (email) MailApp.sendEmail(email, 'Facebook analytics refresh failed', message);
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
