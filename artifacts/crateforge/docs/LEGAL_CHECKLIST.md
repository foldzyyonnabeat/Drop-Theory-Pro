# Commercial and legal launch checklist

Preparation checklist only; not legal advice. Have counsel review the product, privacy flows, music rights, licenses, and user-facing terms before a paid release.

## Product identity and software

- [ ] Search and clear “Drop Theory” and “Drop Theory Pro” in target markets; review domain, company, trademark, and app-store conflicts.
- [ ] Keep a release-specific software bill of materials and retain exact license/notice files for JavaScript, Rust, Python, native binaries, models, codecs, fonts, and other assets.
- [ ] Resolve every release-blocking license and every conditional/manual review in `LICENSES_TO_PURCHASE.md` and `THIRD_PARTY_NOTICES.md`.
- [ ] Obtain written commercial rights for each distributed model, model weight, encoder, or proprietary SDK. Do not assume code and weights share a license.
- [ ] Review rekordbox/AlphaTheta, Camelot/Mixed In Key, and other DJ-software marks. Use compatibility names descriptively and never imply endorsement.
- [ ] Review patent-risk areas, including harmonic-mixing and audio-processing workflows, with qualified counsel.

## Business, sales, and user terms

- [ ] Choose an entity and operating jurisdictions; register the business, tax accounts, and required local registrations.
- [ ] Draft and review EULA, Terms of Service (only if online services are added), warranty disclaimers, limitation of liability, acceptable-use terms, and accessibility/support commitments.
- [ ] Define perpetual, trial, subscription, seat/team/business licensing, offline activation, refund/cancellation, renewal, chargeback, and license-transfer terms before building payment flows.
- [ ] Determine sales tax, VAT, GST/HST, invoicing, and merchant-of-record responsibilities in each market.
- [ ] If using payment processors, review their app/software, recurring billing, refund, and digital goods rules. No processor is currently integrated.

## Privacy and security

- [ ] Publish an accurate privacy notice before collecting account, diagnostics, crash, analytics, payment, or support data.
- [ ] For GDPR/UK GDPR, identify controller/processor roles, lawful bases, data subject access/deletion/export, retention, subprocessors, international transfers, and a DPA where applicable.
- [ ] For CCPA/CPRA and other US state privacy laws, assess notice-at-collection, access/delete/correct, opt-out, sensitive-data, and service-provider obligations.
- [ ] Keep audio local. If metadata sync or an optional LLM is ever added, disclose exact fields sent, destination, purpose, retention, and controls; require explicit user action.
- [ ] Do not place music titles, file paths, audio, model data, client information, OAuth tokens, or license keys into telemetry or crash reports by default.
- [ ] Store credentials using OS secure storage; rotate/revoke tokens; implement least privilege and rate limits for any public API.
- [ ] Provide export and complete-erasure controls for library metadata, settings, requests, and account data when those features exist.

## Music and community features

- [ ] Confirm the user's authority to analyze, transform, record, export, or share each audio file.
- [ ] Provide clear notices that users are responsible for performance/broadcast rights when livestreaming or recording mixes.
- [ ] Do not provide paid-pool scraping, piracy sources, DRM circumvention, or unauthorized audio previews.
- [ ] If community crates or user uploads are added, create a DMCA/takedown process, repeat-infringer policy, rights complaint form, moderation process, and counter-notice procedure where applicable.
- [ ] Share track lists/metadata only when permitted; do not redistribute lyrics, artwork, audio, or provider data outside their terms.
- [ ] Ensure demo assets are original or explicitly licensed. Current demo tracks are synthetic metadata only.

## Distribution and operations

- [ ] Complete `WINDOWS_RELEASE_CHECKLIST.md`; do not call the app Windows-ready without real test evidence.
- [ ] Sign installers with an accepted Authenticode certificate and protect signing keys in a controlled service/hardware-backed store.
- [ ] Review auto-update, rollback, vulnerability disclosure, security response, and end-of-support policies before enabling automatic updates.
- [ ] Review Microsoft Store and other marketplace terms if distribution is through a store.
- [ ] Decide support, retention, backup, incident response, and end-of-life procedures.
- [ ] Re-run the release license generator, vulnerability scan, and reproducible build checks for each release.