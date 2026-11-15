'use strict';
/**
 * router.js — n8n-hubspot-territory-assignment-geofence-router
 * License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
 *
 * Geographic routing engine: maps HubSpot contacts and companies to sales reps
 * using GeoJSON polygons, postal-code rules, telephone area codes and country
 * boundaries, then decides whether (and to whom) the record owner should change.
 *
 * HOW IT RUNS
 * - In n8n: each Code node in workflow.json contains this whole file, preceded by
 *   one line such as `const ROUTER_STAGE = 'route';`. The stage selects what the
 *   node does (see runStage at the bottom). If you edit this file, paste it into
 *   every Code node again and keep each node's first line.
 * - In Node.js (tests, local checks): `require('./router.js')` exports the pure
 *   functions. Nothing runs on require.
 *
 * SAFETY
 * - DRY_RUN defaults to true: decisions are computed and reported, owners are not changed.
 * - SANDBOX_MODE defaults to true: the HubSpot portal must be SANDBOX or DEVELOPER_TEST.
 * - Existing owners are never overwritten unless OVERWRITE_EXISTING_OWNER=true.
 * - Owner IDs must be numeric HubSpot owner IDs; placeholders are never written.
 * - At most MAX_RECORDS_PER_EXECUTION records are processed per execution.
 * - Reports never contain names, emails, phone numbers, postal codes or coordinates:
 *   only record IDs, territory IDs and the rule that matched.
 * - Secrets stay in $env; every error passes through maskSecrets()/maskError().
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SECRET_KEYS = ['HUBSPOT_ACCESS_TOKEN', 'ROUTER_WEBHOOK_TOKEN', 'NOTIFY_WEBHOOK_URL'];
const CONFIG_KEYS = SECRET_KEYS.concat([
  'DRY_RUN', 'SANDBOX_MODE', 'OVERWRITE_EXISTING_OWNER', 'NOTIFY_ON_DRY_RUN', 'HUBSPOT_API_BASE',
  'ALLOWED_OBJECT_TYPES', 'MAX_RECORDS_PER_EXECUTION', 'MATCH_ORDER', 'DEFAULT_PHONE_COUNTRY_CODE',
  'COUNTRY_PROPERTY', 'POSTAL_PROPERTY', 'PHONE_PROPERTIES', 'LATITUDE_PROPERTY', 'LONGITUDE_PROPERTY',
  'OWNER_PROPERTY', 'ROUTING_AUDIT_PROPERTY', 'FALLBACK_OWNER_ID', 'TERRITORY_CONFIG_JSON',
]);
const SIGNALS = ['polygon', 'postal', 'area_code', 'country'];
const OBJECT_TYPES = ['contacts', 'companies'];
const ALLOWED_ACCOUNT_TYPES = ['SANDBOX', 'DEVELOPER_TEST'];

/** Unrecognised values fall back to the default, so DRY_RUN=flase stays a dry run. */
function parseBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/** Placeholders such as YOUR_HUBSPOT_PRIVATE_APP_TOKEN count as "not set". */
function cleanValue(value) {
  if (value === undefined || value === null) return '';
  const s = String(value).trim();
  return /^YOUR_[A-Z0-9_]+$/.test(s) ? '' : s;
}

function list(value, fallback) {
  const s = cleanValue(value);
  return (s || fallback).split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

const PROPERTY_NAME = /^[a-z0-9_]{1,100}$/;

/**
 * Resolve runtime settings from an env-like object. `settings` never contains
 * secret values, only presence flags, so it is safe to pass between n8n nodes.
 */
function resolveConfig(env) {
  const e = env || {};
  const errors = [];
  const settings = {
    dryRun: parseBool(e.DRY_RUN, true),
    sandboxMode: parseBool(e.SANDBOX_MODE, true),
    overwriteExistingOwner: parseBool(e.OVERWRITE_EXISTING_OWNER, false),
    notifyOnDryRun: parseBool(e.NOTIFY_ON_DRY_RUN, true),
    hubspotApiBase: String(cleanValue(e.HUBSPOT_API_BASE) || 'https://api.hubapi.com').replace(/\/+$/, ''),
    allowedObjectTypes: list(e.ALLOWED_OBJECT_TYPES, 'contacts,companies').map(normalizeObjectType),
    maxRecordsPerExecution: Number(cleanValue(e.MAX_RECORDS_PER_EXECUTION) || 100),
    matchOrder: list(e.MATCH_ORDER, 'polygon,postal,area_code,country').map((x) => x.toLowerCase()),
    defaultPhoneCountryCode: String(cleanValue(e.DEFAULT_PHONE_COUNTRY_CODE) || '1').replace(/\D/g, ''),
    countryProperty: cleanValue(e.COUNTRY_PROPERTY) || 'country',
    postalProperty: cleanValue(e.POSTAL_PROPERTY) || 'zip',
    phoneProperties: list(e.PHONE_PROPERTIES, 'phone,mobilephone'),
    latitudeProperty: cleanValue(e.LATITUDE_PROPERTY) || null,
    longitudeProperty: cleanValue(e.LONGITUDE_PROPERTY) || null,
    ownerProperty: cleanValue(e.OWNER_PROPERTY) || 'hubspot_owner_id',
    routingAuditProperty: cleanValue(e.ROUTING_AUDIT_PROPERTY) || null,
    fallbackOwnerId: cleanValue(e.FALLBACK_OWNER_ID) || null,
    present: {},
  };
  for (const k of SECRET_KEYS) settings.present[camel(k)] = cleanValue(e[k]) !== '';

  if (!settings.present.hubspotAccessToken) errors.push('HUBSPOT_ACCESS_TOKEN is not set (placeholders count as unset)');
  if (!/^https:\/\//i.test(settings.hubspotApiBase)) errors.push('HUBSPOT_API_BASE must use https://');
  const badTypes = settings.allowedObjectTypes.filter((t) => !OBJECT_TYPES.includes(t));
  if (!settings.allowedObjectTypes.length || badTypes.length) errors.push('ALLOWED_OBJECT_TYPES may only contain contacts and/or companies');
  if (!(Number.isInteger(settings.maxRecordsPerExecution) && settings.maxRecordsPerExecution >= 1 && settings.maxRecordsPerExecution <= 1000)) {
    errors.push('MAX_RECORDS_PER_EXECUTION must be an integer from 1 to 1000');
  }
  const badSignals = settings.matchOrder.filter((x) => !SIGNALS.includes(x));
  if (!settings.matchOrder.length || badSignals.length) errors.push('MATCH_ORDER may only contain ' + SIGNALS.join(', '));
  if (!/^\d{1,3}$/.test(settings.defaultPhoneCountryCode)) errors.push('DEFAULT_PHONE_COUNTRY_CODE must be a 1-3 digit calling code');
  for (const [label, v] of [['COUNTRY_PROPERTY', settings.countryProperty], ['POSTAL_PROPERTY', settings.postalProperty],
    ['LATITUDE_PROPERTY', settings.latitudeProperty], ['LONGITUDE_PROPERTY', settings.longitudeProperty],
    ['OWNER_PROPERTY', settings.ownerProperty], ['ROUTING_AUDIT_PROPERTY', settings.routingAuditProperty]]) {
    if (v !== null && !PROPERTY_NAME.test(v)) errors.push(label + ' must be a HubSpot internal property name');
  }
  for (const p of settings.phoneProperties) if (!PROPERTY_NAME.test(p)) errors.push('PHONE_PROPERTIES contains an invalid property name');
  if (Boolean(settings.latitudeProperty) !== Boolean(settings.longitudeProperty)) errors.push('Set both LATITUDE_PROPERTY and LONGITUDE_PROPERTY, or neither');
  if (settings.fallbackOwnerId && !/^\d+$/.test(settings.fallbackOwnerId)) errors.push('FALLBACK_OWNER_ID must be a numeric HubSpot owner ID');
  return { settings, errors };
}

function camel(key) {
  return key.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Properties fetched from HubSpot for each record. */
function propertiesToFetch(s) {
  return Array.from(new Set([s.countryProperty, s.postalProperty, s.ownerProperty, s.latitudeProperty, s.longitudeProperty, s.routingAuditProperty]
    .concat(s.phoneProperties).filter(Boolean))).sort();
}

/** Constant-time comparison of the webhook token (header `x-router-token` or query `token`). */
function verifyWebhookToken(headers, query, expected) {
  if (!expected) return { ok: false, reason: 'ROUTER_WEBHOOK_TOKEN is not set, so webhook runs are refused' };
  const h = headers || {};
  const provided = String(h['x-router-token'] || h['X-Router-Token'] || (query && query.token) || '');
  if (provided.length !== expected.length) return { ok: false, reason: 'invalid webhook token' };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: 'invalid webhook token' };
}

function assertSandbox(accountInfo, sandboxMode) {
  const type = String((accountInfo && accountInfo.accountType) || '').toUpperCase();
  if (!sandboxMode) return { ok: true, enforced: false, accountType: type || 'UNKNOWN' };
  if (ALLOWED_ACCOUNT_TYPES.includes(type)) return { ok: true, enforced: true, accountType: type };
  throw new Error('Sandbox gate blocked this run: SANDBOX_MODE=true but the HubSpot portal reports accountType "' + (type || 'UNKNOWN') +
    '". Allowed: ' + ALLOWED_ACCOUNT_TYPES.join(', ') + '. No records were read or updated.');
}

// ---------------------------------------------------------------------------
// Inbound events
// ---------------------------------------------------------------------------

function normalizeObjectType(t) {
  const v = String(t || '').trim().toLowerCase();
  if (['contact', 'contacts', '0-1'].includes(v)) return 'contacts';
  if (['company', 'companies', '0-2'].includes(v)) return 'companies';
  return v;
}

/**
 * Accepts three payload shapes and returns [{ objectType, objectId }]:
 *  1. HubSpot app webhooks: [{ objectId, subscriptionType: 'contact.creation' }, ...]
 *  2. HubSpot workflow "Send a webhook": { objectId | hs_object_id | vid | properties.hs_object_id, objectType? }
 *     (objectType may also come from the query string, e.g. ?objectType=companies)
 *  3. Generic: { records: [{ objectType, objectId }] }
 */
function parseInboundEvents(body, query, s) {
  const q = query || {};
  const raw = [];
  const push = (type, id) => raw.push({ objectType: normalizeObjectType(type), objectId: id === undefined || id === null ? '' : String(id).trim() });
  const fromObject = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.subscriptionType) { push(String(o.subscriptionType).split('.')[0], o.objectId); return; }
    const props = o.properties || {};
    const id = o.objectId !== undefined ? o.objectId : o.hs_object_id !== undefined ? o.hs_object_id : o.vid !== undefined ? o.vid
      : props.hs_object_id && typeof props.hs_object_id === 'object' ? props.hs_object_id.value : props.hs_object_id;
    const type = o.objectType || o.object_type || q.objectType || (o.vid !== undefined ? 'contacts' : '');
    push(type, id);
  };
  if (Array.isArray(body)) body.forEach(fromObject);
  else if (body && Array.isArray(body.records)) body.records.forEach(fromObject);
  else fromObject(body);

  const seen = new Set();
  const records = [];
  const rejected = { invalidType: 0, invalidId: 0, duplicate: 0, overCap: 0 };
  for (const r of raw) {
    if (!s.allowedObjectTypes.includes(r.objectType)) { rejected.invalidType++; continue; }
    if (!/^\d{1,20}$/.test(r.objectId)) { rejected.invalidId++; continue; }
    const key = r.objectType + ':' + r.objectId;
    if (seen.has(key)) { rejected.duplicate++; continue; }
    seen.add(key);
    if (records.length >= s.maxRecordsPerExecution) { rejected.overCap++; continue; }
    records.push(r);
  }
  return { records, rejected, received: raw.length };
}

// ---------------------------------------------------------------------------
// Normalisation: countries, postal codes, phone numbers
// ---------------------------------------------------------------------------

const COUNTRY_ALIASES = {
  'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US', USA: 'US', 'U.S.': 'US', 'U.S.A.': 'US', AMERICA: 'US',
  'UNITED KINGDOM': 'GB', UK: 'GB', 'GREAT BRITAIN': 'GB', ENGLAND: 'GB', SCOTLAND: 'GB', WALES: 'GB', 'NORTHERN IRELAND': 'GB',
  CANADA: 'CA', MEXICO: 'MX', BRAZIL: 'BR', ARGENTINA: 'AR', GERMANY: 'DE', DEUTSCHLAND: 'DE', AUSTRIA: 'AT', SWITZERLAND: 'CH',
  FRANCE: 'FR', SPAIN: 'ES', ITALY: 'IT', NETHERLANDS: 'NL', 'THE NETHERLANDS': 'NL', HOLLAND: 'NL', BELGIUM: 'BE', IRELAND: 'IE',
  SWEDEN: 'SE', NORWAY: 'NO', DENMARK: 'DK', FINLAND: 'FI', POLAND: 'PL', PORTUGAL: 'PT', AUSTRALIA: 'AU', 'NEW ZEALAND': 'NZ',
  INDIA: 'IN', BANGLADESH: 'BD', PAKISTAN: 'PK', SINGAPORE: 'SG', JAPAN: 'JP', CHINA: 'CN', 'SOUTH KOREA': 'KR', KOREA: 'KR',
  'HONG KONG': 'HK', 'UNITED ARAB EMIRATES': 'AE', UAE: 'AE', 'SAUDI ARABIA': 'SA', ISRAEL: 'IL', 'SOUTH AFRICA': 'ZA', NIGERIA: 'NG', KENYA: 'KE',
};

/** "United States" / "usa" / "US" -> "US". Unknown values return null. */
function normalizeCountry(value, extraAliases) {
  if (value === undefined || value === null) return null;
  const v = String(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!v) return null;
  const extra = extraAliases || {};
  if (extra[v]) return String(extra[v]).toUpperCase();
  if (/^[A-Z]{2}$/.test(v)) return v === 'UK' ? 'GB' : v;
  return COUNTRY_ALIASES[v] || null;
}

/** Uppercase, no spaces; US ZIP+4 is reduced to the 5-digit ZIP. */
function normalizePostal(value, country) {
  if (value === undefined || value === null) return null;
  let v = String(value).toUpperCase().replace(/[\s ]+/g, '').trim();
  if (!v || v.length > 12 || !/^[A-Z0-9-]+$/.test(v)) return null;
  if (country === 'US') {
    const m = v.match(/^(\d{5})(-?\d{4})?$/);
    return m ? m[1] : null;
  }
  v = v.replace(/-/g, '');
  return v || null;
}

/**
 * Phone -> international digits without "+", e.g. "+1 (415) 555-0100" -> "14155550100".
 * Numbers without a country code use DEFAULT_PHONE_COUNTRY_CODE; a national trunk "0" is dropped.
 */
function normalizePhone(value, defaultCountryCode) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().replace(/(?:ext\.?|x|#)\s*\d+$/i, '');
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (raw.startsWith('+')) return digits;
  if (digits.startsWith('00')) return digits.slice(2);
  const cc = String(defaultCountryCode || '');
  if (cc === '1' && digits.length === 11 && digits.startsWith('1')) return digits;
  if (digits.startsWith('0')) return cc + digits.slice(1);
  return cc + digits;
}

// ---------------------------------------------------------------------------
// Geometry (GeoJSON, [longitude, latitude])
// ---------------------------------------------------------------------------

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
    if (p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90) return false;
  }
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

/** Returns an array of polygons (each an array of rings) or throws on invalid geometry. */
function polygonsOf(geometry) {
  if (!geometry || typeof geometry !== 'object') throw new Error('geometry must be a GeoJSON Polygon or MultiPolygon');
  const g = geometry.type === 'Feature' ? geometry.geometry : geometry;
  let polys;
  if (g && g.type === 'Polygon') polys = [g.coordinates];
  else if (g && g.type === 'MultiPolygon') polys = g.coordinates;
  else throw new Error('geometry must be a GeoJSON Polygon or MultiPolygon');
  if (!Array.isArray(polys) || !polys.length) throw new Error('geometry has no polygons');
  for (const poly of polys) {
    if (!Array.isArray(poly) || !poly.length) throw new Error('polygon has no rings');
    for (const ring of poly) if (!validRing(ring)) throw new Error('each ring needs at least 4 [lng, lat] positions, within range, first = last');
  }
  return polys;
}

/** Ray casting; points exactly on an edge count as inside. */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const cross = (lng - xi) * (yj - yi) - (lat - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-12 && lng >= Math.min(xi, xj) - 1e-12 && lng <= Math.max(xi, xj) + 1e-12 &&
      lat >= Math.min(yi, yj) - 1e-12 && lat <= Math.max(yi, yj) + 1e-12) return true; // on edge
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
function pointInPolygon(lng, lat, polygon) {
  if (!pointInRing(lng, lat, polygon[0])) return false;
  for (let h = 1; h < polygon.length; h++) {
    if (pointInRing(lng, lat, polygon[h]) && !onRingEdge(lng, lat, polygon[h])) return false;
  }
  return true;
}

function onRingEdge(lng, lat, ring) {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const cross = (lng - xi) * (yj - yi) - (lat - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-12 && lng >= Math.min(xi, xj) - 1e-12 && lng <= Math.max(xi, xj) + 1e-12 &&
      lat >= Math.min(yi, yj) - 1e-12 && lat <= Math.max(yi, yj) + 1e-12) return true;
  }
  return false;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

/** Planar area in square degrees: only used to prefer the smaller (more specific) polygon. */
function geometryArea(polys) {
  return polys.reduce((n, poly) => n + ringArea(poly[0]) - poly.slice(1).reduce((m, r) => m + ringArea(r), 0), 0);
}

function bbox(polys) {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// ---------------------------------------------------------------------------
// Territory configuration
// ---------------------------------------------------------------------------

/**
 * Compile and validate the territory configuration. Returns { compiled, errors, warnings }.
 * Each territory: { id, name, ownerIds: [..] | ownerId, priority, match: { countries, postalCodes,
 * postalRegex, areaCodes, polygons } }. Postal rules: "94105" exact, "941*" prefix, "94000-94999" range,
 * optionally scoped by country: "US:941*".
 */
function compileTerritories(config) {
  const errors = [];
  const warnings = [];
  const cfg = config && typeof config === 'object' ? config : {};
  const territories = Array.isArray(cfg.territories) ? cfg.territories : [];
  if (!territories.length) errors.push('territory config must contain a non-empty "territories" array');
  const ids = new Set();
  const compiled = [];
  territories.forEach((t, idx) => {
    const where = 'territories[' + idx + ']' + (t && t.id ? ' (' + t.id + ')' : '');
    if (!t || typeof t !== 'object') { errors.push(where + ' must be an object'); return; }
    if (!t.id || !/^[A-Za-z0-9_.-]{1,64}$/.test(String(t.id))) errors.push(where + ': id must be 1-64 letters, digits, _ . -');
    if (ids.has(t.id)) errors.push(where + ': duplicate id');
    ids.add(t.id);
    const owners = (Array.isArray(t.ownerIds) ? t.ownerIds : t.ownerId !== undefined ? [t.ownerId] : []).map((o) => String(o).trim());
    if (!owners.length) errors.push(where + ': ownerId or ownerIds is required');
    const placeholderOwners = owners.filter((o) => !/^\d+$/.test(o));
    if (placeholderOwners.length) warnings.push(where + ': owner IDs that are not numeric (placeholders?) will never be written');
    const m = t.match || {};
    const c = {
      id: String(t.id),
      name: String(t.name || t.id),
      priority: Number.isFinite(Number(t.priority)) ? Number(t.priority) : 0,
      ownerIds: owners,
      countries: [],
      postal: [],
      postalRegex: [],
      areaCodes: [],
      polygons: [],
    };
    for (const raw of m.countries || []) {
      const iso = normalizeCountry(raw, cfg.countryAliases);
      if (!iso) errors.push(where + ': unknown country "' + raw + '" (use ISO 3166-1 alpha-2)');
      else c.countries.push(iso);
    }
    for (const raw of m.postalCodes || []) {
      const rule = String(raw).trim().toUpperCase();
      const scoped = rule.match(/^([A-Z]{2}):(.+)$/);
      const country = scoped ? scoped[1] : null;
      const body = (scoped ? scoped[2] : rule).replace(/\s+/g, '');
      const range = body.match(/^(\d+)-(\d+)$/);
      if (range) {
        if (range[1].length !== range[2].length || Number(range[1]) > Number(range[2])) errors.push(where + ': postal range "' + raw + '" must be ascending with equal-length bounds');
        else c.postal.push({ kind: 'range', rule: String(raw), country, from: Number(range[1]), to: Number(range[2]), len: range[1].length });
      } else if (/^[A-Z0-9]+\*$/.test(body)) {
        c.postal.push({ kind: 'prefix', rule: String(raw), country, value: body.slice(0, -1) });
      } else if (/^[A-Z0-9]+$/.test(body)) {
        c.postal.push({ kind: 'exact', rule: String(raw), country, value: body });
      } else errors.push(where + ': unsupported postal rule "' + raw + '"');
    }
    for (const raw of [].concat(m.postalRegex || [])) {
      try { c.postalRegex.push({ rule: String(raw), re: new RegExp(raw, 'i') }); } catch (e) { errors.push(where + ': invalid postalRegex "' + raw + '"'); }
    }
    for (const raw of m.areaCodes || []) {
      const digits = String(raw).replace(/\D/g, '');
      if (digits.length < 2 || digits.length > 8) errors.push(where + ': area code "' + raw + '" must include the country calling code, e.g. "+1 415"');
      else c.areaCodes.push({ rule: String(raw), digits });
    }
    (m.polygons || []).forEach((g, gi) => {
      try {
        const polys = polygonsOf(g);
        c.polygons.push({ index: gi, polys, bbox: bbox(polys), area: geometryArea(polys) });
      } catch (e) { errors.push(where + ': polygons[' + gi + '] ' + e.message); }
    });
    if (!c.countries.length && !c.postal.length && !c.postalRegex.length && !c.areaCodes.length && !c.polygons.length) {
      errors.push(where + ': match must define at least one of countries, postalCodes, postalRegex, areaCodes, polygons');
    }
    compiled.push(c);
  });
  const fallback = cfg.fallbackOwnerId !== undefined && cfg.fallbackOwnerId !== null ? String(cfg.fallbackOwnerId) : null;
  return { compiled, errors, warnings, fallbackOwnerId: fallback, centroids: cfg.postalCentroids || {}, countryAliases: cfg.countryAliases || {} };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Extract routing signals from HubSpot record properties. Raw values never leave this function's result. */
function extractSignals(properties, s, territoryConfig) {
  const p = properties || {};
  const country = normalizeCountry(p[s.countryProperty], territoryConfig.countryAliases);
  const postal = normalizePostal(p[s.postalProperty], country);
  const phones = s.phoneProperties.map((k) => normalizePhone(p[k], s.defaultPhoneCountryCode)).filter(Boolean);
  let point = null;
  if (s.latitudeProperty && s.longitudeProperty) {
    const lat = Number(p[s.latitudeProperty]);
    const lng = Number(p[s.longitudeProperty]);
    if (p[s.latitudeProperty] !== '' && p[s.latitudeProperty] !== null && p[s.latitudeProperty] !== undefined &&
      Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      point = { lng, lat, source: 'coordinates' };
    }
  }
  if (!point && postal && country) {
    const c = territoryConfig.centroids[country + ':' + postal];
    if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) point = { lng: c[0], lat: c[1], source: 'postal-centroid' };
  }
  return { country, postal, phones, point };
}

function postalMatches(rule, postal, country) {
  if (rule.country && rule.country !== country) return false;
  if (rule.kind === 'exact') return postal === rule.value;
  if (rule.kind === 'prefix') return postal.startsWith(rule.value);
  if (rule.kind === 'range') {
    const head = postal.slice(0, rule.len);
    if (!/^\d+$/.test(head) || head.length !== rule.len) return false;
    const n = Number(head);
    return n >= rule.from && n <= rule.to;
  }
  return false;
}

/** All matches for one signal, best first: priority, then specificity, then id. */
function matchSignal(signal, sig, territories) {
  const hits = [];
  for (const t of territories) {
    if (signal === 'polygon' && sig.point) {
      for (const g of t.polygons) {
        const [minX, minY, maxX, maxY] = g.bbox;
        if (sig.point.lng < minX || sig.point.lng > maxX || sig.point.lat < minY || sig.point.lat > maxY) continue;
        if (g.polys.some((poly) => pointInPolygon(sig.point.lng, sig.point.lat, poly))) {
          hits.push({ territory: t, rule: 'polygon #' + g.index + ' (' + sig.point.source + ')', specificity: 1e6 - g.area });
          break;
        }
      }
    } else if (signal === 'postal' && sig.postal) {
      let best = null;
      for (const r of t.postal) {
        if (!postalMatches(r, sig.postal, sig.country)) continue;
        const spec = r.kind === 'exact' ? 300 : r.kind === 'range' ? 200 + 99 * (1 - (r.to - r.from) / Math.pow(10, r.len)) : 100 + r.value.length;
        if (!best || spec > best.specificity) best = { territory: t, rule: 'postal ' + r.rule, specificity: spec };
      }
      for (const r of t.postalRegex) {
        if (r.re.test(sig.postal) && (!best || 50 > best.specificity)) best = best || { territory: t, rule: 'postal regex ' + r.rule, specificity: 50 };
      }
      if (best) hits.push(best);
    } else if (signal === 'area_code' && sig.phones.length) {
      let best = null;
      for (const r of t.areaCodes) {
        if (sig.phones.some((ph) => ph.startsWith(r.digits)) && (!best || r.digits.length > best.specificity)) {
          best = { territory: t, rule: 'area code ' + r.rule, specificity: r.digits.length };
        }
      }
      if (best) hits.push(best);
    } else if (signal === 'country' && sig.country && t.countries.includes(sig.country)) {
      hits.push({ territory: t, rule: 'country ' + sig.country, specificity: 0 });
    }
  }
  return hits.sort((a, b) => b.territory.priority - a.territory.priority || b.specificity - a.specificity || (a.territory.id < b.territory.id ? -1 : 1));
}

/** Stable owner pick for territories with several owners: hash(objectId) mod n. */
function pickOwner(ownerIds, objectId) {
  if (ownerIds.length === 1) return ownerIds[0];
  let h = 0x811c9dc5;
  for (const ch of String(objectId)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return ownerIds[h % ownerIds.length];
}

/**
 * Route one record. Returns a privacy-safe decision:
 * { objectType, objectId, action, ownerId, currentOwnerId, territoryId, territoryName, matchedBy, matchedRule, reason, alternatives }
 * action: assign | unchanged | skip-has-owner | no-match | invalid-owner
 */
function routeRecord(record, s, territoryConfig) {
  const props = record.properties || {};
  const currentOwnerId = props[s.ownerProperty] ? String(props[s.ownerProperty]) : null;
  const base = { objectType: record.objectType, objectId: String(record.objectId), currentOwnerId };
  const sig = extractSignals(props, s, territoryConfig);
  let decision = null;
  for (const signal of s.matchOrder) {
    const hits = matchSignal(signal, sig, territoryConfig.compiled);
    if (!hits.length) continue;
    const top = hits[0];
    const conflict = hits.length > 1 && hits[1].territory.priority === top.territory.priority && hits[1].specificity === top.specificity;
    decision = {
      territoryId: top.territory.id,
      territoryName: top.territory.name,
      ownerId: pickOwner(top.territory.ownerIds, record.objectId),
      matchedBy: signal,
      matchedRule: top.rule,
      alternatives: hits.slice(1, 4).map((h) => h.territory.id),
      tie: conflict,
    };
    break;
  }
  const signalsSeen = {
    country: Boolean(sig.country), postal: Boolean(sig.postal), phone: sig.phones.length > 0, point: sig.point ? sig.point.source : null,
  };
  const fallback = s.fallbackOwnerId || territoryConfig.fallbackOwnerId;
  if (!decision) {
    if (!fallback) return Object.assign(base, { action: 'no-match', ownerId: null, territoryId: null, reason: 'no territory matched and no fallback owner', signals: signalsSeen });
    decision = { territoryId: '__fallback__', territoryName: 'Fallback', ownerId: fallback, matchedBy: 'fallback', matchedRule: 'fallback owner', alternatives: [], tie: false };
  }
  const out = Object.assign(base, decision, { signals: signalsSeen });
  if (!/^\d+$/.test(String(out.ownerId))) return Object.assign(out, { action: 'invalid-owner', reason: 'owner ID is not a numeric HubSpot owner ID; nothing will be written' });
  if (currentOwnerId === out.ownerId) return Object.assign(out, { action: 'unchanged', reason: 'already owned by the routed owner' });
  if (currentOwnerId && !s.overwriteExistingOwner) return Object.assign(out, { action: 'skip-has-owner', reason: 'record already has an owner and OVERWRITE_EXISTING_OWNER=false' });
  return Object.assign(out, { action: 'assign', reason: 'routed by ' + out.matchedRule });
}

/** HubSpot PATCH body for an assign decision. */
function buildUpdateBody(decision, s) {
  const properties = {};
  properties[s.ownerProperty] = decision.ownerId;
  if (s.routingAuditProperty) properties[s.routingAuditProperty] = decision.territoryId;
  return { properties };
}

function summarize(decisions, s, meta) {
  const counts = {};
  for (const d of decisions) counts[d.action] = (counts[d.action] || 0) + 1;
  const byTerritory = {};
  for (const d of decisions) if (d.territoryId) byTerritory[d.territoryId] = (byTerritory[d.territoryId] || 0) + 1;
  return {
    dryRun: s.dryRun,
    generatedAt: (meta && meta.generatedAt) || new Date().toISOString(),
    records: decisions.length,
    counts,
    byTerritory,
    ties: decisions.filter((d) => d.tie).map((d) => d.objectType + ':' + d.objectId),
  };
}

/** Slack-compatible notification. Contains IDs and territory names only, no PII. */
function buildNotification(summary, decisions) {
  const title = (summary.dryRun ? '[DRY RUN] ' : '') + 'Territory router: ' + summary.records + ' record(s)';
  const counts = Object.entries(summary.counts).map(([k, v]) => k + ': ' + v).join(' · ') || 'none';
  const lines = decisions.filter((d) => d.action === 'assign').slice(0, 20)
    .map((d) => '• ' + d.objectType + ' ' + d.objectId + ' → owner ' + d.ownerId + ' (' + d.territoryId + ', ' + d.matchedRule + ')');
  return {
    text: title + ' — ' + counts,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: '*Outcome:* ' + counts + (summary.ties.length ? '\n*Ties resolved by id order:* ' + summary.ties.length : '') } },
      { type: 'section', text: { type: 'mrkdwn', text: ('*' + (summary.dryRun ? 'Would assign' : 'Assigning') + '*\n' + (lines.join('\n') || '_nothing_')).slice(0, 2900) } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Masked logging
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+\/=:-]+/gi, 'Bearer ***'],
  [/\bpat-[a-z0-9]{2,4}-[A-Za-z0-9-]{8,}/gi, 'pat-***'],
  [/([?&](?:token|hapikey|api_key|access_token)=)[^&\s"']+/gi, '$1***'],
  [/https:\/\/hooks\.slack\.com\/[^\s"'<>]+/gi, 'https://hooks.slack.com/***'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***'],
  [/\+?\d[\d\s().-]{6,}\d/g, '***phone***'],
];

function maskSecrets(text, secretValues) {
  let out = text === undefined || text === null ? '' : String(text);
  const values = (secretValues || []).filter((v) => typeof v === 'string' && v.length >= 6).sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join('***');
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function maskError(errLike, secretValues) {
  let message;
  let status = null;
  if (errLike === undefined || errLike === null) message = 'Unknown error';
  else if (typeof errLike === 'string') message = errLike;
  else {
    status = errLike.httpCode || errLike.status || errLike.statusCode || null;
    message = errLike.message || errLike.description || '';
    if (!message) { try { message = JSON.stringify(errLike); } catch (_) { message = String(errLike); } }
  }
  const m = maskSecrets(message, secretValues);
  return { status: status === null ? null : String(status), message: m.length > 1000 ? m.slice(0, 999) + '…' : m };
}

// ---------------------------------------------------------------------------
// n8n stages
// ---------------------------------------------------------------------------

function readEnv(keys) {
  const env = {};
  for (const k of keys) {
    let v;
    try { v = $env[k]; } catch (e) {
      throw new Error('This workflow reads its configuration from environment variables. Set N8N_BLOCK_ENV_ACCESS_IN_NODE=false on the n8n instance.');
    }
    if (v !== undefined && v !== null) env[k] = String(v);
  }
  return env;
}

function loadTerritoryConfig(env, fromNode) {
  const override = cleanValue(env.TERRITORY_CONFIG_JSON);
  if (override) {
    try { return JSON.parse(override); } catch (e) { throw new Error('TERRITORY_CONFIG_JSON is not valid JSON'); }
  }
  return fromNode;
}

function runStage(stage) {
  if (stage === 'gate') {
    const env = readEnv(CONFIG_KEYS);
    const { settings, errors } = resolveConfig(env);
    if (errors.length) throw new Error('Configuration invalid: ' + errors.join('; '));
    const input = ($input.first() && $input.first().json) || {};
    const trigger = input.trigger || {};
    const viaWebhook = trigger && typeof trigger.headers === 'object' && trigger.headers !== null;
    if (viaWebhook) {
      const check = verifyWebhookToken(trigger.headers, trigger.query, cleanValue(env.ROUTER_WEBHOOK_TOKEN));
      if (!check.ok) throw new Error('Webhook run refused: ' + check.reason);
    }
    const territoryConfig = loadTerritoryConfig(env, input.territoryConfig);
    const t = compileTerritories(territoryConfig);
    if (t.errors.length) throw new Error('Territory config invalid: ' + t.errors.join('; '));
    const body = viaWebhook ? trigger.body : trigger;
    const parsed = parseInboundEvents(body, viaWebhook ? trigger.query : {}, settings);
    return [{
      json: {
        config: settings,
        territoryConfig,
        territoryWarnings: t.warnings,
        records: parsed.records,
        rejected: parsed.rejected,
        received: parsed.received,
        properties: propertiesToFetch(settings).join(','),
        trigger: viaWebhook ? 'webhook' : 'manual',
        startedAt: new Date().toISOString(),
      },
    }];
  }

  if (stage === 'sandbox') {
    const gate = $('Config & Safety Gate').first().json;
    const info = $input.first().json || {};
    assertSandbox(info, gate.config.sandboxMode);
    return gate.records.map((r) => ({ json: { objectType: r.objectType, objectId: r.objectId, properties: gate.properties } }));
  }

  if (stage === 'route') {
    const gate = $('Config & Safety Gate').first().json;
    const t = compileTerritories(gate.territoryConfig);
    const sources = $('Sandbox Verification').all();
    return $input.all().map((item, i) => {
      const pi = item.pairedItem && typeof item.pairedItem.item === 'number' ? item.pairedItem.item : i;
      const src = (sources[pi] || sources[i] || { json: {} }).json;
      const rec = item.json || {};
      const decision = routeRecord({ objectType: src.objectType, objectId: rec.id || src.objectId, properties: rec.properties || {} }, gate.config, t);
      // Second dry-run guard: no update body is ever produced while DRY_RUN=true.
      const writable = decision.action === 'assign' && !gate.config.dryRun;
      return { json: Object.assign({ updateBody: writable ? buildUpdateBody(decision, gate.config) : null }, decision) };
    });
  }

  if (stage === 'report') {
    const gate = $('Config & Safety Gate').first().json;
    const decisions = $('Route Records').all().map((i) => i.json);
    const summary = summarize(decisions, gate.config);
    summary.rejectedInbound = gate.rejected;
    summary.territoryWarnings = gate.territoryWarnings;
    const shouldSend = Boolean(gate.config.present.notifyWebhookUrl) && (!gate.config.dryRun || gate.config.notifyOnDryRun);
    return [{ json: { summary, shouldSend, payload: buildNotification(summary, decisions) } }];
  }

  if (stage === 'logger') {
    const secrets = [];
    for (const k of SECRET_KEYS) { try { const v = cleanValue($env[k]); if (v) secrets.push(v); } catch (e) { /* blocked */ } }
    let source = 'unknown node';
    try { source = $prevNode.name; } catch (e) { /* not available */ }
    return $input.all().map((item) => {
      const j = item.json || {};
      const masked = maskError(j.error !== undefined ? j.error : j, secrets);
      return {
        json: {
          node: source, status: masked.status, message: masked.message, at: new Date().toISOString(),
          alert: { text: 'Territory router error at ' + source + (masked.status ? ' (HTTP ' + masked.status + ')' : '') + ': ' + masked.message },
        },
      };
    });
  }

  throw new Error('Unknown ROUTER_STAGE: ' + stage);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG_KEYS, SECRET_KEYS, SIGNALS, COUNTRY_ALIASES,
    parseBool, cleanValue, resolveConfig, propertiesToFetch, verifyWebhookToken, assertSandbox,
    normalizeObjectType, parseInboundEvents, normalizeCountry, normalizePostal, normalizePhone,
    polygonsOf, pointInPolygon, geometryArea, compileTerritories, extractSignals, matchSignal, pickOwner,
    routeRecord, buildUpdateBody, summarize, buildNotification, maskSecrets, maskError, runStage,
  };
}

// n8n entry point: the Code node defines ROUTER_STAGE on its first line.
if (typeof ROUTER_STAGE !== 'undefined') {
  return runStage(ROUTER_STAGE);
}
