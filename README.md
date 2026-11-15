# n8n-hubspot-territory-assignment-geofence-router

A geographic routing engine for n8n. It receives inbound HubSpot **contacts** and **companies** and works out which sales territory each one belongs to, using four signals:

- **GeoJSON polygons** (geofences, from record coordinates or postal-code centroids);
- **postal-code rules** (exact, prefix, range or regex);
- **telephone area codes**;
- **country boundaries**.

It then assigns the territory's owner in HubSpot, or reports what it would do.

| File | Purpose |
|---|---|
| `workflow.json` | Importable n8n workflow: webhook intake, sandbox gate, record fetch, routing, owner update, reporting, masked error branch |
| `router.js` | Geofence (point-in-polygon), postal, area-code and country matching, input validation, decisions, masked logging |
| `env.example` | Every environment variable, with safe placeholders |
| `LICENSE` | MIT License |
| `DISCLAIMER.md` | Liability limitation and as-is terms |

---

## Contents

- [Safety model](#safety-model)
- [Architecture](#architecture)
- [How routing works](#how-routing-works)
- [Territory rules](#territory-rules)
- [Environment variables](#environment-variables)
- [Installation](#installation)
- [Connecting HubSpot](#connecting-hubspot)
- [Decisions and reports](#decisions-and-reports)
- [Editing the logic](#editing-the-logic)
- [Limitations](#limitations)

---

## Safety model

| Guardrail | Behaviour |
|---|---|
| **Dry run by default** | `DRY_RUN=true` fetches records, computes every decision and sends the report, but never writes to HubSpot. This is enforced twice: by the *Dry Run?* branch, and by the routing stage, which produces no update body during a dry run. |
| **Sandbox gate by default** | `SANDBOX_MODE=true` checks `GET /account-info/v3/details` and stops before any record is read unless `accountType` is `SANDBOX` or `DEVELOPER_TEST`. |
| **No silent reassignments** | Records that already have an owner are skipped unless `OVERWRITE_EXISTING_OWNER=true`. Records already owned by the routed owner are marked `unchanged`. |
| **Owner validation** | Only numeric HubSpot owner IDs are ever written. Placeholder owners such as `YOUR_OWNER_ID_US_WEST` produce `invalid-owner` and are reported, never written. |
| **Input validation** | Payloads are parsed into `{ objectType, objectId }`. Unknown object types, non-numeric IDs and duplicates are rejected, and at most `MAX_RECORDS_PER_EXECUTION` records are processed per run. The territory config is fully validated before anything runs: unique IDs, owners present, valid GeoJSON, rules and regexes. |
| **Authenticated webhook** | Webhook runs must send `ROUTER_WEBHOOK_TOKEN` (compared in constant time). Without a configured token, webhook runs are refused. |
| **Privacy by design** | Decisions and reports carry only record IDs, territory IDs, owner IDs and the **rule** that matched (for example `postal US:97*`). They never carry names, emails, phone numbers, postal codes or coordinates. |
| **Masked logging** | Errors pass through `maskError()`, which removes the access token and other secrets, bearer headers, `token=`/`api_key=` query values, Slack webhook URLs, email addresses and phone-number-like sequences. |
| **Environment-only secrets** | The token is read from `$env` inside the HTTP nodes and never enters item data. `YOUR_*` placeholders count as unset. |

---

## Architecture

```
 ┌──────────────────┐   ┌────────────────┐   ┌──────────────────────────────┐
 │ Webhook Trigger  │   │ Manual Trigger ├──►│ Sample Payload (manual test) │
 │ POST, 202 reply  │   └────────────────┘   └──────────────┬───────────────┘
 └────────┬─────────┘                                       │
          └──────────────────────┬──────────────────────────┘
                                 ▼
                  ┌────────────────────────────┐  edit territories here (plain JSON);
                  │      Territory Rules       │  TERRITORY_CONFIG_JSON overrides it
                  └─────────────┬──────────────┘
                                ▼
                  ┌────────────────────────────┐  $env → resolveConfig(), webhook token,
                  │    Config & Safety Gate    │  validate territories, parse + dedupe +
                  └─────────────┬──────────────┘  cap inbound records
                                ▼
                       ┌─────────────────┐  no  ┌──────────────────┐
                       │  Any Records?   ├─────►│ Nothing To Route │
                       └────────┬────────┘      └──────────────────┘
                                ▼ yes
                  ┌────────────────────────────┐
                  │  HubSpot: Verify Portal    │  GET /account-info/v3/details
                  └─────────────┬──────────────┘
                                ▼
                  ┌────────────────────────────┐  accountType SANDBOX / DEVELOPER_TEST
                  │   Sandbox Verification     │  (unless SANDBOX_MODE=false)
                  └─────────────┬──────────────┘
                                ▼
                  ┌────────────────────────────┐  GET /crm/v3/objects/{type}/{id}
                  │   HubSpot: Fetch Record    │  ?properties=country,zip,phone,…,hubspot_owner_id
                  └─────────────┬──────────────┘
                                ▼
                  ┌────────────────────────────┐  polygon → postal → area code → country
                  │       Route Records        │  (MATCH_ORDER), priority, specificity,
                  └──────┬──────────────┬──────┘  owner pick, action
                         │              │
                         ▼              ▼
                ┌──────────────┐  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────┐
                │  Dry Run?    │  │ Build Report ├──►│ Send Report? ├──►│ Notify: Send Report │
                └──┬────────┬──┘  └──────────────┘   └──────────────┘   └─────────────────────┘
               yes │        │ no
                   ▼        ▼
   ┌──────────────────┐  ┌─────────────────────┐ yes ┌────────────────────────┐
   │ Dry Run: No      │  │ Needs Owner Update? ├────►│ HubSpot: Update Owner  │ PATCH /crm/v3/objects/{type}/{id}
   │ Changes Applied  │  └──────────┬──────────┘     └────────────────────────┘ { properties: { hubspot_owner_id } }
   └──────────────────┘             │ no
                                    ▼
                             ┌──────────────┐
                             │ Not Updated  │
                             └──────────────┘

  Every HTTP and Code node error output → Masked Error Logger → Notify: Error Alert → Stop: Router Failed
```

HubSpot calls are spaced 120 ms apart and retried up to three times. Notification failures never block routing.

---

## How routing works

### 1. Signals

Each record is fetched from HubSpot, so routing always uses current data and the current owner. Four signals are then extracted:

| Signal | Source | Normalisation |
|---|---|---|
| **country** | `COUNTRY_PROPERTY` (default `country`) | Free text → ISO 3166-1 alpha-2 (`United States`, `USA` → `US`; `UK`, `England` → `GB`). Extend this with `countryAliases`. |
| **postal** | `POSTAL_PROPERTY` (default `zip`) | Uppercase, spaces removed; US ZIP+4 → 5-digit ZIP. |
| **area_code** | `PHONE_PROPERTIES` (default `phone,mobilephone`) | International digits: `+1 (415) 555-0100` → `14155550100`; `00…` prefix handled; numbers without a country code use `DEFAULT_PHONE_COUNTRY_CODE`, with a leading trunk `0` dropped; extensions removed. |
| **polygon** | `LATITUDE_PROPERTY` + `LONGITUDE_PROPERTY`, or else `postalCentroids["CC:POSTAL"]` | A point `[lng, lat]` is tested against each territory's GeoJSON. |

### 2. Matching

Signals are evaluated in `MATCH_ORDER` (default `polygon,postal,area_code,country`, most precise first). The **first signal with any match decides**. Within that signal, the winning territory is chosen by:

1. highest `priority`;
2. highest specificity:
   - **polygon:** smaller area wins;
   - **postal:** exact beats a range, a narrower range beats a wider one, a range beats a prefix, a longer prefix beats a shorter one, and any of these beats a regex;
   - **area code:** the longest matching prefix wins;
3. territory `id`, alphabetically, as a deterministic tie-break. A genuine tie is flagged in the report.

Polygons use ray casting with holes, and a point exactly on an edge counts as inside. A bounding-box pre-check keeps large rule sets fast.

### 3. Owner and action

If a territory has several `ownerIds`, the owner is picked by a stable hash of the record ID. The same record always maps to the same rep, and new records spread evenly across the reps.

| Action | Meaning |
|---|---|
| `assign` | Owner will be set (live mode only) |
| `unchanged` | Already owned by the routed owner |
| `skip-has-owner` | Has another owner and `OVERWRITE_EXISTING_OWNER=false` |
| `no-match` | No territory matched and no fallback owner is set |
| `invalid-owner` | The routed owner is not a numeric HubSpot owner ID |

Unmatched records go to `FALLBACK_OWNER_ID`, or the config's `fallbackOwnerId`, when one is set.

---

## Territory rules

Territories live in the **Territory Rules** Code node as plain JSON. Alternatively, set `TERRITORY_CONFIG_JSON` in the environment. The example ships with fictional placeholder owners:

```json
{
  "version": 1,
  "fallbackOwnerId": null,
  "countryAliases": { "AMERIKA": "US" },
  "postalCentroids": { "US:94105": [-122.394, 37.79] },
  "territories": [
    {
      "id": "us-bay-area",
      "name": "US — Bay Area (geofence)",
      "ownerIds": ["YOUR_OWNER_ID_BAY_AREA_1", "YOUR_OWNER_ID_BAY_AREA_2"],
      "priority": 20,
      "match": {
        "polygons": [
          { "type": "Polygon", "coordinates": [[[-123.0, 37.2], [-121.5, 37.2], [-121.5, 38.3], [-123.0, 38.3], [-123.0, 37.2]]] }
        ]
      }
    },
    {
      "id": "us-west",
      "name": "US — West",
      "ownerId": "YOUR_OWNER_ID_US_WEST",
      "priority": 10,
      "match": {
        "postalCodes": ["US:90000-96199", "US:97*", "US:98*", "US:99*"],
        "areaCodes": ["+1 206", "+1 415", "+1 503", "+1 650"]
      }
    },
    {
      "id": "uk-london",
      "name": "UK — London",
      "ownerId": "YOUR_OWNER_ID_LONDON",
      "priority": 15,
      "match": { "postalRegex": ["^(E|EC|N|NW|SE|SW|W|WC)[0-9]"], "areaCodes": ["+44 20"] }
    },
    {
      "id": "dach",
      "name": "DACH",
      "ownerId": "YOUR_OWNER_ID_DACH",
      "priority": 5,
      "match": { "countries": ["DE", "AT", "CH"] }
    }
  ]
}
```

| Field | Rules |
|---|---|
| `id` | Required, unique, 1–64 characters from `A-Z a-z 0-9 _ . -` |
| `ownerId` / `ownerIds` | Required. Numeric HubSpot owner IDs (*Settings → Users & Teams*, or `GET /crm/v3/owners`). Several IDs → stable round-robin. |
| `priority` | Optional number, default `0`; higher wins |
| `match.countries` | ISO alpha-2 codes or known names |
| `match.postalCodes` | `"94105"` exact · `"941*"` prefix · `"94000-94999"` range (equal-length bounds) · optional country scope `"US:941*"` |
| `match.postalRegex` | Case-insensitive regex, tested against the normalised postal code (no spaces). Use this where prefixes are ambiguous: the UK example avoids matching `EH` (Edinburgh) with `E*`. |
| `match.areaCodes` | Country calling code plus area code, in any format: `"+1 415"`, `"+44 20"` |
| `match.polygons` | GeoJSON `Polygon`, `MultiPolygon` or `Feature`, as `[longitude, latitude]` with closed rings |
| `postalCentroids` | Optional `"CC:POSTAL": [lng, lat]` map, so polygon routing works without per-record coordinates |
| `fallbackOwnerId` | Optional owner for unmatched records (`FALLBACK_OWNER_ID` takes precedence) |

You can export polygons as GeoJSON from most GIS tools (for example QGIS or geojson.io) and paste the geometry in. Keep polygons reasonably simple; thousands of vertices per territory slow every run.

---

## Environment variables

All values are read with `$env` (see `env.example`). Values starting with `YOUR_` count as unset.

| Variable | Default | Description |
|---|---|---|
| `DRY_RUN` | `true` | Compute and report only |
| `SANDBOX_MODE` | `true` | Require a `SANDBOX` or `DEVELOPER_TEST` portal |
| `OVERWRITE_EXISTING_OWNER` | `false` | Reassign records that already have an owner |
| `MAX_RECORDS_PER_EXECUTION` | `100` | Records per execution (1–1000) |
| `ALLOWED_OBJECT_TYPES` | `contacts,companies` | Object types the router accepts |
| `HUBSPOT_ACCESS_TOKEN` | — | Private App token (**required**) |
| `HUBSPOT_API_BASE` | `https://api.hubapi.com` | Must be `https://` |
| `ROUTER_WEBHOOK_TOKEN` | — | Required for webhook runs |
| `MATCH_ORDER` | `polygon,postal,area_code,country` | Signal priority |
| `DEFAULT_PHONE_COUNTRY_CODE` | `1` | Calling code for numbers without `+` |
| `COUNTRY_PROPERTY` | `country` | Country input property |
| `POSTAL_PROPERTY` | `zip` | Postal input property |
| `PHONE_PROPERTIES` | `phone,mobilephone` | Phone input properties |
| `LATITUDE_PROPERTY` / `LONGITUDE_PROPERTY` | — | Optional coordinate properties (set both or neither) |
| `OWNER_PROPERTY` | `hubspot_owner_id` | Owner property to write |
| `ROUTING_AUDIT_PROPERTY` | — | Optional custom property that records the territory ID |
| `FALLBACK_OWNER_ID` | — | Owner for unmatched records |
| `TERRITORY_CONFIG_JSON` | — | Territory config override (single-line JSON) |
| `NOTIFY_WEBHOOK_URL` | — | Slack-compatible report and alert webhook |
| `NOTIFY_ON_DRY_RUN` | `true` | Also report dry runs |

HubSpot's legacy API keys are retired, so the router authenticates with a **Private App access token** (`HUBSPOT_ACCESS_TOKEN`).

---

## Installation

1. **Instance setting:** set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` so the workflow can read its configuration.
2. **Environment:** add the variables from `env.example` to the n8n host or container, taking the values from your secret store, then restart n8n.

   ```yaml
   environment:
     - N8N_BLOCK_ENV_ACCESS_IN_NODE=false
     - DRY_RUN=true
     - SANDBOX_MODE=true
     - HUBSPOT_ACCESS_TOKEN=${HUBSPOT_ACCESS_TOKEN}
     - ROUTER_WEBHOOK_TOKEN=${ROUTER_WEBHOOK_TOKEN}
     - NOTIFY_WEBHOOK_URL=${NOTIFY_WEBHOOK_URL}
   ```

3. **Import** `workflow.json` (*Workflows → Import from File*). No n8n credentials are required. The workflow imports **inactive**.
4. **Define territories** in the **Territory Rules** node and replace the placeholder owners with real owner IDs **from your sandbox portal**.
5. **Manual test:** edit **Sample Payload (manual test)** to reference a sandbox record ID, then click *Execute Workflow*. Inspect **Route Records**: every decision shows the territory, owner, signal and rule.
6. **Webhook test:** activate the workflow and send a request, still with `DRY_RUN=true`:

   ```bash
   curl -X POST "https://YOUR_N8N_HOST/webhook/hubspot-territory-router" \
     -H "Content-Type: application/json" \
     -H "x-router-token: YOUR_ROUTER_WEBHOOK_TOKEN" \
     -d '{"records":[{"objectType":"contacts","objectId":"101"}]}'
   ```

7. **Live in the sandbox:** set `DRY_RUN=false`, keeping `SANDBOX_MODE=true`, and confirm owners change as expected.
8. **Production:** switch the token to your production portal and set `SANDBOX_MODE=false` deliberately. Consider a small `MAX_RECORDS_PER_EXECUTION` at first.

---

## Connecting HubSpot

The webhook accepts three payload shapes:

| Source | Payload | Notes |
|---|---|---|
| **HubSpot workflow → "Send a webhook"** | `{ "objectId": 123 }`, `{ "hs_object_id": "123" }` or `{ "vid": 123 }` | Add `?objectType=companies` to the URL for company workflows. Configure the token as a header or `token` query value in the action's authentication settings. |
| **HubSpot app webhooks** (developer app subscriptions) | `[{ "objectId": 123, "subscriptionType": "contact.creation" }, …]` | Subscribe to `contact.creation` / `company.creation`, plus `propertyChange` for `country`, `zip` and `phone` if you want re-routing. See the note on signatures below. |
| **Any system** | `{ "records": [{ "objectType": "contacts", "objectId": "123" }] }` | Useful for back-fills, in batches of up to `MAX_RECORDS_PER_EXECUTION`. |

Private App scopes:

| Scope | Why |
|---|---|
| `crm.objects.contacts.read` / `.write` | Fetch contacts and set their owner |
| `crm.objects.companies.read` / `.write` | Fetch companies and set their owner |

The account-info call used by the sandbox gate needs no extra scope.

> App webhooks are signed with HubSpot's `X-HubSpot-Signature-v3`. This workflow authenticates with its own shared token instead. If you expose the URL to HubSpot app webhooks, put it behind a gateway that verifies HubSpot's signature, or add the token as a query parameter in the subscription URL.

---

## Decisions and reports

**Route Records** outputs one item per record:

```json
{
  "objectType": "contacts",
  "objectId": "101",
  "currentOwnerId": null,
  "territoryId": "us-west",
  "territoryName": "US — West",
  "ownerId": "YOUR_OWNER_ID_US_WEST",
  "matchedBy": "postal",
  "matchedRule": "postal US:97*",
  "alternatives": [],
  "tie": false,
  "signals": { "country": true, "postal": true, "phone": true, "point": null },
  "action": "invalid-owner",
  "reason": "owner ID is not a numeric HubSpot owner ID; nothing will be written",
  "updateBody": null
}
```

The Slack-compatible report shows the counts by action and the records that are (or would be) assigned, by ID and territory only. Inbound rejections (invalid type or ID, duplicates, over the cap) and territory-config warnings are included in **Build Report**'s summary.

---

## Editing the logic

`router.js` is the single source of logic. Each Code node in `workflow.json` contains the whole file, preceded by one line that selects its stage:

| Code node | First line |
|---|---|
| Config & Safety Gate | `const ROUTER_STAGE = 'gate';` |
| Sandbox Verification | `const ROUTER_STAGE = 'sandbox';` |
| Route Records | `const ROUTER_STAGE = 'route';` |
| Build Report | `const ROUTER_STAGE = 'report';` |
| Masked Error Logger | `const ROUTER_STAGE = 'logger';` |

After editing `router.js`, paste it below that first line in each of the five nodes. **Territory Rules** and **Sample Payload** are separate, plain nodes; edit them directly.

`router.js` also works as a Node.js module for local checks:

```js
const r = require('./router.js');
const { settings } = r.resolveConfig({ HUBSPOT_ACCESS_TOKEN: 'mock-token' });
const territories = r.compileTerritories(require('./my-territories.json'));
console.log(territories.errors, territories.warnings);
console.log(r.routeRecord({ objectType: 'contacts', objectId: '101', properties: { country: 'USA', zip: '97201' } }, settings, territories));
```

Nothing runs on `require`. The n8n entry point only runs when `ROUTER_STAGE` is defined.

---

## Limitations

- **Planar geometry:** polygons are tested on longitude/latitude as a flat plane, which is accurate for territory-sized shapes. Polygons crossing the antimeridian (±180°) or covering a pole are not supported; split them into a `MultiPolygon`.
- **No geocoding:** polygon routing needs coordinates on the record or a `postalCentroids` entry. Add a geocoding step before the router if you need address-level precision.
- **Phone heuristics:** numbers stored without a country code are assumed to use `DEFAULT_PHONE_COUNTRY_CODE`. Mobile numbers often don't reflect where someone works.
- **Free-text countries:** unrecognised values can't be routed by country. Add them through `countryAliases`, or standardise the property in HubSpot.
- **No state between runs:** round-robin uses a stable hash rather than a counter, so it balances statistically, not exactly.
- **Owner validity:** owner IDs are checked for format, not existence. HubSpot rejects unknown owner IDs, and those failures go to the error branch.

---

## ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-hubspot-territory-assignment-geofence-router`) are for educational and architectural demonstration purposes.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts, including misrouted leads and accounts.
* **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement.
* **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Treat every owner reassignment as live and not automatically reversible.
* **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot and any connected services. That includes confirming a lawful basis for processing location and telephone data, keeping territory rules fair and accurate, and reviewing every automated owner assignment.

The full disclaimer is also available in [DISCLAIMER.md](https://github.com/dhrobinsystems/n8n-hubspot-territory-assignment-geofence-router/blob/main/DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](https://github.com/dhrobinsystems/n8n-hubspot-territory-assignment-geofence-router/blob/main/LICENSE).

License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
