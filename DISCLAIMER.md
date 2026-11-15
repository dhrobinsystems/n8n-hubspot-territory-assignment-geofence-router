# Disclaimer & Limitation of Liability

**Project:** `n8n-hubspot-territory-assignment-geofence-router`
**Publisher:** DH Robin (dhRobin Systems)
**Applies to:** every file in this repository, including `workflow.json`, `router.js`, `env.example` and the documentation.

## 1. Purpose

This repository is an educational and architectural reference. It shows one way to route HubSpot contacts and companies to sales owners using geographic and telephone rules. It is not a managed service, and it is not legal, compliance or sales-operations advice.

## 2. "As is", without warranty

The software is provided **"AS IS" and "AS AVAILABLE", without warranty of any kind**, express or implied. This includes, without limitation, warranties of merchantability, fitness for a particular purpose, title, non-infringement, accuracy, and uninterrupted or error-free operation.

## 3. Routing accuracy

Geographic and telephone routing is approximate. Countries are often entered as free text. Postal codes change and can cross administrative boundaries. Telephone numbers move with people and are frequently entered without a country code. Coordinates may be missing or wrong. Planar polygon tests do not handle shapes that cross the antimeridian or the poles. The router may assign a record to the wrong owner, or to no owner. You are responsible for your territory definitions and for reviewing routing outcomes.

## 4. Automated owner changes

When `DRY_RUN=false`, the workflow writes `hubspot_owner_id` (or the configured owner property), and optionally an audit property, through the HubSpot API. Owner changes can trigger HubSpot workflows, notifications, sequences, task assignments, reporting changes and commission consequences. Safeguards such as `DRY_RUN=true`, `SANDBOX_MODE=true`, never overwriting existing owners by default, numeric-owner validation, per-execution record caps and webhook authentication reduce risk; they do not remove it. Changes made by this software are not automatically reversible.

## 5. Third-party services

HubSpot and n8n APIs, rate limits, scopes and behaviour may change without notice. Errors, retries and rate limiting can cause partial processing. You are responsible for validating the workflow against current documentation and your subscription's limits.

## 6. Data protection and compliance

The router reads personal data such as addresses, postal codes and telephone numbers to make routing decisions. You alone are responsible for:

- having a lawful basis for that processing under applicable law, for example GDPR, UK GDPR or CCPA/CPRA;
- recording it in your records of processing;
- configuring n8n execution-data retention appropriately;
- making sure routing does not produce unlawful discrimination;
- complying with the terms of service and security policies of HubSpot, n8n and any connected service.

## 7. Limitation of liability

To the maximum extent permitted by applicable law, in no event shall the author, DH Robin, dhRobin Systems or any contributor be liable for any direct, indirect, incidental, special, exemplary, punitive or consequential damages. This includes lost revenue, pipeline, commissions, profit, business, goodwill or data, misrouted leads, regulatory fines, and the cost of substitute services. It applies however caused and on any theory of liability, whether in contract, strict liability or tort (including negligence), arising in any way out of the use, misuse, inability to use or deployment of this software, even if advised of the possibility of such damage.

## 8. No affiliation

HubSpot, n8n and Slack are trademarks of their respective owners. This project is independent and is not affiliated with, endorsed by or sponsored by any of them. All territories, owner IDs, record IDs, domains and identifiers in this repository are fictional or placeholders.

## 9. License

The software is licensed under the MIT License (see [LICENSE](LICENSE)). If anything here conflicts with the MIT License, the MIT License governs.

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
