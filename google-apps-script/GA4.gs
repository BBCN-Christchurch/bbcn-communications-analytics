/**
 * Hail website analytics (GA4) -> Google Sheets
 *
 * Required Script Properties:
 *   GA4_PROPERTY_ID              Numeric GA4 property ID (not the G- tag ID)
 *   HAIL_SITE_URL                Public website URL, for example https://bbcn.org.nz
 *   HAIL_ARTICLE_PATH_PATTERN    Optional JavaScript regex; defaults to /a/
 *   GA4_TIMEZONE                 Optional; defaults to the Apps Script time zone
 *   GA4_INCLUDE_UNDATED_ARTICLES Optional true/false; defaults to false
 *
 * Required Apps Script advanced service:
 *   Google Analytics Data API (identifier: AnalyticsData)
 *
 * One-time setup:
 *   1. Enable the AnalyticsData advanced service.
 *   2. Run testGA4Connection().
 *   3. Run setupGA4Analytics().
 */

const GA4_CONFIG = {
  TRAFFIC_TAB: 'ga4_traffic',
  SOURCE_TAB: 'ga4_sources',
  ARTICLE_TAB: 'ga4_articles',
  TRAFFIC_HEADERS: [
    'period_start', 'period_end', 'period_type', 'sessions',
    'users', 'views', 'engaged_sessions', 'last_synced'
  ],
  SOURCE_HEADERS: [
    'period_start', 'period_end', 'period_type', 'channel_group',
    'source_medium', 'sessions', 'users', 'views',
    'engaged_sessions', 'last_synced'
  ],
  ARTICLE_HEADERS: [
    'period_start', 'period_end', 'article_url', 'article_title',
    'publication_date', 'views', 'sessions', 'users',
    'engaged_sessions', 'last_synced'
  ],
  TRAFFIC_LOOKBACK_MONTHS: 13,
  TRAFFIC_LOOKBACK_YEARS: 3,
  ARTICLE_LOOKBACK_MONTHS: 6,
  ARTICLE_FETCH_LIMIT: 250,
  API_PAGE_SIZE: 100000,
  ARTICLE_FETCH_BATCH_SIZE: 40
};

const GA4_METRIC_HELP = {
  sessions: 'Visits that began on the website during the reporting period.',
  users: 'Distinct active visitors within the reporting period.',
  views: 'Total page views, including repeat views of the same page.',
  engaged_sessions: 'Visits lasting over 10 seconds, containing a key event, or including at least two page views.'
};

/** Creates the GA4 tabs, installs the weekly trigger, and performs the first sync. */
function setupGA4Analytics() {
  ga4AssertConfigured_();
  ga4EnsureSheets_();
  createGA4WeeklyTrigger();
  return weeklyGA4Refresh();
}

/**
 * Verifies API access. A successful result may contain zero sessions when the
 * Google tag has only just been installed.
 */
function testGA4Connection() {
  ga4AssertConfigured_();
  const endDate = ga4YesterdayUtc_();
  const startDate = ga4AddDaysUtc_(endDate, -6);
  try {
    const rows = ga4RunReport_(
      [],
      ['sessions', 'activeUsers', 'screenPageViews'],
      ga4DateText_(startDate),
      ga4DateText_(endDate)
    );
    const totals = rows.length ? rows[0].metrics : {};
    Logger.log(
      'Connected to GA4 property ' + ga4PropertyId_() +
      '. Last 7 days: ' + ga4Number_(totals.sessions) + ' sessions, ' +
      ga4Number_(totals.activeUsers) + ' users, ' +
      ga4Number_(totals.screenPageViews) + ' views.'
    );
    return totals;
  } catch (error) {
    throw ga4FriendlyError_(error);
  }
}

/**
 * Refreshes exact ISO-week, calendar-month, and calendar-year totals and the
 * rolling six-month article table. Safe to rerun: traffic periods are upserted
 * and the article table is replaced.
 */
function weeklyGA4Refresh() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another analytics refresh is already running. Try again shortly.');

  try {
    ga4AssertConfigured_();
    ga4EnsureSheets_();

    const trafficRows = ga4FetchTrafficRows_();
    const sourceRows = ga4FetchTrafficSourceRows_();
    const articleRows = ga4FetchRecentArticles_();
    ga4WriteTrafficRows_(trafficRows);
    ga4WriteSourceRows_(sourceRows);
    ga4WriteArticleRows_(articleRows);

    const refreshedAt = new Date().toISOString();
    PropertiesService.getScriptProperties().setProperty('LAST_GA4_SUCCESS', refreshedAt);
    PropertiesService.getScriptProperties().deleteProperty('LAST_GA4_ERROR');
    Logger.log(
      'GA4 refresh complete: ' + trafficRows.length + ' traffic periods and ' +
      sourceRows.length + ' traffic-source rows and ' + articleRows.length + ' recent articles.'
    );
    return {
      traffic_periods: trafficRows.length,
      traffic_sources: sourceRows.length,
      recent_articles: articleRows.length,
      refreshed_at: refreshedAt
    };
  } catch (error) {
    const friendly = ga4FriendlyError_(error);
    ga4HandleError_(friendly, 'weeklyGA4Refresh');
    throw friendly;
  } finally {
    lock.releaseLock();
  }
}

/** Installs only this module's Monday trigger and preserves other project triggers. */
function createGA4WeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'weeklyGA4Refresh') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('weeklyGA4Refresh')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(6)
    .create();
}

// ---------------------------------------------------------------------------
// GA4 traffic
// ---------------------------------------------------------------------------

function ga4FetchTrafficRows_() {
  const reportEnd = ga4YesterdayUtc_();
  const syncedAt = new Date().toISOString();

  const weeklyStart = ga4StartOfIsoWeek_(
    ga4AddMonthsUtc_(ga4StartOfMonthUtc_(reportEnd), -GA4_CONFIG.TRAFFIC_LOOKBACK_MONTHS)
  );
  const monthlyStart = ga4AddMonthsUtc_(
    ga4StartOfMonthUtc_(reportEnd),
    -GA4_CONFIG.TRAFFIC_LOOKBACK_MONTHS
  );
  const yearlyStart = new Date(Date.UTC(
    reportEnd.getUTCFullYear() - GA4_CONFIG.TRAFFIC_LOOKBACK_YEARS + 1,
    0,
    1
  ));

  const weekly = ga4RunReport_(
    ['isoYearIsoWeek'],
    ['sessions', 'activeUsers', 'screenPageViews', 'engagedSessions'],
    ga4DateText_(weeklyStart),
    ga4DateText_(reportEnd)
  ).map(function(row) {
    const naturalStart = ga4IsoWeekStartFromKey_(row.dimensions.isoYearIsoWeek);
    const naturalEnd = ga4AddDaysUtc_(naturalStart, 6);
    return ga4TrafficOutputRow_('week', naturalStart, ga4MinDate_(naturalEnd, reportEnd), row.metrics, syncedAt);
  });

  const monthly = ga4RunReport_(
    ['yearMonth'],
    ['sessions', 'activeUsers', 'screenPageViews', 'engagedSessions'],
    ga4DateText_(monthlyStart),
    ga4DateText_(reportEnd)
  ).map(function(row) {
    const naturalStart = ga4MonthStartFromKey_(row.dimensions.yearMonth);
    const naturalEnd = ga4AddDaysUtc_(ga4AddMonthsUtc_(naturalStart, 1), -1);
    return ga4TrafficOutputRow_('month', naturalStart, ga4MinDate_(naturalEnd, reportEnd), row.metrics, syncedAt);
  });

  const yearly = ga4RunReport_(
    ['year'],
    ['sessions', 'activeUsers', 'screenPageViews', 'engagedSessions'],
    ga4DateText_(yearlyStart),
    ga4DateText_(reportEnd)
  ).map(function(row) {
    const year = Number(row.dimensions.year);
    const naturalStart = new Date(Date.UTC(year, 0, 1));
    const naturalEnd = new Date(Date.UTC(year, 11, 31));
    return ga4TrafficOutputRow_('year', naturalStart, ga4MinDate_(naturalEnd, reportEnd), row.metrics, syncedAt);
  });

  return weekly.concat(monthly, yearly).sort(ga4TrafficSort_);
}

function ga4TrafficOutputRow_(periodType, periodStart, periodEnd, metrics, syncedAt) {
  return {
    period_start: periodStart,
    period_end: periodEnd,
    period_type: periodType,
    sessions: ga4Number_(metrics.sessions),
    users: ga4Number_(metrics.activeUsers),
    views: ga4Number_(metrics.screenPageViews),
    engaged_sessions: ga4Number_(metrics.engagedSessions),
    last_synced: syncedAt
  };
}

/** Weekly acquisition rows keep channel attribution useful without a large sheet. */
function ga4FetchTrafficSourceRows_() {
  const reportEnd = ga4YesterdayUtc_();
  const reportStart = ga4StartOfIsoWeek_(
    ga4AddMonthsUtc_(ga4StartOfMonthUtc_(reportEnd), -GA4_CONFIG.TRAFFIC_LOOKBACK_MONTHS)
  );
  const syncedAt = new Date().toISOString();
  return ga4RunReport_(
    ['isoYearIsoWeek', 'sessionDefaultChannelGroup', 'sessionSourceMedium'],
    ['sessions', 'activeUsers', 'screenPageViews', 'engagedSessions'],
    ga4DateText_(reportStart),
    ga4DateText_(reportEnd)
  ).map(function(row) {
    const start = ga4IsoWeekStartFromKey_(row.dimensions.isoYearIsoWeek);
    return {
      period_start: start,
      period_end: ga4MinDate_(ga4AddDaysUtc_(start, 6), reportEnd),
      period_type: 'week',
      channel_group: String(row.dimensions.sessionDefaultChannelGroup || 'Unassigned'),
      source_medium: String(row.dimensions.sessionSourceMedium || '(not set)'),
      sessions: ga4Number_(row.metrics.sessions),
      users: ga4Number_(row.metrics.activeUsers),
      views: ga4Number_(row.metrics.screenPageViews),
      engaged_sessions: ga4Number_(row.metrics.engagedSessions),
      last_synced: syncedAt
    };
  }).sort(ga4SourceSort_);
}

// ---------------------------------------------------------------------------
// Recent Hail articles
// ---------------------------------------------------------------------------

function ga4FetchRecentArticles_() {
  const reportEnd = ga4YesterdayUtc_();
  const reportStart = ga4AddMonthsUtc_(reportEnd, -GA4_CONFIG.ARTICLE_LOOKBACK_MONTHS);
  const pathPattern = ga4ArticlePathRegex_();
  const includeUndated = ga4BooleanProperty_('GA4_INCLUDE_UNDATED_ARTICLES', false);
  const syncedAt = new Date().toISOString();

  const analyticsRows = ga4RunReport_(
    ['hostName', 'pagePath'],
    ['screenPageViews', 'sessions', 'activeUsers', 'engagedSessions'],
    ga4DateText_(reportStart),
    ga4DateText_(reportEnd)
  ).filter(function(row) {
    return pathPattern.test(String(row.dimensions.pagePath || ''));
  }).sort(function(a, b) {
    return ga4Number_(b.metrics.screenPageViews) - ga4Number_(a.metrics.screenPageViews);
  });

  if (analyticsRows.length > GA4_CONFIG.ARTICLE_FETCH_LIMIT) {
    Logger.log(
      'Article discovery returned ' + analyticsRows.length + ' pages. Only the top ' +
      GA4_CONFIG.ARTICLE_FETCH_LIMIT + ' by views will be checked.'
    );
  }

  const candidates = analyticsRows.slice(0, GA4_CONFIG.ARTICLE_FETCH_LIMIT).map(function(row) {
    return {
      url: ga4BuildPageUrl_(row.dimensions.hostName, row.dimensions.pagePath),
      path: String(row.dimensions.pagePath || ''),
      metrics: row.metrics
    };
  }).filter(function(candidate) { return candidate.url !== ''; });

  const metadata = ga4FetchArticleMetadata_(candidates.map(function(candidate) { return candidate.url; }));
  let missingPublicationDates = 0;

  const output = candidates.map(function(candidate, index) {
    const page = metadata[index] || {};
    const publicationDate = ga4DateOnlyUtc_(page.publication_date);
    if (!publicationDate) missingPublicationDates++;
    if (!publicationDate && !includeUndated) return null;
    if (publicationDate && (publicationDate < reportStart || publicationDate > reportEnd)) return null;

    return {
      period_start: reportStart,
      period_end: reportEnd,
      article_url: candidate.url,
      article_title: page.title || ga4ReadablePath_(candidate.path),
      publication_date: publicationDate || '',
      views: ga4Number_(candidate.metrics.screenPageViews),
      sessions: ga4Number_(candidate.metrics.sessions),
      users: ga4Number_(candidate.metrics.activeUsers),
      engaged_sessions: ga4Number_(candidate.metrics.engagedSessions),
      last_synced: syncedAt
    };
  }).filter(function(row) { return row !== null; });

  if (missingPublicationDates) {
    Logger.log(
      missingPublicationDates + ' article page(s) did not expose a publication date. ' +
      (includeUndated ? 'They were included with a blank date.' : 'They were excluded. Set GA4_INCLUDE_UNDATED_ARTICLES to true to include them.')
    );
  }

  return output.sort(function(a, b) {
    const aDate = a.publication_date ? a.publication_date.getTime() : 0;
    const bDate = b.publication_date ? b.publication_date.getTime() : 0;
    return bDate - aDate || b.views - a.views;
  });
}

function ga4FetchArticleMetadata_(urls) {
  const results = [];
  for (let start = 0; start < urls.length; start += GA4_CONFIG.ARTICLE_FETCH_BATCH_SIZE) {
    const batchUrls = urls.slice(start, start + GA4_CONFIG.ARTICLE_FETCH_BATCH_SIZE);
    const requests = batchUrls.map(function(url) {
      return {
        url: url,
        method: 'get',
        followRedirects: true,
        muteHttpExceptions: true,
        headers: { 'User-Agent': 'BBCN analytics collector/1.0' }
      };
    });

    let responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (error) {
      Logger.log('Hail article metadata batch failed: ' + error.message);
      responses = [];
    }

    batchUrls.forEach(function(url, index) {
      const response = responses[index];
      if (!response || response.getResponseCode() < 200 || response.getResponseCode() >= 400) {
        results.push({ title: '', publication_date: '' });
        return;
      }
      results.push(ga4ParseArticleMetadata_(response.getContentText()));
    });
  }
  return results;
}

function ga4ParseArticleMetadata_(html) {
  const meta = {};
  const metaTags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  metaTags.forEach(function(tag) {
    const key = ga4HtmlAttribute_(tag, 'property') || ga4HtmlAttribute_(tag, 'name') || ga4HtmlAttribute_(tag, 'itemprop');
    const value = ga4HtmlAttribute_(tag, 'content');
    if (key && value) meta[String(key).toLowerCase()] = ga4DecodeHtml_(value);
  });

  let publicationDate = meta['article:published_time'] || meta['datepublished'] ||
    meta['date'] || meta['dc.date'] || meta['dcterms.date'] || '';
  let title = meta['og:title'] || meta['twitter:title'] || '';

  if (!publicationDate) {
    const jsonLdBlocks = String(html || '').match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
    for (let i = 0; i < jsonLdBlocks.length && !publicationDate; i++) {
      const jsonText = jsonLdBlocks[i].replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
      try {
        const parsed = JSON.parse(jsonText);
        publicationDate = ga4FindJsonLdValue_(parsed, 'datePublished') || '';
        if (!title) title = ga4FindJsonLdValue_(parsed, 'headline') || ga4FindJsonLdValue_(parsed, 'name') || '';
      } catch (ignored) {}
    }
  }

  if (!publicationDate) {
    const timeTag = String(html || '').match(/<time\b[^>]*datetime=["'][^"']+["'][^>]*>/i);
    if (timeTag) publicationDate = ga4HtmlAttribute_(timeTag[0], 'datetime') || '';
  }

  if (!title) {
    const titleTag = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (titleTag) title = ga4DecodeHtml_(titleTag[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  }

  // Hail article pages visibly print the publication date near the heading.
  // This fallback is used only when structured metadata is absent.
  if (!publicationDate) {
    const visibleText = ga4DecodeHtml_(String(html || '').slice(0, 60000).replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
    const visibleDate = visibleText.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i);
    if (visibleDate) publicationDate = visibleDate[0];
  }

  return { title: title, publication_date: publicationDate };
}

function ga4FindJsonLdValue_(node, key) {
  if (!node || typeof node !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(node, key) && node[key]) return String(node[key]);
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const found = ga4FindJsonLdValue_(node[keys[i]], key);
    if (found) return found;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Dashboard JSON
// ---------------------------------------------------------------------------

/**
 * Returns the GA4 data contract for the later dashboard. Dates are optional
 * and inclusive. The default traffic window is the trailing 12 months.
 */
function getGA4DashboardData(fromDate, toDate) {
  ga4EnsureSheets_();
  const to = ga4DateOnlyUtc_(toDate) || ga4YesterdayUtc_();
  const from = ga4DateOnlyUtc_(fromDate) || ga4AddMonthsUtc_(to, -12);
  const comparisonRange = ga4PreviousPeriod_(from, to);
  const allTraffic = ga4ReadRows_(GA4_CONFIG.TRAFFIC_TAB, GA4_CONFIG.TRAFFIC_HEADERS).map(ga4NormalizeTrafficRow_);
  const traffic = allTraffic.filter(function(row) { return ga4RowOverlaps_(row, from, to); });
  const comparisonTraffic = allTraffic.filter(function(row) {
    return ga4RowOverlaps_(row, comparisonRange.from, comparisonRange.to);
  });
  const sources = ga4ReadRows_(GA4_CONFIG.SOURCE_TAB, GA4_CONFIG.SOURCE_HEADERS)
    .map(ga4NormalizeSourceRow_)
    .filter(function(row) { return ga4RowOverlaps_(row, from, to); });
  const articles = ga4ReadRows_(GA4_CONFIG.ARTICLE_TAB, GA4_CONFIG.ARTICLE_HEADERS)
    .map(ga4NormalizeArticleRow_);

  return {
    period: { from: ga4DateText_(from), to: ga4DateText_(to) },
    metric_help: GA4_METRIC_HELP,
    traffic: {
      weekly: traffic.filter(function(row) { return row.period_type === 'week'; }),
      monthly: traffic.filter(function(row) { return row.period_type === 'month'; }),
      yearly: traffic.filter(function(row) { return row.period_type === 'year'; })
    },
    traffic_sources: sources,
    comparison: {
      period: { from: ga4DateText_(comparisonRange.from), to: ga4DateText_(comparisonRange.to) },
      traffic: {
        weekly: comparisonTraffic.filter(function(row) { return row.period_type === 'week'; }),
        monthly: comparisonTraffic.filter(function(row) { return row.period_type === 'month'; }),
        yearly: comparisonTraffic.filter(function(row) { return row.period_type === 'year'; })
      }
    },
    recent_articles: articles,
    last_refreshed: PropertiesService.getScriptProperties().getProperty('LAST_GA4_SUCCESS') || null
  };
}

function ga4NormalizeSourceRow_(row) {
  return {
    period_start: ga4DateText_(ga4DateOnlyUtc_(row.period_start)),
    period_end: ga4DateText_(ga4DateOnlyUtc_(row.period_end)),
    period_type: String(row.period_type || 'week'),
    channel_group: String(row.channel_group || 'Unassigned'),
    source_medium: String(row.source_medium || '(not set)'),
    sessions: ga4Number_(row.sessions),
    users: ga4Number_(row.users),
    views: ga4Number_(row.views),
    engaged_sessions: ga4Number_(row.engaged_sessions)
  };
}

function ga4RowOverlaps_(row, from, to) {
  const start = ga4DateOnlyUtc_(row.period_start);
  const end = ga4DateOnlyUtc_(row.period_end);
  return start && end && end >= from && start <= to;
}

function ga4PreviousPeriod_(from, to) {
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1);
  const previousTo = ga4AddDaysUtc_(from, -1);
  return { from: ga4AddDaysUtc_(previousTo, -(days - 1)), to: previousTo };
}

function ga4NormalizeTrafficRow_(row) {
  return {
    period_start: ga4DateText_(ga4DateOnlyUtc_(row.period_start)),
    period_end: ga4DateText_(ga4DateOnlyUtc_(row.period_end)),
    period_type: String(row.period_type || ''),
    sessions: ga4Number_(row.sessions),
    users: ga4Number_(row.users),
    views: ga4Number_(row.views),
    engaged_sessions: ga4Number_(row.engaged_sessions)
  };
}

function ga4NormalizeArticleRow_(row) {
  return {
    period_start: ga4DateText_(ga4DateOnlyUtc_(row.period_start)),
    period_end: ga4DateText_(ga4DateOnlyUtc_(row.period_end)),
    article_url: String(row.article_url || ''),
    article_title: String(row.article_title || ''),
    publication_date: row.publication_date ? ga4DateText_(ga4DateOnlyUtc_(row.publication_date)) : '',
    views: ga4Number_(row.views),
    sessions: ga4Number_(row.sessions),
    users: ga4Number_(row.users),
    engaged_sessions: ga4Number_(row.engaged_sessions)
  };
}

// ---------------------------------------------------------------------------
// Analytics Data API
// ---------------------------------------------------------------------------

function ga4RunReport_(dimensionNames, metricNames, startDate, endDate) {
  ga4RequireAdvancedService_();
  const allRows = [];
  let offset = 0;
  let totalRows = null;

  do {
    const request = AnalyticsData.newRunReportRequest();
    request.dimensions = dimensionNames.map(function(name) {
      const dimension = AnalyticsData.newDimension();
      dimension.name = name;
      return dimension;
    });
    request.metrics = metricNames.map(function(name) {
      const metric = AnalyticsData.newMetric();
      metric.name = name;
      return metric;
    });
    const dateRange = AnalyticsData.newDateRange();
    dateRange.startDate = startDate;
    dateRange.endDate = endDate;
    // Apps Script's generated advanced-service object expects the DateRange
    // directly here (matching Google's official Apps Script sample).
    request.dateRanges = dateRange;
    request.limit = GA4_CONFIG.API_PAGE_SIZE;
    request.offset = offset;
    request.keepEmptyRows = false;

    const report = AnalyticsData.Properties.runReport(request, 'properties/' + ga4PropertyId_());
    const reportRows = report.rows || [];
    reportRows.forEach(function(row) {
      const dimensions = {};
      const metrics = {};
      dimensionNames.forEach(function(name, index) {
        dimensions[name] = row.dimensionValues && row.dimensionValues[index]
          ? row.dimensionValues[index].value
          : '';
      });
      metricNames.forEach(function(name, index) {
        metrics[name] = row.metricValues && row.metricValues[index]
          ? row.metricValues[index].value
          : 0;
      });
      allRows.push({ dimensions: dimensions, metrics: metrics });
    });

    totalRows = ga4Number_(report.rowCount);
    offset += reportRows.length;
    if (!reportRows.length) break;
  } while (offset < totalRows);

  return allRows;
}

// ---------------------------------------------------------------------------
// Sheet persistence
// ---------------------------------------------------------------------------

function ga4EnsureSheets_() {
  ga4EnsureSheet_(GA4_CONFIG.TRAFFIC_TAB, GA4_CONFIG.TRAFFIC_HEADERS, [1, 2]);
  ga4EnsureSheet_(GA4_CONFIG.SOURCE_TAB, GA4_CONFIG.SOURCE_HEADERS, [1, 2]);
  ga4EnsureSheet_(GA4_CONFIG.ARTICLE_TAB, GA4_CONFIG.ARTICLE_HEADERS, [1, 2, 5]);
}

function ga4EnsureSheet_(name, headers, dateColumns) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);

  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const currentText = current.join('|');
  if (currentText !== headers.join('|')) {
    if (sheet.getLastRow() > 1 && currentText.replace(/\|/g, '') !== '') {
      throw new Error(
        'Sheet "' + name + '" has unexpected columns. Back it up, then clear or rename it before running GA4 setup. ' +
        'Expected: ' + headers.join(', ')
      );
    }
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#1a73e8')
    .setFontColor('#ffffff')
    .setFontWeight('bold');
  dateColumns.forEach(function(column) {
    sheet.getRange(2, column, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('yyyy-mm-dd');
  });
  sheet.autoResizeColumns(1, headers.length);
}

function ga4WriteTrafficRows_(rows) {
  const sheet = ga4GetSheet_(GA4_CONFIG.TRAFFIC_TAB);
  const existing = ga4ReadRows_(GA4_CONFIG.TRAFFIC_TAB, GA4_CONFIG.TRAFFIC_HEADERS);
  const byKey = {};
  existing.forEach(function(row) {
    const start = ga4DateOnlyUtc_(row.period_start);
    if (start && row.period_type) byKey[String(row.period_type) + '|' + ga4DateText_(start)] = row;
  });
  rows.forEach(function(row) {
    byKey[row.period_type + '|' + ga4DateText_(row.period_start)] = row;
  });

  const merged = Object.keys(byKey).map(function(key) { return byKey[key]; }).sort(ga4TrafficSort_);
  const existingCount = Math.max(0, sheet.getLastRow() - 1);
  if (existingCount) sheet.getRange(2, 1, existingCount, GA4_CONFIG.TRAFFIC_HEADERS.length).clearContent();
  if (merged.length) {
    const values = merged.map(function(row) {
      return GA4_CONFIG.TRAFFIC_HEADERS.map(function(header) { return row[header]; });
    });
    sheet.getRange(2, 1, values.length, GA4_CONFIG.TRAFFIC_HEADERS.length).setValues(values);
    sheet.getRange(2, 1, values.length, 2).setNumberFormat('yyyy-mm-dd');
    sheet.getRange(2, 4, values.length, 4).setNumberFormat('#,##0');
  }
}

function ga4WriteSourceRows_(rows) {
  const sheet = ga4GetSheet_(GA4_CONFIG.SOURCE_TAB);
  const existingCount = Math.max(0, sheet.getLastRow() - 1);
  if (existingCount) sheet.getRange(2, 1, existingCount, GA4_CONFIG.SOURCE_HEADERS.length).clearContent();
  if (!rows.length) return;
  const values = rows.map(function(row) {
    return GA4_CONFIG.SOURCE_HEADERS.map(function(header) { return row[header]; });
  });
  sheet.getRange(2, 1, values.length, GA4_CONFIG.SOURCE_HEADERS.length).setValues(values);
  sheet.getRange(2, 1, values.length, 2).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(2, 6, values.length, 4).setNumberFormat('#,##0');
}

function ga4WriteArticleRows_(rows) {
  const sheet = ga4GetSheet_(GA4_CONFIG.ARTICLE_TAB);
  const existingCount = Math.max(0, sheet.getLastRow() - 1);
  if (existingCount) sheet.getRange(2, 1, existingCount, GA4_CONFIG.ARTICLE_HEADERS.length).clearContent();
  if (!rows.length) return;

  const values = rows.map(function(row) {
    return GA4_CONFIG.ARTICLE_HEADERS.map(function(header) { return row[header]; });
  });
  sheet.getRange(2, 1, values.length, GA4_CONFIG.ARTICLE_HEADERS.length).setValues(values);
  sheet.getRange(2, 1, values.length, 2).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(2, 5, values.length, 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(2, 6, values.length, 4).setNumberFormat('#,##0');
}

function ga4ReadRows_(tabName, headers) {
  const sheet = ga4GetSheet_(tabName);
  const count = Math.max(0, sheet.getLastRow() - 1);
  if (!count) return [];
  return sheet.getRange(2, 1, count, headers.length).getValues()
    .filter(function(row) { return row[0] !== ''; })
    .map(function(row) {
      const object = {};
      headers.forEach(function(header, index) { object[header] = row[index]; });
      return object;
    });
}

function ga4GetSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Missing GA4 analytics sheet: ' + name);
  return sheet;
}

// ---------------------------------------------------------------------------
// Utilities and errors
// ---------------------------------------------------------------------------

function ga4AssertConfigured_() {
  ga4PropertyId_();
  ga4RequiredProperty_('HAIL_SITE_URL');
  ga4ArticlePathRegex_();
  ga4RequireAdvancedService_();
}

function ga4RequireAdvancedService_() {
  if (typeof AnalyticsData === 'undefined') {
    throw new Error(
      'Google Analytics Data API is not enabled. In Apps Script, open Services, click Add a service, and add Google Analytics Data API.'
    );
  }
}

function ga4PropertyId_() {
  const raw = ga4RequiredProperty_('GA4_PROPERTY_ID').replace(/^properties\//i, '');
  if (!/^\d+$/.test(raw)) {
    throw new Error('GA4_PROPERTY_ID must be the numeric Property ID, not the Measurement ID beginning with G-.');
  }
  return raw;
}

function ga4ArticlePathRegex_() {
  const raw = PropertiesService.getScriptProperties().getProperty('HAIL_ARTICLE_PATH_PATTERN') || '/a/';
  try {
    return new RegExp(raw, 'i');
  } catch (error) {
    throw new Error('HAIL_ARTICLE_PATH_PATTERN is not a valid JavaScript regular expression: ' + raw);
  }
}

function ga4BuildPageUrl_(hostName, pagePath) {
  let host = String(hostName || '').trim();
  if (!host || host === '(not set)') host = ga4HostFromUrl_(ga4RequiredProperty_('HAIL_SITE_URL'));
  if (!host) return '';
  const path = String(pagePath || '').charAt(0) === '/' ? String(pagePath) : '/' + String(pagePath || '');
  return 'https://' + host.replace(/^https?:\/\//i, '').replace(/\/$/, '') + path;
}

function ga4HostFromUrl_(url) {
  const match = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
  return match ? match[1] : '';
}

function ga4HtmlAttribute_(tag, attribute) {
  const regex = new RegExp('\\b' + attribute + '\\s*=\\s*(["\\\'])([\\s\\S]*?)\\1', 'i');
  const match = String(tag || '').match(regex);
  return match ? match[2] : '';
}

function ga4DecodeHtml_(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, function(match, number) { return String.fromCharCode(Number(number)); })
    .replace(/&#x([0-9a-f]+);/gi, function(match, number) { return String.fromCharCode(parseInt(number, 16)); })
    .replace(/\s+/g, ' ')
    .trim();
}

function ga4ReadablePath_(path) {
  const lastPart = String(path || '').replace(/\/$/, '').split('/').pop() || 'Untitled article';
  try { return decodeURIComponent(lastPart).replace(/[-_]+/g, ' '); } catch (ignored) { return lastPart; }
}

function ga4TrafficSort_(a, b) {
  const order = { week: 1, month: 2, year: 3 };
  const typeDifference = (order[String(a.period_type)] || 9) - (order[String(b.period_type)] || 9);
  if (typeDifference) return typeDifference;
  const aDate = ga4DateOnlyUtc_(a.period_start);
  const bDate = ga4DateOnlyUtc_(b.period_start);
  return (aDate ? aDate.getTime() : 0) - (bDate ? bDate.getTime() : 0);
}

function ga4SourceSort_(a, b) {
  const startDifference = ga4DateOnlyUtc_(a.period_start).getTime() - ga4DateOnlyUtc_(b.period_start).getTime();
  if (startDifference) return startDifference;
  const channelDifference = String(a.channel_group).localeCompare(String(b.channel_group));
  return channelDifference || String(a.source_medium).localeCompare(String(b.source_medium));
}

function ga4StartOfIsoWeek_(date) {
  const output = ga4DateOnlyUtc_(date);
  const day = output.getUTCDay() || 7;
  output.setUTCDate(output.getUTCDate() - day + 1);
  return output;
}

function ga4IsoWeekStartFromKey_(key) {
  const text = String(key || '');
  if (!/^\d{6}$/.test(text)) throw new Error('GA4 returned an invalid isoYearIsoWeek value: ' + text);
  const year = Number(text.slice(0, 4));
  const week = Number(text.slice(4));
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const januaryFourthDay = januaryFourth.getUTCDay() || 7;
  const firstMonday = ga4AddDaysUtc_(januaryFourth, 1 - januaryFourthDay);
  return ga4AddDaysUtc_(firstMonday, (week - 1) * 7);
}

function ga4MonthStartFromKey_(key) {
  const text = String(key || '');
  if (!/^\d{6}$/.test(text)) throw new Error('GA4 returned an invalid yearMonth value: ' + text);
  return new Date(Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4)) - 1, 1));
}

function ga4StartOfMonthUtc_(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function ga4AddMonthsUtc_(date, months) {
  const day = date.getUTCDate();
  const output = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(output.getUTCFullYear(), output.getUTCMonth() + 1, 0)).getUTCDate();
  output.setUTCDate(Math.min(day, lastDay));
  return output;
}

function ga4AddDaysUtc_(date, days) {
  const output = new Date(date.getTime());
  output.setUTCDate(output.getUTCDate() + days);
  return output;
}

function ga4YesterdayUtc_() {
  return ga4AddDaysUtc_(ga4TodayUtc_(), -1);
}

function ga4TodayUtc_() {
  const timezone = PropertiesService.getScriptProperties().getProperty('GA4_TIMEZONE') || Session.getScriptTimeZone();
  const text = Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
  return ga4DateOnlyUtc_(text);
}

function ga4DateOnlyUtc_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) return null;
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  const text = String(value).trim();
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnly) return new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function ga4DateText_(date) {
  return date ? Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd') : '';
}

function ga4MinDate_(a, b) {
  return a.getTime() <= b.getTime() ? a : b;
}

function ga4Number_(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  return isFinite(number) ? number : 0;
}

function ga4BooleanProperty_(key, defaultValue) {
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (raw === null) return defaultValue;
  return String(raw).toLowerCase() === 'true';
}

function ga4RequiredProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error('Missing Script Property ' + key + '. Add it in Project Settings > Script properties.');
  return value.trim();
}

function ga4FriendlyError_(error) {
  const message = error && error.message ? error.message : String(error);
  if (/AnalyticsData is not defined|not enabled/i.test(message)) {
    return new Error('Google Analytics Data API is not enabled in Apps Script. Add it under Services, then run testGA4Connection again.');
  }
  if (/permission|PERMISSION_DENIED|does not have sufficient permissions/i.test(message)) {
    return new Error(
      'The Apps Script account cannot read GA4 property ' + ga4PropertyId_() +
      '. Give this Google account Viewer access in GA4 Property access management. Original error: ' + message
    );
  }
  if (/not found|NOT_FOUND/i.test(message)) {
    return new Error('GA4 property ' + ga4PropertyId_() + ' was not found. Check that GA4_PROPERTY_ID is the numeric Property ID. Original error: ' + message);
  }
  return error instanceof Error ? error : new Error(message);
}

function ga4HandleError_(error, jobName) {
  const message = '[' + jobName + '] ' + (error && error.message ? error.message : String(error));
  Logger.log(message);
  PropertiesService.getScriptProperties().setProperty('LAST_GA4_ERROR', new Date().toISOString() + ' ' + message);
  const email = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL');
  if (email) MailApp.sendEmail(email, 'GA4 website analytics refresh failed', message);
}
