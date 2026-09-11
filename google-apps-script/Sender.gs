/**
 * Sender.net regular email campaign analytics -> Google Sheets
 *
 * Add this file to the same bound Apps Script project as Code.gs.
 * Set the Script Property SENDER_API_TOKEN, then run setupSenderAnalytics().
 *
 * Scope:
 *   - Regular email campaigns only
 *   - Weekly refresh and subscriber snapshot
 *   - Rolling 13 months of campaign detail (12 months plus comparison buffer)
 *   - No automation or transactional-email endpoints
 */

const SENDER_CONFIG = {
  API_BASE: 'https://api.sender.net/v2',
  CAMPAIGN_LOOKBACK_MONTHS: 13,
  PAGE_SIZE: 100,
  CAMPAIGN_TAB: 'sender_campaigns',
  SUBSCRIBER_TAB: 'sender_subscribers_weekly',
  CAMPAIGN_HEADERS: [
    'campaign_id', 'title', 'subject', 'sent_at', 'recipients', 'sends',
    'delivered', 'bounces', 'unique_opens', 'last_synced'
  ],
  SUBSCRIBER_HEADERS: [
    'week_ending', 'period_start', 'total_subscribers', 'new_subscribers',
    'unsubscribed', 'net_change', 'last_synced'
  ]
};

const SENDER_METRIC_HELP = {
  recipients: 'Contacts selected to receive this campaign.',
  sends: 'Email send attempts made by Sender.',
  delivered: 'Emails accepted by recipient mail servers; inbox placement is not guaranteed.',
  bounces: 'Emails that could not be delivered, including hard and soft bounces.',
  unique_opens: 'Individual recipients who opened at least once; each recipient counts once.',
  total_subscribers: 'Active subscribers at the end of the reporting period.',
  new_subscribers: 'Subscribers added during the reporting period.',
  unsubscribed: 'Subscribers who opted out during the reporting period.',
  net_change: 'Total subscriber change during the period.'
};

/** Creates the two compact tabs, verifies access, installs the trigger and syncs. */
function setupSenderAnalytics() {
  senderGetRequiredProperty_('SENDER_API_TOKEN');
  ensureSenderSheets_();
  testSenderConnection();
  createSenderWeeklyTrigger();
  return weeklySenderRefresh();
}

/** Verifies the token can list regular campaigns and subscribers. */
function testSenderConnection() {
  const campaigns = senderGet_('/campaigns', { page: 1, limit: 1 });
  const subscribers = senderGet_('/subscribers', { page: 1, limit: 1 });
  const result = {
    campaigns_visible: senderCollectionTotal_(campaigns),
    subscribers_visible: senderCollectionTotal_(subscribers)
  };
  Logger.log('Sender.net connected. Campaigns visible: ' + result.campaigns_visible +
    '; subscribers visible: ' + result.subscribers_visible);
  return result;
}

/**
 * Weekly entry point. Reconciles regular campaigns and writes one subscriber
 * snapshot for the current week. Running twice in a week updates the same row.
 */
function weeklySenderRefresh() {
  const startedAt = new Date();
  try {
    senderGetRequiredProperty_('SENDER_API_TOKEN');
    ensureSenderSheets_();

    const campaigns = fetchSenderCampaignAnalytics_();
    writeSenderCampaigns_(campaigns);

    const subscriberSnapshot = fetchSenderSubscriberSnapshot_();
    writeSenderSubscriberSnapshot_(subscriberSnapshot);

    const success = new Date().toISOString();
    PropertiesService.getScriptProperties().setProperty('LAST_SENDER_SUCCESS', success);
    Logger.log('Sender.net refresh complete. ' + campaigns.length +
      ' campaigns reconciled; ' + subscriberSnapshot.total_subscribers +
      ' active subscribers. Runtime seconds: ' + Math.round((new Date() - startedAt) / 1000));

    return { campaigns: campaigns.length, subscriber_snapshot: subscriberSnapshot };
  } catch (error) {
    handleSenderError_(error, 'weeklySenderRefresh');
    throw error;
  }
}

/** Replaces only this integration's trigger. */
function createSenderWeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'weeklySenderRefresh') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('weeklySenderRefresh')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(5)
    .create();
}

// ---------------------------------------------------------------------------
// Campaign collection
// ---------------------------------------------------------------------------

function fetchSenderCampaignAnalytics_() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - SENDER_CONFIG.CAMPAIGN_LOOKBACK_MONTHS);
  const listed = senderGetAllPages_('/campaigns', { limit: SENDER_CONFIG.PAGE_SIZE });
  const sentCampaigns = listed.filter(function(campaign) {
    if (String(campaign.status || '').toUpperCase() !== 'SENT') return false;
    const sentAt = senderParseDate_(campaign.sent_time || campaign.sent_at);
    return sentAt && sentAt >= cutoff;
  });

  return sentCampaigns.map(function(campaign) {
    const response = senderGet_('/campaigns/' + encodeURIComponent(campaign.id), {});
    const detail = response.data || response;
    const sends = senderFirstNumber_(detail, ['sent_count', 'sends', 'sent']);
    const bounces = senderFirstNumber_(detail, ['bounces_count', 'bounces', 'bounce_count']);
    const deliveredFromApi = senderFirstNullableNumber_(detail, ['delivered_count', 'delivered']);
    const delivered = deliveredFromApi === null ? Math.max(0, sends - bounces) : deliveredFromApi;
    const uniqueOpens = senderUniqueOpens_(detail);
    const sentAt = senderParseDate_(detail.sent_time || detail.sent_at || campaign.sent_time);

    return {
      campaign_id: String(detail.id || campaign.id),
      title: String(detail.title || detail.subject || '(Untitled campaign)'),
      subject: String(detail.subject || ''),
      sent_at: sentAt ? sentAt.toISOString() : '',
      recipients: senderFirstNumber_(detail, ['recipient_count', 'recipients']),
      sends: sends,
      delivered: delivered,
      bounces: bounces,
      unique_opens: uniqueOpens,
      last_synced: new Date().toISOString()
    };
  }).sort(function(a, b) { return a.sent_at.localeCompare(b.sent_at); });
}

/**
 * Sender's campaign detail response has historically called the unique count
 * `opens`. Prefer explicit unique fields when present, then use that documented
 * campaign-detail value. No individual recipient data is stored.
 */
function senderUniqueOpens_(detail) {
  const explicit = senderFirstNullableNumber_(detail, [
    'unique_opens', 'unique_opens_count', 'opens_unique'
  ]);
  if (explicit !== null) return explicit;
  return senderFirstNumber_(detail, ['opens', 'opened']);
}

function writeSenderCampaigns_(campaigns) {
  const rows = campaigns.map(function(campaign) {
    return SENDER_CONFIG.CAMPAIGN_HEADERS.map(function(header) { return campaign[header]; });
  });
  senderUpsertRows_(SENDER_CONFIG.CAMPAIGN_TAB, SENDER_CONFIG.CAMPAIGN_HEADERS, rows, 0);
  pruneSenderCampaigns_();
}

function pruneSenderCampaigns_() {
  const sheet = senderGetSheet_(SENDER_CONFIG.CAMPAIGN_TAB);
  const count = Math.max(0, sheet.getLastRow() - 1);
  if (!count) return;
  const rows = sheet.getRange(2, 1, count, SENDER_CONFIG.CAMPAIGN_HEADERS.length).getValues();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - SENDER_CONFIG.CAMPAIGN_LOOKBACK_MONTHS);
  const kept = rows.filter(function(row) {
    const sentAt = senderParseDate_(row[3]);
    return sentAt && sentAt >= cutoff;
  });
  sheet.getRange(2, 1, count, SENDER_CONFIG.CAMPAIGN_HEADERS.length).clearContent();
  if (kept.length) sheet.getRange(2, 1, kept.length, SENDER_CONFIG.CAMPAIGN_HEADERS.length).setValues(kept);
}

// ---------------------------------------------------------------------------
// Subscriber collection
// ---------------------------------------------------------------------------

/**
 * Reads subscriber records in memory to calculate counts. Email addresses and
 * profiles are never written to the spreadsheet.
 */
function fetchSenderSubscriberSnapshot_() {
  const subscribers = senderGetAllPages_('/subscribers', { limit: SENDER_CONFIG.PAGE_SIZE });
  const now = new Date();
  const weekEnding = senderLocalDate_(now);
  // Ignore an existing row for today so rerunning the job recalculates the same
  // interval instead of treating today's row as the previous snapshot.
  const previous = getPreviousSenderSubscriberSnapshot_(weekEnding);
  const periodStartDate = previous
    ? senderParseDate_(previous.week_ending)
    : new Date(now.getTime() - (7 * 86400000));
  // Do not double-count the previous snapshot day.
  if (previous) periodStartDate.setDate(periodStartDate.getDate() + 1);

  let active = 0;
  let newlyAdded = 0;
  let explicitUnsubscribed = 0;
  let hasUnsubscribeDates = false;

  subscribers.forEach(function(subscriber) {
    if (senderSubscriberIsActive_(subscriber)) active++;

    const createdAt = senderParseDate_(
      subscriber.created_at || subscriber.created || subscriber.subscribed_at
    );
    if (createdAt && createdAt >= periodStartDate && createdAt <= now) newlyAdded++;

    const unsubscribedAt = senderParseDate_(
      subscriber.unsubscribed_at || subscriber.unsubscribed || subscriber.opted_out_at
    );
    if (unsubscribedAt) {
      hasUnsubscribeDates = true;
      if (unsubscribedAt >= periodStartDate && unsubscribedAt <= now) explicitUnsubscribed++;
    }
  });

  const netChange = previous ? active - senderNumber_(previous.total_subscribers) : newlyAdded - explicitUnsubscribed;
  // If unsubscribe timestamps are absent, reconcile churn from opening total +
  // additions - closing total. This is the minimum number required to reconcile.
  const unsubscribed = hasUnsubscribeDates
    ? explicitUnsubscribed
    : Math.max(0, (previous ? senderNumber_(previous.total_subscribers) : active) + newlyAdded - active);

  return {
    week_ending: weekEnding,
    period_start: senderLocalDate_(periodStartDate),
    total_subscribers: active,
    new_subscribers: newlyAdded,
    unsubscribed: unsubscribed,
    net_change: netChange,
    last_synced: now.toISOString()
  };
}

function senderSubscriberIsActive_(subscriber) {
  const nestedEmailStatus = subscriber.email && typeof subscriber.email === 'object'
    ? subscriber.email.status : '';
  const status = String(
    subscriber.email_status || subscriber.subscriber_status || nestedEmailStatus || subscriber.status || ''
  ).toUpperCase();
  if (status) return ['ACTIVE', 'SUBSCRIBED', 'CONFIRMED'].indexOf(status) !== -1;
  return !(subscriber.unsubscribed_at || subscriber.unsubscribed || subscriber.opted_out_at || subscriber.deleted_at);
}

function writeSenderSubscriberSnapshot_(snapshot) {
  const row = SENDER_CONFIG.SUBSCRIBER_HEADERS.map(function(header) { return snapshot[header]; });
  senderUpsertRows_(SENDER_CONFIG.SUBSCRIBER_TAB, SENDER_CONFIG.SUBSCRIBER_HEADERS, [row], 0);
  pruneSenderSubscriberSnapshots_();
}

function getPreviousSenderSubscriberSnapshot_(currentDate) {
  const rows = senderReadRows_(SENDER_CONFIG.SUBSCRIBER_TAB, SENDER_CONFIG.SUBSCRIBER_HEADERS);
  const earlier = rows.filter(function(row) { return String(row.week_ending) < String(currentDate); });
  return earlier.length ? earlier[earlier.length - 1] : null;
}

function pruneSenderSubscriberSnapshots_() {
  const sheet = senderGetSheet_(SENDER_CONFIG.SUBSCRIBER_TAB);
  const count = Math.max(0, sheet.getLastRow() - 1);
  if (!count) return;
  const rows = sheet.getRange(2, 1, count, SENDER_CONFIG.SUBSCRIBER_HEADERS.length).getValues();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - SENDER_CONFIG.CAMPAIGN_LOOKBACK_MONTHS);
  const kept = rows.filter(function(row) {
    const date = senderParseDate_(row[0]);
    return date && date >= cutoff;
  });
  sheet.getRange(2, 1, count, SENDER_CONFIG.SUBSCRIBER_HEADERS.length).clearContent();
  if (kept.length) sheet.getRange(2, 1, kept.length, SENDER_CONFIG.SUBSCRIBER_HEADERS.length).setValues(kept);
}

// ---------------------------------------------------------------------------
// Dashboard data contract
// ---------------------------------------------------------------------------

/**
 * Returns compact Sender data for the later dashboard.
 * Dates are inclusive. Defaults to the last 30 days.
 */
function getSenderDashboardData(fromDate, toDate) {
  ensureSenderSheets_();
  const to = senderParseDate_(toDate) || new Date();
  const from = senderParseDate_(fromDate) || new Date(to.getTime() - (29 * 86400000));
  const endOfTo = new Date(to.getTime());
  endOfTo.setHours(23, 59, 59, 999);
  const periodDays = Math.max(1, Math.floor((endOfTo.getTime() - from.getTime()) / 86400000) + 1);
  const previousTo = new Date(from.getTime() - 1);
  const previousFrom = new Date(previousTo.getTime() - ((periodDays * 86400000) - 1));

  const allCampaigns = senderReadRows_(SENDER_CONFIG.CAMPAIGN_TAB, SENDER_CONFIG.CAMPAIGN_HEADERS)
    .map(senderNormalizeCampaignRow_);
  const campaigns = allCampaigns.filter(function(campaign) {
    const sentAt = senderParseDate_(campaign.sent_at);
    return sentAt && sentAt >= from && sentAt <= endOfTo;
  });
  const previousCampaigns = allCampaigns.filter(function(campaign) {
    const sentAt = senderParseDate_(campaign.sent_at);
    return sentAt && sentAt >= previousFrom && sentAt <= previousTo;
  });

  const subscriberRows = senderReadRows_(SENDER_CONFIG.SUBSCRIBER_TAB, SENDER_CONFIG.SUBSCRIBER_HEADERS)
    .map(senderNormalizeSubscriberRow_);
  const periodGrowth = subscriberRows.filter(function(row) {
    const date = senderParseDate_(row.week_ending);
    return date && date >= from && date <= endOfTo;
  });
  const previousGrowth = subscriberRows.filter(function(row) {
    const date = senderParseDate_(row.week_ending);
    return date && date >= previousFrom && date <= previousTo;
  });
  const twelveMonthCutoff = new Date(endOfTo.getTime());
  twelveMonthCutoff.setMonth(twelveMonthCutoff.getMonth() - 12);
  const lastTwelveMonths = subscriberRows.filter(function(row) {
    const date = senderParseDate_(row.week_ending);
    return date && date >= twelveMonthCutoff && date <= endOfTo;
  });
  const lastPeriodSnapshot = periodGrowth.length ? periodGrowth[periodGrowth.length - 1] : null;
  const previousPeriodSnapshot = previousGrowth.length ? previousGrowth[previousGrowth.length - 1] : null;

  return {
    period: { from: senderLocalDate_(from), to: senderLocalDate_(to), granularity: 'weekly' },
    metric_help: SENDER_METRIC_HELP,
    campaigns: campaigns,
    campaign_totals: sumSenderCampaigns_(campaigns),
    subscriber_growth: {
      selected_period: {
        total_subscribers: lastPeriodSnapshot ? lastPeriodSnapshot.total_subscribers : 0,
        new_subscribers: sumSenderField_(periodGrowth, 'new_subscribers'),
        unsubscribed: sumSenderField_(periodGrowth, 'unsubscribed'),
        net_change: sumSenderField_(periodGrowth, 'net_change')
      },
      selected_period_history: periodGrowth,
      last_12_months: lastTwelveMonths
    },
    comparison: {
      period: { from: senderLocalDate_(previousFrom), to: senderLocalDate_(previousTo) },
      campaign_totals: sumSenderCampaigns_(previousCampaigns),
      subscriber_growth: {
        total_subscribers: previousPeriodSnapshot ? previousPeriodSnapshot.total_subscribers : 0,
        new_subscribers: sumSenderField_(previousGrowth, 'new_subscribers'),
        unsubscribed: sumSenderField_(previousGrowth, 'unsubscribed'),
        net_change: sumSenderField_(previousGrowth, 'net_change')
      }
    },
    last_refreshed: PropertiesService.getScriptProperties().getProperty('LAST_SENDER_SUCCESS') || null
  };
}

function senderNormalizeCampaignRow_(row) {
  return {
    campaign_id: String(row.campaign_id || ''),
    title: String(row.title || ''),
    subject: String(row.subject || ''),
    sent_at: senderIsoDateTime_(row.sent_at),
    recipients: senderNumber_(row.recipients),
    sends: senderNumber_(row.sends),
    delivered: senderNumber_(row.delivered),
    bounces: senderNumber_(row.bounces),
    unique_opens: senderNumber_(row.unique_opens)
  };
}

function senderNormalizeSubscriberRow_(row) {
  return {
    week_ending: senderLocalDate_(senderParseDate_(row.week_ending)),
    period_start: senderLocalDate_(senderParseDate_(row.period_start)),
    total_subscribers: senderNumber_(row.total_subscribers),
    new_subscribers: senderNumber_(row.new_subscribers),
    unsubscribed: senderNumber_(row.unsubscribed),
    net_change: senderNumber_(row.net_change)
  };
}

function sumSenderCampaigns_(campaigns) {
  return campaigns.reduce(function(total, campaign) {
    total.total_campaigns++;
    total.recipients += campaign.recipients;
    total.sends += campaign.sends;
    total.delivered += campaign.delivered;
    total.bounces += campaign.bounces;
    total.unique_opens += campaign.unique_opens;
    return total;
  }, { total_campaigns: 0, recipients: 0, sends: 0, delivered: 0, bounces: 0, unique_opens: 0 });
}

function sumSenderField_(rows, field) {
  return rows.reduce(function(total, row) { return total + senderNumber_(row[field]); }, 0);
}

// ---------------------------------------------------------------------------
// Sender API, persistence and utilities
// ---------------------------------------------------------------------------

function senderGet_(path, parameters) {
  const token = senderGetRequiredProperty_('SENDER_API_TOKEN');
  const params = parameters || {};
  const query = Object.keys(params).map(function(key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
  }).join('&');
  const url = SENDER_CONFIG.API_BASE + path + (query ? '?' + query : '');
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  let body;
  try { body = JSON.parse(response.getContentText()); } catch (ignored) { body = {}; }
  if (status < 200 || status >= 300) {
    const detail = body.message || body.error || response.getContentText() || ('HTTP ' + status);
    throw new Error('Sender.net API request failed (' + status + ') for ' + path + ': ' + detail);
  }
  return body;
}

function senderGetAllPages_(path, parameters) {
  const all = [];
  let page = 1;
  let lastPage = 1;
  do {
    const params = Object.assign({}, parameters || {}, { page: page });
    const response = senderGet_(path, params);
    const data = Array.isArray(response.data) ? response.data : [];
    Array.prototype.push.apply(all, data);
    lastPage = response.meta && senderNumber_(response.meta.last_page)
      ? senderNumber_(response.meta.last_page)
      : (response.has_more_resources ? page + 1 : page);
    page++;
    if (page > 500) throw new Error('Sender.net pagination exceeded 500 pages for ' + path + '.');
  } while (page <= lastPage);
  return all;
}

function senderCollectionTotal_(response) {
  if (response && response.meta && response.meta.total !== undefined) return senderNumber_(response.meta.total);
  return response && Array.isArray(response.data) ? response.data.length : 0;
}

function ensureSenderSheets_() {
  senderEnsureSheet_(SENDER_CONFIG.CAMPAIGN_TAB, SENDER_CONFIG.CAMPAIGN_HEADERS);
  senderEnsureSheet_(SENDER_CONFIG.SUBSCRIBER_TAB, SENDER_CONFIG.SUBSCRIBER_HEADERS);
}

function senderEnsureSheet_(name, headers) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (current.join('|') !== headers.join('|')) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function senderUpsertRows_(tabName, headers, rows, keyIndex) {
  if (!rows.length) return;
  const sheet = senderGetSheet_(tabName);
  const existingCount = Math.max(0, sheet.getLastRow() - 1);
  const existing = existingCount ? sheet.getRange(2, 1, existingCount, headers.length).getValues() : [];
  const byKey = {};
  existing.forEach(function(row) { if (row[keyIndex] !== '') byKey[String(row[keyIndex])] = row; });
  rows.forEach(function(row) { byKey[String(row[keyIndex])] = row; });
  const merged = Object.keys(byKey).sort().map(function(key) { return byKey[key]; });
  if (existingCount) sheet.getRange(2, 1, existingCount, headers.length).clearContent();
  if (merged.length) sheet.getRange(2, 1, merged.length, headers.length).setValues(merged);
}

function senderReadRows_(tabName, headers) {
  const sheet = senderGetSheet_(tabName);
  const count = Math.max(0, sheet.getLastRow() - 1);
  if (!count) return [];
  return sheet.getRange(2, 1, count, headers.length).getValues()
    .filter(function(row) { return row[0] !== ''; })
    .map(function(row) {
      const object = {};
      headers.forEach(function(header, index) { object[header] = row[index]; });
      return object;
    })
    .sort(function(a, b) { return String(a[headers[0]]).localeCompare(String(b[headers[0]])); });
}

function senderGetSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Missing Sender analytics sheet: ' + name);
  return sheet;
}

function senderFirstNullableNumber_(object, fields) {
  for (let i = 0; i < fields.length; i++) {
    const value = object[fields[i]];
    if (value !== undefined && value !== null && value !== '') return senderNumber_(value);
  }
  return null;
}

function senderFirstNumber_(object, fields) {
  const value = senderFirstNullableNumber_(object, fields);
  return value === null ? 0 : value;
}

function senderNumber_(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  return isFinite(number) ? number : 0;
}

function senderParseDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  let text = String(value).trim();
  // Sender examples use UTC-like `YYYY-MM-DD HH:mm:ss`; make parsing stable.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) text = text.replace(' ', 'T') + 'Z';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00:00';
  const date = new Date(text);
  return isNaN(date.getTime()) ? null : date;
}

function senderIsoDateTime_(value) {
  const date = senderParseDate_(value);
  return date ? date.toISOString() : '';
}

function senderLocalDate_(date) {
  if (!date) return '';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function senderGetRequiredProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error('Missing Script Property ' + key + '. Add it in Project Settings > Script properties.');
  return value.trim();
}

function handleSenderError_(error, jobName) {
  const message = '[' + jobName + '] ' + (error && error.message ? error.message : String(error));
  Logger.log(message);
  PropertiesService.getScriptProperties().setProperty('LAST_SENDER_ERROR', new Date().toISOString() + ' ' + message);
  const email = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL');
  if (email) MailApp.sendEmail(email, 'Sender.net analytics refresh failed', message);
}
