(function () {
  'use strict';

  const DAY_MS = 86400000;
  const colours = {
    ink: '#123b34', facebook: '#365f9d', website: '#009245', email: '#e46e28',
    positive: '#00824c', negative: '#c2413b', pale: '#dce8e3', gold: '#d39b2a'
  };
  const numberFormat = new Intl.NumberFormat('en-NZ');
  const compactFormat = new Intl.NumberFormat('en-NZ', { notation: 'compact', maximumFractionDigits: 1 });
  const dateFormat = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
  const shortDateFormat = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short' });
  const state = {
    range: null,
    data: { facebook: null, ga4: null, sender: null },
    errors: [],
    charts: {},
    websiteGranularity: 'week',
    articleSort: 'views',
    campaignSort: 'date',
    sample: false
  };

  document.addEventListener('DOMContentLoaded', initialise);

  function initialise() {
    configureCharts();
    configureDates();
    bindEvents();
    state.range = rangeForPreset(byId('datePreset').value);
    void loadDashboard();
  }

  function configureCharts() {
    if (!window.Chart) return;
    Chart.defaults.font.family = 'Inter, ui-sans-serif, system-ui, sans-serif';
    const studioStyle = new URLSearchParams(window.location.search).get('style') === 'studio';
    Chart.defaults.color = studioStyle ? '#a8bbb6' : '#486581';
    Chart.defaults.borderColor = studioStyle ? 'rgba(177, 235, 217, 0.14)' : '#e6ecee';
    Chart.defaults.animation.duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450;
  }

  function configureDates() {
    const today = isoDate(new Date());
    byId('dateFrom').max = today;
    byId('dateTo').max = today;
    const initial = rangeForPreset('30');
    byId('dateFrom').value = initial.from;
    byId('dateTo').value = initial.to;
  }

  function bindEvents() {
    byId('datePreset').addEventListener('change', function (event) {
      const custom = event.target.value === 'custom';
      byId('customDates').hidden = !custom;
      if (!custom) {
        const range = rangeForPreset(event.target.value);
        byId('dateFrom').value = range.from;
        byId('dateTo').value = range.to;
      }
    });

    // Editing either date explicitly selects Custom dates so the dropdown cannot overwrite it.
    ['dateFrom', 'dateTo'].forEach(function (id) {
      byId(id).addEventListener('change', function () {
        byId('datePreset').value = 'custom';
        byId('customDates').hidden = false;
      });
    });

    byId('dateForm').addEventListener('submit', function (event) {
      event.preventDefault();
      const preset = byId('datePreset').value;
      const nextRange = preset === 'custom'
        ? { from: byId('dateFrom').value, to: byId('dateTo').value }
        : rangeForPreset(preset);
      if (!nextRange.from || !nextRange.to || nextRange.from > nextRange.to) {
        showErrors(['Choose a valid start and end date.']);
        return;
      }
      state.range = nextRange;
      state.websiteGranularity = preferredGranularity(nextRange);
      void loadDashboard();
    });

    byId('refreshButton').addEventListener('click', function () { void loadDashboard(); });
    byId('websiteGranularity').addEventListener('click', function (event) {
      const button = event.target.closest('[data-granularity]');
      if (!button) return;
      state.websiteGranularity = button.dataset.granularity;
      renderWebsite();
    });
    byId('articleSort').addEventListener('change', function (event) {
      state.articleSort = event.target.value;
      renderArticles((state.data.ga4 && state.data.ga4.recent_articles) || []);
    });
    byId('campaignSort').addEventListener('change', function (event) {
      state.campaignSort = event.target.value;
      renderCampaigns((state.data.sender && state.data.sender.campaigns) || []);
    });
  }

  async function loadDashboard() {
    setLoading(true);
    state.errors = [];
    updateRangeLabel();
    const config = window.BBCN_DASHBOARD_CONFIG || {};
    const baseUrl = String(config.appsScriptUrl || '').trim();

    if (!baseUrl) {
      if (config.useSampleDataWhenUnconfigured !== false) {
        state.data = createSampleData(state.range);
        state.sample = true;
        renderAll();
        setConnection('Sample data', '');
      } else {
        state.data = { facebook: null, ga4: null, sender: null };
        state.errors = ['Add your deployed Apps Script /exec URL to config.js.'];
        renderAll();
        setConnection('Not configured', 'error');
      }
      setLoading(false);
      return;
    }

    state.sample = false;
    const requests = [
      ['facebook', 'dashboard'],
      ['ga4', 'ga4'],
      ['sender', 'sender']
    ];
    const results = await Promise.allSettled(requests.map(function (entry) {
      return fetchResource(baseUrl, entry[1], state.range);
    }));

    results.forEach(function (result, index) {
      const source = requests[index][0];
      if (result.status === 'fulfilled') {
        state.data[source] = result.value;
      } else {
        state.data[source] = null;
        state.errors.push(labelForSource(source) + ': ' + friendlyError(result.reason));
      }
    });

    renderAll();
    setConnection(
      state.errors.length ? 'Partial data' : 'Live data',
      state.errors.length === requests.length ? 'error' : (state.errors.length ? '' : 'live')
    );
    setLoading(false);
  }

  async function fetchResource(baseUrl, resource, range) {
    let url;
    try { url = new URL(baseUrl); } catch (error) { throw new Error('The Apps Script URL in config.js is invalid.'); }
    url.searchParams.set('resource', resource);
    url.searchParams.set('from', range.from);
    url.searchParams.set('to', range.to);
    url.searchParams.set('_', Date.now().toString());
    const response = await fetch(url.toString(), { cache: 'no-store', redirect: 'follow' });
    if (!response.ok) throw new Error('Request returned HTTP ' + response.status + '.');
    const data = await response.json();
    if (data && data.error) throw new Error(String(data.error));
    return data;
  }

  function renderAll() {
    renderFacebook();
    renderWebsite();
    renderEmail();
    renderLastUpdated();
    const visibleErrors = state.errors.slice();
    if (!window.Chart) visibleErrors.push('Charts could not load. Check that cdn.jsdelivr.net is allowed by the browser or network.');
    showErrors(visibleErrors);
  }

  function renderFacebook() {
    const data = state.data.facebook;
    if (!data) {
      setTexts({ facebookTotal: '—', metricFollowers: '—', metricFollowersChange: '—', metricImpressions: '—', metricImpressionsChange: '—', facebookGained: '—', facebookLost: '—', facebookReach: '—', facebookEngagement: '—', engagementGaugeValue: '—' });
      ['followersChart', 'gainLossChart', 'visibilityChart', 'engagementChart', 'responseChart'].forEach(destroyChart);
      renderEmptyTable('facebookPostsBody', 9, 'Facebook data is unavailable.');
      return;
    }

    const followers = filterByDate(data.followers_evolution || [], 'date');
    const movement = filterByDate(data.gained_lost_followers_daily || [], 'date');
    const impressions = filterByDate(data.impressions_history || [], 'date');
    const reach = filterByDate(data.reach_history || [], 'date');
    const engagement = filterByDate(data.engagement_history || [], 'date');
    const reactions = filterByDate(data.reactions_history || [], 'date');
    const comments = filterByDate(data.comments_history || [], 'date');
    const rangedPosts = (data.recent_posts || []).filter(function (post) {
      const date = dateOnly(post.created_time);
      return date && date >= state.range.from && date <= state.range.to;
    });
    const derivedResponse = derivePostResponse(rangedPosts);
    const responseRows = derivedResponse.length ? derivedResponse : mergeDatedSeries(reactions, comments);
    const currentFollowers = followers.length ? numeric(followers[followers.length - 1].followers) : numeric(data.page_followers);
    const gained = movement.length ? sum(movement, 'gained') : numeric(data.gained_followers);
    const lost = movement.length ? sum(movement, 'lost') : numeric(data.lost_followers);
    const impressionTotal = impressions.length ? sum(impressions, 'impressions') : numeric(data.impressions);
    const reachTotal = reach.length ? sum(reach, 'reach') : numeric(data.reach);
    const derivedEngagement = reachTotal && rangedPosts.length
      ? rangedPosts.reduce(function (total, post) { return total + numeric(post.reactions) + numeric(post.comments) + numeric(post.shares); }, 0) / reachTotal * 100
      : 0;
    const latestEngagement = derivedEngagement || (engagement.length
      ? numeric(engagement[engagement.length - 1].engagement_rate)
      : numeric(data.engagement_rate));

    setTexts({
      facebookTotal: formatNumber(currentFollowers), metricFollowers: formatNumber(currentFollowers), metricImpressions: formatNumber(impressionTotal),
      facebookGained: formatSigned(gained), facebookLost: lost ? '−' + formatNumber(lost) : '0',
      facebookReach: formatNumber(reachTotal), facebookEngagement: formatPercent(latestEngagement),
      engagementGaugeValue: formatPercent(latestEngagement)
    });
    colourChange('facebookGained', gained);
    colourChange('facebookLost', -lost);
    const facebookComparison = data.comparison || {};
    renderComparison('metricFollowersChange', currentFollowers, facebookComparison.page_followers);
    renderComparison('metricImpressionsChange', impressionTotal, facebookComparison.impressions);

    renderLineChart('followersChart', 'followersEmpty', followers, [
      dataset('Followers', followers.map(function (row) { return numeric(row.followers); }), colours.facebook, true)
    ]);
    renderBarChart('gainLossChart', 'gainLossEmpty', movement, [
      dataset('Gained', movement.map(function (row) { return numeric(row.gained); }), colours.positive),
      dataset('Lost', movement.map(function (row) { return -numeric(row.lost); }), colours.negative)
    ]);
    renderLineChart('visibilityChart', 'visibilityEmpty', mergeDatedSeries(impressions, reach), [
      dataset('Impressions', valuesForDates(impressions, 'impressions', mergeDatedSeries(impressions, reach)), colours.facebook, true),
      dataset('Reach', valuesForDates(reach, 'reach', mergeDatedSeries(impressions, reach)), colours.website, true)
    ]);
    renderGauge(latestEngagement);
    renderBarChart('responseChart', 'responseEmpty', responseRows, [
      dataset('Reactions', valuesForDates(responseRows, 'reactions', responseRows), colours.facebook),
      dataset('Comments', valuesForDates(responseRows, 'comments', responseRows), colours.gold)
    ]);
    const topPosts = data.top_performing_posts || topPostsForRange(data.recent_posts || [], data.page_followers);
    renderFacebookPosts(topPostsForRange(rangedPosts, reachTotal));
    renderCommentPosts(rangedPosts);
  }

  function renderWebsite() {
    const data = state.data.ga4;
    updateGranularityButtons();
    if (!data) {
      setTexts({ metricWebsiteVisits: '—', metricWebsiteVisitsChange: '—', websiteSessions: '—', websiteViews: '—', websiteEngaged: '—', websiteEngagementRate: '—', sourceEmail: '—', sourceSocial: '—', sourceSearch: '—', sourceReferral: '—' });
      ['websiteTrafficChart', 'trafficSourcesChart'].forEach(destroyChart);
      toggleChart('websiteTrafficChart', 'websiteTrafficEmpty', false);
      toggleChart('trafficSourcesChart', 'trafficSourcesEmpty', false);
      renderEmptyTable('articlesBody', 5, 'Website data is unavailable.');
      renderEmptyTable('trafficSourcesBody', 4, 'Traffic-source data is unavailable.');
      return;
    }
    const bucket = state.websiteGranularity + 'ly';
    const rows = ((data.traffic && data.traffic[bucket]) || []).filter(periodOverlapsRange);
    const sessions = sum(rows, 'sessions');
    const views = sum(rows, 'views');
    const engaged = sum(rows, 'engaged_sessions');
    const rate = sessions ? engaged / sessions * 100 : 0;
    const comparisonRows = data.comparison && data.comparison.traffic
      ? (data.comparison.traffic[bucket] || [])
      : [];
    const comparisonSessions = sum(comparisonRows, 'sessions');
    setTexts({
      metricWebsiteVisits: formatNumber(sessions), websiteSessions: formatNumber(sessions), websiteViews: formatNumber(views),
      websiteEngaged: formatNumber(engaged), websiteEngagementRate: formatPercent(rate),
      websiteVisitsNote: capitalise(state.websiteGranularity) + 'ly reporting periods'
    });
    renderComparison('metricWebsiteVisitsChange', sessions, comparisonSessions);
    renderPeriodChart('websiteTrafficChart', 'websiteTrafficEmpty', rows, [
      dataset('Visits', rows.map(function (row) { return numeric(row.sessions); }), colours.website, true),
      dataset('Page views', rows.map(function (row) { return numeric(row.views); }), colours.facebook, true)
    ]);
    renderTrafficSources(data.traffic_sources || []);
    renderArticles(data.recent_articles || []);
  }

  function renderEmail() {
    const data = state.data.sender;
    if (!data) {
      setTexts({ metricDelivered: '—', metricDeliveredChange: '—', emailCampaigns: '—', emailRecipients: '—', emailSends: '—', emailDelivered: '—', emailOpens: '—', emailBounces: '—', subscriberTotal: '—', subscriberNew: '—', subscriberLost: '—', subscriberNet: '—' });
      ['campaignChart', 'subscriberChart'].forEach(destroyChart);
      renderEmptyTable('campaignsBody', 7, 'Email data is unavailable.');
      return;
    }
    applyMetricHelp(data.metric_help || {});
    // Re-filter defensively so stale endpoint totals cannot leak outside the selected period.
    const campaigns = (data.campaigns || []).filter(function (campaign) {
      const date = dateOnly(campaign.sent_at);
      return date && date >= state.range.from && date <= state.range.to;
    });
    const totals = totalCampaigns(campaigns);
    const growth = data.subscriber_growth || {};
    const selected = growth.selected_period || {};
    setTexts({
      metricDelivered: formatNumber(totals.delivered), emailCampaigns: formatNumber(totals.total_campaigns),
      emailRecipients: formatNumber(totals.total_campaigns ? totals.recipients / totals.total_campaigns : 0), emailSends: formatNumber(totals.sends), emailDelivered: formatNumber(totals.delivered),
      emailOpens: formatNumber(totals.unique_opens), emailBounces: formatNumber(totals.bounces),
      subscriberTotal: formatNumber(selected.total_subscribers), subscriberNew: formatSigned(selected.new_subscribers),
      subscriberLost: numeric(selected.unsubscribed) ? '−' + formatNumber(selected.unsubscribed) : '0',
      subscriberNet: formatSigned(selected.net_change)
    });
    colourChange('subscriberNew', numeric(selected.new_subscribers));
    colourChange('subscriberLost', -numeric(selected.unsubscribed));
    colourChange('subscriberNet', numeric(selected.net_change));
    const previousTotals = data.comparison && data.comparison.campaign_totals
      ? data.comparison.campaign_totals
      : {};
    renderComparison('metricDeliveredChange', totals.delivered, previousTotals.delivered);

    renderCampaignChart(campaigns);
    renderSubscriberChart((growth.last_12_months || []));
    renderCampaigns(campaigns);
  }

  function renderLineChart(canvasId, emptyId, rows, datasets) {
    renderDatedChart(canvasId, emptyId, rows, datasets, 'line');
  }

  function renderBarChart(canvasId, emptyId, rows, datasets) {
    renderDatedChart(canvasId, emptyId, rows, datasets, 'bar');
  }

  function renderDatedChart(canvasId, emptyId, rows, datasets, type) {
    const hasData = rows.length > 0;
    toggleChart(canvasId, emptyId, hasData);
    if (!hasData || !window.Chart) { destroyChart(canvasId); return; }
    drawChart(canvasId, {
      type: type,
      data: { labels: rows.map(function (row) { return formatShortDate(row.date); }), datasets: datasets },
      options: cartesianOptions(type === 'bar')
    });
  }

  function renderPeriodChart(canvasId, emptyId, rows, datasets) {
    const hasData = rows.length > 0;
    toggleChart(canvasId, emptyId, hasData);
    if (!hasData || !window.Chart) { destroyChart(canvasId); return; }
    drawChart(canvasId, {
      type: 'line',
      data: { labels: rows.map(function (row) { return periodLabel(row.period_start, state.websiteGranularity); }), datasets: datasets },
      options: cartesianOptions(false)
    });
  }

  function renderGauge(rate) {
    if (!window.Chart) return;
    const bounded = Math.max(0, Math.min(100, numeric(rate)));
    drawChart('engagementChart', {
      type: 'doughnut',
      data: { datasets: [{ data: [bounded, 100 - bounded], backgroundColor: [colours.facebook, '#e8edef'], borderWidth: 0, hoverOffset: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, circumference: 180, rotation: -90, cutout: '78%', plugins: { legend: { display: false }, tooltip: { enabled: false } } }
    });
  }

  function renderCampaignChart(campaigns) {
    const rows = campaigns.slice().sort(function (a, b) { return dateOnly(a.sent_at).localeCompare(dateOnly(b.sent_at)); });
    toggleChart('campaignChart', 'campaignEmpty', rows.length > 0);
    if (!rows.length || !window.Chart) { destroyChart('campaignChart'); return; }
    drawChart('campaignChart', {
      type: 'bar',
      data: {
        labels: rows.map(function (row) { return truncate(row.title || row.subject || 'Campaign', 25); }),
        datasets: [
          dataset('Delivered', rows.map(function (row) { return numeric(row.delivered); }), colours.email),
          dataset('Unique opens', rows.map(function (row) { return numeric(row.unique_opens); }), colours.website)
        ]
      },
      options: cartesianOptions(true)
    });
  }

  function renderSubscriberChart(rows) {
    const sorted = rows.slice().sort(function (a, b) { return String(a.week_ending).localeCompare(String(b.week_ending)); });
    toggleChart('subscriberChart', 'subscriberEmpty', sorted.length > 0);
    if (!sorted.length || !window.Chart) { destroyChart('subscriberChart'); return; }
    drawChart('subscriberChart', {
      data: {
        labels: sorted.map(function (row) { return formatShortDate(row.week_ending); }),
        datasets: [
          Object.assign(dataset('Total subscribers', sorted.map(function (row) { return numeric(row.total_subscribers); }), colours.email, true), { type: 'line', yAxisID: 'y' }),
          Object.assign(dataset('Net change', sorted.map(function (row) { return numeric(row.net_change); }), colours.website), { type: 'bar', yAxisID: 'change' })
        ]
      },
      options: Object.assign(cartesianOptions(false), {
        scales: {
          x: chartXAxis(),
          y: Object.assign(chartYAxis('left'), { title: { display: true, text: 'Total subscribers' } }),
          change: Object.assign(chartYAxis('right', true), { title: { display: true, text: 'Net change' } })
        }
      })
    });
  }

  function renderTrafficSources(rows) {
    const channels = {};
    const sources = {};
    rows.forEach(function (row) {
      const channel = normaliseChannel(row.channel_group);
      const source = String(row.source_medium || '(not set)');
      channels[channel] = (channels[channel] || 0) + numeric(row.sessions);
      const key = channel + '|' + source;
      if (!sources[key]) sources[key] = { channel: channel, source_medium: source, sessions: 0 };
      sources[key].sessions += numeric(row.sessions);
    });
    const channelRows = Object.keys(channels).map(function (channel) {
      return { channel: channel, sessions: channels[channel] };
    }).filter(function (row) { return row.sessions > 0; }).sort(function (a, b) { return b.sessions - a.sessions; });
    const total = channelRows.reduce(function (sumValue, row) { return sumValue + row.sessions; }, 0);

    setTexts({
      sourceEmail: formatNumber(channels.Email || 0),
      sourceSocial: formatNumber(channels.Social || 0),
      sourceSearch: formatNumber(channels.Search || 0),
      sourceReferral: formatNumber(channels.Referral || 0)
    });

    toggleChart('trafficSourcesChart', 'trafficSourcesEmpty', channelRows.length > 0);
    if (channelRows.length && window.Chart) {
      const palette = [colours.website, colours.facebook, colours.email, colours.gold, '#6f7fb7', '#6b8f83', '#9b6d4c'];
      drawChart('trafficSourcesChart', {
        type: 'doughnut',
        data: {
          labels: channelRows.map(function (row) { return row.channel; }),
          datasets: [{ data: channelRows.map(function (row) { return row.sessions; }), backgroundColor: channelRows.map(function (_, index) { return palette[index % palette.length]; }), borderColor: '#ffffff', borderWidth: 3, hoverOffset: 5 }]
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 15 } } } }
      });
    } else destroyChart('trafficSourcesChart');

    const body = clearBody('trafficSourcesBody');
    const sourceRows = Object.keys(sources).map(function (key) { return sources[key]; })
      .sort(function (a, b) { return b.sessions - a.sessions; }).slice(0, 8);
    if (!sourceRows.length) { appendEmptyRow(body, 4, 'Run the updated GA4 refresh to populate traffic sources.'); return; }
    sourceRows.forEach(function (source) {
      const row = document.createElement('tr');
      appendTextCell(row, source.channel);
      appendTextCell(row, source.source_medium);
      appendNumberCell(row, source.sessions);
      appendPercentCell(row, total ? source.sessions / total * 100 : 0);
      body.appendChild(row);
    });
  }

  function renderCommentPosts(posts) {
    const body = clearBody('facebookCommentPostsBody');
    const rows = posts.filter(function (post) { return numeric(post.comments) > 0; })
      .sort(function (a, b) { return numeric(b.comments) - numeric(a.comments); });
    if (!rows.length) { appendEmptyRow(body, 4, 'No posts with comments were found for these dates.'); return; }
    rows.slice(0, 10).forEach(function (post, index) {
      const row = document.createElement('tr');
      appendNumberCell(row, index + 1);
      appendPostLinkCell(row, post);
      appendTextCell(row, post.created_time ? formatDate(post.created_time) : '—');
      appendNumberCell(row, post.comments);
      body.appendChild(row);
    });
  }

  function appendPostLinkCell(row, post) {
    const cell = document.createElement('td');
    const label = document.createElement('span');
    label.className = 'post-link';
    label.textContent = cleanPostLabel(post.message || 'Facebook post');
    if (isSafeWebUrl(post.permalink_url)) {
      const link = document.createElement('a');
      link.className = 'post-link'; link.href = post.permalink_url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.appendChild(label); cell.appendChild(link);
    } else cell.appendChild(label);
    const id = document.createElement('small'); id.textContent = post.post_id || ''; cell.appendChild(id);
    row.appendChild(cell);
  }

  function cleanPostLabel(value) {
    const cleaned = String(value || '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
    return truncate(cleaned || 'Facebook post', 92);
  }
  function renderFacebookPosts(posts) {
    const body = clearBody('facebookPostsBody');
    if (!posts.length) { appendEmptyRow(body, 9, 'No dated Facebook posts are available for this period.'); return; }
    posts.slice(0, 5).forEach(function (post, index) {
      const row = document.createElement('tr');
      appendNumberCell(row, index + 1);
      const postCell = document.createElement('td');
      const label = cleanPostLabel(post.message || 'Facebook post');
      if (isSafeWebUrl(post.permalink_url)) {
        const link = document.createElement('a');
        link.className = 'post-link'; link.href = post.permalink_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = label;
        postCell.appendChild(link);
      } else {
        const title = document.createElement('span'); title.className = 'post-link'; title.textContent = label; postCell.appendChild(title);
      }
      const id = document.createElement('small'); id.textContent = post.post_id || ''; postCell.appendChild(id);
      row.appendChild(postCell);
      appendTextCell(row, post.created_time ? formatDate(post.created_time) : '—');
      appendNumberCell(row, post.views || post.reach || post._post_media_views);
      appendNumberCell(row, post.reactions);
      appendNumberCell(row, post.comments);
      appendNumberCell(row, post.shares);
      const score = numeric(post.total_engagement) || numeric(post.reactions) + numeric(post.comments) + numeric(post.shares);
      appendNumberCell(row, score);
      appendPercentCell(row, numeric(post.engagement_rate));
      body.appendChild(row);
    });
  }

  function topPostsForRange(posts, followers) {
    return posts.filter(function (post) {
      const date = dateOnly(post.created_time);
      return !date || (date >= state.range.from && date <= state.range.to);
    }).map(function (post) {
      const score = numeric(post.reactions) + numeric(post.comments) + numeric(post.shares);
      return Object.assign({}, post, {
        total_engagement: score,
        engagement_rate: numeric(followers) ? score / numeric(followers) * 100 : 0
      });
    }).sort(function (a, b) {
      return numeric(b.total_engagement) - numeric(a.total_engagement);
    }).slice(0, 5);
  }

  function normaliseChannel(value) {
    const channel = String(value || 'Unassigned');
    if (/email/i.test(channel)) return 'Email';
    if (/social/i.test(channel)) return 'Social';
    if (/search/i.test(channel)) return 'Search';
    if (/referral|affiliate/i.test(channel)) return 'Referral';
    if (/direct/i.test(channel)) return 'Direct';
    if (/video/i.test(channel)) return 'Video';
    return channel === '(not set)' ? 'Unassigned' : channel;
  }

  function renderArticles(articles) {
    const body = clearBody('articlesBody');
    let rows = articles.slice();
    if (state.articleSort === 'date') rows.sort(function (a, b) { return String(b.publication_date).localeCompare(String(a.publication_date)); });
    else if (state.articleSort === 'title') rows.sort(function (a, b) { return String(a.article_title).localeCompare(String(b.article_title)); });
    else rows.sort(function (a, b) { return numeric(b.views) - numeric(a.views); });
    if (!rows.length) { appendEmptyRow(body, 5, 'No recent Hail articles are available.'); return; }
    rows.forEach(function (article) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      const label = article.article_title || 'Untitled article';
      if (isSafeWebUrl(article.article_url)) {
        const link = document.createElement('a');
        link.className = 'article-link'; link.href = article.article_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = label;
        cell.appendChild(link);
      } else cell.textContent = label;
      row.appendChild(cell);
      appendTextCell(row, article.publication_date ? formatDate(article.publication_date) : '—');
      appendNumberCell(row, article.views); appendNumberCell(row, article.sessions); appendNumberCell(row, article.users);
      body.appendChild(row);
    });
  }

  function renderCampaigns(campaigns) {
    const body = clearBody('campaignsBody');
    const rows = campaigns.slice();
    if (state.campaignSort === 'delivered') rows.sort(function (a, b) { return numeric(b.delivered) - numeric(a.delivered); });
    else if (state.campaignSort === 'opens') rows.sort(function (a, b) { return numeric(b.unique_opens) - numeric(a.unique_opens); });
    else rows.sort(function (a, b) { return dateOnly(b.sent_at).localeCompare(dateOnly(a.sent_at)); });
    if (!rows.length) { appendEmptyRow(body, 7, 'No regular campaigns were sent during these dates.'); return; }
    rows.forEach(function (campaign) {
      const row = document.createElement('tr');
      appendTextCell(row, campaign.title || campaign.subject || 'Untitled campaign');
      appendTextCell(row, campaign.sent_at ? formatDate(campaign.sent_at) : '—');
      appendNumberCell(row, campaign.recipients); appendNumberCell(row, campaign.sends);
      appendNumberCell(row, campaign.delivered); appendNumberCell(row, campaign.bounces); appendNumberCell(row, campaign.unique_opens);
      body.appendChild(row);
    });
  }

  function drawChart(id, configuration) {
    destroyChart(id);
    state.charts[id] = new Chart(byId(id), configuration);
  }

  function destroyChart(id) {
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
  }

  function dataset(label, data, colour, filled) {
    return {
      label: label, data: data, borderColor: colour, backgroundColor: filled ? hexToRgba(colour, 0.12) : colour,
      fill: Boolean(filled), tension: 0.3, borderWidth: 2, pointRadius: data.length > 45 ? 0 : 2, pointHoverRadius: 4,
      borderRadius: 4, maxBarThickness: 32
    };
  }

  function cartesianOptions(beginAtZero) {
    return {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 18 } }, tooltip: { displayColors: true } },
      scales: { x: chartXAxis(), y: chartYAxis('left', beginAtZero) }
    };
  }

  function chartXAxis() {
    return { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } };
  }

  function chartYAxis(position, beginAtZero) {
    return {
      position: position, beginAtZero: Boolean(beginAtZero), grid: { color: '#e8edef' },
      ticks: { callback: function (value) { return compactFormat.format(value); } },
      border: { display: false }
    };
  }

  function toggleChart(canvasId, emptyId, hasData) {
    byId(canvasId).parentElement.hidden = !hasData;
    if (emptyId) byId(emptyId).hidden = hasData;
  }

  function filterByDate(rows, field) {
    return rows.filter(function (row) {
      const date = dateOnly(row[field]);
      return date && date >= state.range.from && date <= state.range.to;
    }).sort(function (a, b) { return dateOnly(a[field]).localeCompare(dateOnly(b[field])); });
  }

  function periodOverlapsRange(row) {
    return dateOnly(row.period_end) >= state.range.from && dateOnly(row.period_start) <= state.range.to;
  }

  function mergeDatedSeries() {
    const byDate = {};
    Array.prototype.slice.call(arguments).forEach(function (rows) {
      rows.forEach(function (row) { if (row.date) byDate[dateOnly(row.date)] = { date: dateOnly(row.date) }; });
    });
    return Object.keys(byDate).sort().map(function (date) { return byDate[date]; });
  }

  function derivePostResponse(posts) {
    const byDate = {};
    posts.forEach(function (post) {
      const date = dateOnly(post.created_time);
      if (!date) return;
      if (!byDate[date]) byDate[date] = { date: date, reactions: 0, comments: 0 };
      byDate[date].reactions += numeric(post.reactions);
      byDate[date].comments += numeric(post.comments);
    });
    return Object.keys(byDate).sort().map(function (date) { return byDate[date]; });
  }
  function valuesForDates(rows, field, dates) {
    const lookup = {};
    rows.forEach(function (row) { lookup[dateOnly(row.date)] = numeric(row[field]); });
    return dates.map(function (row) { return lookup[row.date] || 0; });
  }

  function totalCampaigns(campaigns) {
    return {
      total_campaigns: campaigns.length, recipients: sum(campaigns, 'recipients'), sends: sum(campaigns, 'sends'),
      delivered: sum(campaigns, 'delivered'), bounces: sum(campaigns, 'bounces'), unique_opens: sum(campaigns, 'unique_opens')
    };
  }

  function renderLastUpdated() {
    const dates = ['facebook', 'ga4', 'sender'].map(function (source) {
      const value = state.data[source] && state.data[source].last_refreshed;
      const parsed = value ? new Date(value) : null;
      return parsed && !isNaN(parsed.getTime()) ? parsed : null;
    }).filter(Boolean);
    byId('lastUpdated').textContent = state.sample
      ? 'Previewing sample data'
      : (dates.length ? 'Latest source refresh: ' + new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(Math.max.apply(null, dates))) : 'Refresh time unavailable');
  }

  function applyMetricHelp(help) {
    document.querySelectorAll('[data-metric-help]').forEach(function (element) {
      const key = element.dataset.metricHelp;
      element.dataset.tooltip = help[key] || defaultMetricHelp(key);
      element.setAttribute('aria-label', element.dataset.tooltip);
    });
  }

  function defaultMetricHelp(key) {
    const help = {
      recipients: 'Subscribers selected to receive the campaign.',
      sends: 'Messages Sender attempted to send for the campaign.',
      delivered: 'Messages accepted by receiving mail servers.',
      unique_opens: 'Individual recipients who opened at least once.',
      bounces: 'Messages that could not be delivered.'
    };
    return help[key] || '';
  }

  function updateGranularityButtons() {
    document.querySelectorAll('[data-granularity]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.granularity === state.websiteGranularity));
    });
  }

  function updateRangeLabel() {
    byId('selectedRange').textContent = formatDate(state.range.from) + ' – ' + formatDate(state.range.to);
  }

  function setLoading(isLoading) {
    byId('dashboard').classList.toggle('is-loading', isLoading);
    byId('dashboard').setAttribute('aria-busy', String(isLoading));
    byId('refreshButton').disabled = isLoading;
    byId('dateForm').querySelector('button[type="submit"]').disabled = isLoading;
    if (isLoading) setConnection('Loading data', '');
  }

  function setConnection(text, status) {
    const element = byId('connectionState');
    element.classList.toggle('is-live', status === 'live');
    element.classList.toggle('is-error', status === 'error');
    element.querySelector('span:last-child').textContent = text;
  }

  function showErrors(errors) {
    const notice = byId('errorNotice');
    notice.hidden = !errors.length;
    byId('errorMessage').textContent = errors.join(' ');
  }

  function preferredGranularity(range) {
    const days = Math.round((parseDate(range.to) - parseDate(range.from)) / DAY_MS) + 1;
    if (days <= 120) return 'week';
    if (days <= 730) return 'month';
    return 'year';
  }

  function rangeForPreset(preset) {
    const to = new Date();
    let from = new Date(to.getTime());
    if (preset === 'year') from = new Date(to.getFullYear(), 0, 1);
    else from.setDate(from.getDate() - (Math.max(1, Number(preset) || 30) - 1));
    return { from: isoDate(from), to: isoDate(to) };
  }

  function createSampleData(range) {
    const from = parseDate(range.from);
    const to = parseDate(range.to);
    const totalDays = Math.max(1, Math.round((to - from) / DAY_MS) + 1);
    const facebookDays = Math.min(totalDays, 365);
    const followerRows = [], movement = [], impressions = [], reach = [], engagement = [], reactions = [], comments = [];
    let followers = 1840;
    for (let i = facebookDays - 1; i >= 0; i--) {
      const date = new Date(to.getTime() - i * DAY_MS);
      const gained = 1 + ((i * 7) % 5);
      const lost = i % 6 === 0 ? 2 : i % 4 === 0 ? 1 : 0;
      followers += gained - lost;
      const wave = Math.round(120 * Math.sin(i / 5));
      followerRows.push({ date: isoDate(date), followers: followers });
      movement.push({ date: isoDate(date), gained: gained, lost: lost });
      impressions.push({ date: isoDate(date), impressions: 620 + wave + (i % 7) * 35 });
      reach.push({ date: isoDate(date), reach: 390 + Math.round(wave * 0.65) + (i % 5) * 18 });
      engagement.push({ date: isoDate(date), engagement_rate: 3.1 + (i % 8) * 0.18 });
      reactions.push({ date: isoDate(date), reactions: 13 + (i * 3) % 28 });
      comments.push({ date: isoDate(date), comments: 2 + (i * 5) % 9 });
    }
    const traffic = sampleTraffic(from, to);
    const comparisonTraffic = scaleTraffic(traffic, 0.91);
    const trafficSources = sampleTrafficSources(from, to);
    const campaigns = sampleCampaigns(from, to);
    const subscriberRows = sampleSubscribers(to);
    const selectedSubscribers = subscriberRows.filter(function (row) { return row.week_ending >= range.from && row.week_ending <= range.to; });
    const campaignTotals = totalCampaigns(campaigns);
    const samplePosts = [
      { post_id: '672538469286525_104892', message: 'Neighbourhood garden day brings locals together', permalink_url: 'https://www.facebook.com/', media_available: true, reactions: 86, comments: 13, shares: 18, created_time: sampleDateWithinRange(from, to, 0.14) },
      { post_id: '672538469286525_104817', message: 'What is happening around Burnside and Bryndwr this weekend', permalink_url: 'https://www.facebook.com/', media_available: true, reactions: 72, comments: 9, shares: 14, created_time: sampleDateWithinRange(from, to, 0.32) },
      { post_id: '672538469286525_104741', message: 'Community centre programme and upcoming activities', permalink_url: 'https://www.facebook.com/', media_available: true, reactions: 54, comments: 7, shares: 9, created_time: sampleDateWithinRange(from, to, 0.5) },
      { post_id: '672538469286525_104669', message: 'Thank you to our local food pantry volunteers', permalink_url: 'https://www.facebook.com/', media_available: true, reactions: 43, comments: 11, shares: 7, created_time: sampleDateWithinRange(from, to, 0.68) },
      { post_id: '672538469286525_104581', message: 'School holiday activities for local families', permalink_url: 'https://www.facebook.com/', media_available: false, reactions: 31, comments: 4, shares: 6, created_time: sampleDateWithinRange(from, to, 0.84) }
    ].map(function (post) {
      const score = post.reactions + post.comments + post.shares;
      return Object.assign({}, post, { total_engagement: score, engagement_rate: score / followers * 100 });
    });
    return {
      facebook: {
        page_followers: followers, followers_evolution: followerRows, gained_followers: sum(movement, 'gained'), lost_followers: sum(movement, 'lost'),
        gained_lost_followers_daily: movement, impressions: sum(impressions, 'impressions'), reach: sum(reach, 'reach'),
        engagement_rate: engagement[engagement.length - 1].engagement_rate, impressions_history: impressions, reach_history: reach,
        engagement_history: engagement, reactions_history: reactions, comments_history: comments,
        recent_posts: samplePosts, top_performing_posts: samplePosts,
        comparison: { page_followers: Math.round(followers * 0.985), impressions: Math.round(sum(impressions, 'impressions') * 0.88) },
        last_refreshed: new Date().toISOString()
      },
      ga4: {
        traffic: traffic,
        traffic_sources: trafficSources,
        comparison: { traffic: comparisonTraffic },
        recent_articles: sampleArticles(to),
        last_refreshed: new Date().toISOString()
      },
      sender: {
        metric_help: {}, campaigns: campaigns, campaign_totals: campaignTotals,
        subscriber_growth: {
          selected_period: {
            total_subscribers: subscriberRows.length ? subscriberRows[subscriberRows.length - 1].total_subscribers : 0,
            new_subscribers: sum(selectedSubscribers, 'new_subscribers'), unsubscribed: sum(selectedSubscribers, 'unsubscribed'), net_change: sum(selectedSubscribers, 'net_change')
          },
          last_12_months: subscriberRows
        },
        comparison: {
          campaign_totals: {
            total_campaigns: Math.max(0, campaignTotals.total_campaigns - 1),
            recipients: Math.round(campaignTotals.recipients * 0.9),
            sends: Math.round(campaignTotals.sends * 0.9),
            delivered: Math.round(campaignTotals.delivered * 0.9),
            bounces: Math.round(campaignTotals.bounces * 1.05),
            unique_opens: Math.round(campaignTotals.unique_opens * 0.86)
          }
        },
        last_refreshed: new Date().toISOString()
      }
    };
  }

  function scaleTraffic(traffic, factor) {
    const output = {};
    Object.keys(traffic).forEach(function (bucket) {
      output[bucket] = traffic[bucket].map(function (row) {
        return Object.assign({}, row, {
          sessions: Math.round(row.sessions * factor),
          users: Math.round(row.users * factor),
          views: Math.round(row.views * factor),
          engaged_sessions: Math.round(row.engaged_sessions * factor)
        });
      });
    });
    return output;
  }

  function sampleTrafficSources(from, to) {
    const channels = [
      ['Organic Search', 'google / organic', 520],
      ['Direct', '(direct) / (none)', 350],
      ['Organic Social', 'facebook.com / referral', 245],
      ['Email', 'sender / email', 190],
      ['Referral', 'ccc.govt.nz / referral', 115]
    ];
    return channels.map(function (channel, index) {
      return {
        period_start: isoDate(from), period_end: isoDate(to), period_type: 'week',
        channel_group: channel[0], source_medium: channel[1], sessions: channel[2],
        users: Math.round(channel[2] * 0.76), views: Math.round(channel[2] * 1.55),
        engaged_sessions: Math.round(channel[2] * (0.64 - index * 0.025))
      };
    });
  }

  function sampleDateWithinRange(from, to, fraction) {
    return new Date(to.getTime() - Math.round((to.getTime() - from.getTime()) * fraction)).toISOString();
  }

  function sampleTraffic(from, to) {
    const weekly = [], monthly = [], yearly = [];
    let cursor = new Date(from.getTime());
    let index = 0;
    while (cursor <= to) {
      const end = new Date(Math.min(to.getTime(), cursor.getTime() + 6 * DAY_MS));
      const sessions = 260 + (index % 5) * 34 + Math.round(35 * Math.sin(index / 2));
      weekly.push({ period_start: isoDate(cursor), period_end: isoDate(end), period_type: 'week', sessions: sessions, users: Math.round(sessions * 0.72), views: Math.round(sessions * 1.62), engaged_sessions: Math.round(sessions * 0.61) });
      cursor = new Date(end.getTime() + DAY_MS); index++;
    }
    const months = {};
    weekly.forEach(function (row) {
      const key = row.period_start.slice(0, 7);
      if (!months[key]) months[key] = { period_start: key + '-01', period_end: row.period_end, period_type: 'month', sessions: 0, users: 0, views: 0, engaged_sessions: 0 };
      ['sessions', 'users', 'views', 'engaged_sessions'].forEach(function (field) { months[key][field] += row[field]; });
      months[key].period_end = row.period_end;
    });
    Object.keys(months).sort().forEach(function (key) { monthly.push(months[key]); });
    const years = {};
    monthly.forEach(function (row) {
      const key = row.period_start.slice(0, 4);
      if (!years[key]) years[key] = { period_start: key + '-01-01', period_end: row.period_end, period_type: 'year', sessions: 0, users: 0, views: 0, engaged_sessions: 0 };
      ['sessions', 'users', 'views', 'engaged_sessions'].forEach(function (field) { years[key][field] += row[field]; });
      years[key].period_end = row.period_end;
    });
    Object.keys(years).sort().forEach(function (key) { yearly.push(years[key]); });
    return { weekly: weekly, monthly: monthly, yearly: yearly };
  }

  function sampleArticles(to) {
    const titles = ['Neighbourhood garden day brings locals together', 'Community centre spring programme', 'Meet the volunteers behind the food pantry', 'Local paths and parks update', 'School holiday activities around Burnside'];
    return titles.map(function (title, index) {
      return { article_url: 'https://hail.to/', article_title: title, publication_date: isoDate(new Date(to.getTime() - (index * 24 + 8) * DAY_MS)), views: 780 - index * 91, sessions: 510 - index * 58, users: 430 - index * 49, engaged_sessions: 330 - index * 37 };
    });
  }

  function sampleCampaigns(from, to) {
    const titles = ['Community update', 'Events this month', 'Volunteer news', 'Neighbourhood notice', 'Weekend guide', 'BBCN newsletter'];
    return titles.map(function (title, index) {
      const sent = new Date(to.getTime() - index * 18 * DAY_MS);
      if (sent < from) return null;
      const recipients = 1780 + index * 21;
      return { campaign_id: 'sample-' + index, title: title, subject: title, sent_at: sent.toISOString(), recipients: recipients, sends: recipients, delivered: recipients - 18 - index * 2, bounces: 18 + index * 2, unique_opens: Math.round(recipients * (0.47 - index * 0.012)) };
    }).filter(Boolean);
  }

  function sampleSubscribers(to) {
    const rows = [];
    let total = 1650;
    for (let i = 51; i >= 0; i--) {
      const date = new Date(to.getTime() - i * 7 * DAY_MS);
      const added = 8 + (i * 3) % 11;
      const lost = 2 + (i * 5) % 5;
      const net = added - lost;
      total += net;
      rows.push({ week_ending: isoDate(date), period_start: isoDate(new Date(date.getTime() - 6 * DAY_MS)), total_subscribers: total, new_subscribers: added, unsubscribed: lost, net_change: net });
    }
    return rows;
  }

  function setTexts(values) { Object.keys(values).forEach(function (id) { byId(id).textContent = values[id]; }); }
  function renderComparison(id, current, previous) {
    const element = byId(id);
    const prior = numeric(previous);
    element.classList.remove('positive', 'negative');
    if (previous === undefined || previous === null || prior === 0) {
      element.textContent = 'No prior-period data';
      return;
    }
    const change = (numeric(current) - prior) / Math.abs(prior) * 100;
    element.textContent = (change > 0 ? '↑ ' : change < 0 ? '↓ ' : '') + Math.abs(change).toLocaleString('en-NZ', { maximumFractionDigits: 1 }) + '% vs prior period';
    element.classList.toggle('positive', change > 0);
    element.classList.toggle('negative', change < 0);
  }
  function sum(rows, field) { return rows.reduce(function (total, row) { return total + numeric(row[field]); }, 0); }
  function numeric(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
  function formatNumber(value) { return numberFormat.format(Math.round(numeric(value))); }
  function formatSigned(value) { const number = numeric(value); return (number > 0 ? '+' : number < 0 ? '−' : '') + formatNumber(Math.abs(number)); }
  function formatPercent(value) { return numeric(value).toLocaleString('en-NZ', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%'; }
  function formatDate(value) { const date = parseDate(value); return date && !isNaN(date.getTime()) ? dateFormat.format(date) : '—'; }
  function formatShortDate(value) { const date = parseDate(value); return date && !isNaN(date.getTime()) ? shortDateFormat.format(date) : ''; }
  function periodLabel(value, granularity) { const date = parseDate(value); if (!date) return ''; return granularity === 'year' ? String(date.getFullYear()) : granularity === 'month' ? new Intl.DateTimeFormat('en-NZ', { month: 'short', year: '2-digit' }).format(date) : shortDateFormat.format(date); }
  function isoDate(date) { return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-'); }
  function pad(value) { return String(value).padStart(2, '0'); }
  function parseDate(value) { const text = dateOnly(value); return text ? new Date(text + 'T12:00:00') : null; }
  function dateOnly(value) {
    const text = String(value || '').trim();
    const isoMatch = text.match(/^\d{4}-\d{2}-\d{2}/);
    if (isoMatch) return isoMatch[0];
    const sheetDate = text.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);
    if (!sheetDate) return '';
    const month = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }[sheetDate[1]];
    return month ? sheetDate[3] + '-' + month + '-' + String(sheetDate[2]).padStart(2, '0') : '';
  }
  function capitalise(value) { return value.charAt(0).toUpperCase() + value.slice(1); }
  function truncate(value, length) { return String(value).length > length ? String(value).slice(0, length - 1) + '…' : String(value); }
  function hexToRgba(hex, alpha) { const number = parseInt(hex.slice(1), 16); return 'rgba(' + (number >> 16) + ',' + ((number >> 8) & 255) + ',' + (number & 255) + ',' + alpha + ')'; }
  function isSafeWebUrl(value) { try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch (error) { return false; } }
  function byId(id) { return document.getElementById(id); }
  function labelForSource(source) { return { facebook: 'Facebook', ga4: 'Website', sender: 'Email' }[source] || source; }
  function friendlyError(error) { return error && error.message ? error.message : 'Unknown loading error.'; }

  function colourChange(id, value) {
    const element = byId(id);
    element.classList.toggle('positive', numeric(value) > 0);
    element.classList.toggle('negative', numeric(value) < 0);
  }

  function clearBody(id) { const body = byId(id); body.replaceChildren(); return body; }
  function renderEmptyTable(id, columns, message) { appendEmptyRow(clearBody(id), columns, message); }
  function appendEmptyRow(body, columns, message) { const row = document.createElement('tr'); row.className = 'empty-row'; const cell = document.createElement('td'); cell.colSpan = columns; cell.textContent = message; row.appendChild(cell); body.appendChild(row); }
  function appendTextCell(row, value, className) { const cell = document.createElement('td'); const target = className ? document.createElement('span') : cell; if (className) { target.className = className; cell.appendChild(target); } target.textContent = value; row.appendChild(cell); }
  function appendNumberCell(row, value) { const cell = document.createElement('td'); cell.className = 'numeric'; cell.textContent = formatNumber(value); row.appendChild(cell); }
  function appendPercentCell(row, value) { const cell = document.createElement('td'); cell.className = 'numeric'; cell.textContent = formatPercent(value); row.appendChild(cell); }
})();
