# AI Scam Detector — Requirements Document

**Version:** 1.0  
**Date:** June 6, 2026  
**Status:** Draft

---

## 1. Overview

The AI Scam Detector is a service that analyzes incoming messages from WhatsApp, SMS, and email to determine the likelihood that a message is a scam. For each analyzed message, the system returns a structured response containing a risk score, a plain-language explanation, a list of suspicious phrases, and actionable safety recommendations.

---

## 2. Goals

- Protect users from phishing, social engineering, and financial scams delivered via common messaging channels.
- Provide transparent, explainable results so users can make informed decisions.
- Operate across WhatsApp, SMS, and email without requiring changes to the core detection logic.
- Return results fast enough to be useful in real-time or near-real-time workflows.

---

## 3. Scope

### In Scope
- Analysis of plain-text message content from WhatsApp, SMS, and email.
- Analysis of email metadata: sender address, reply-to address, subject line.
- Detection of URLs embedded in messages (link analysis).
- Structured JSON response with score, explanation, suspicious phrases, and recommendations.
- Support for English language messages (additional languages as a future extension).

### Out of Scope
- Attachment scanning (images, PDFs, executables) — future phase.
- Real-time interception or blocking of messages at the network level.
- User account management and authentication UI.
- Storage or logging of message content beyond the scope of a single analysis request.

---

## 4. Stakeholders

| Role | Responsibility |
|---|---|
| End Users | Submit messages for analysis; act on recommendations |
| Product Owner | Define acceptance criteria and prioritization |
| ML/AI Team | Train and maintain detection models |
| Backend Engineers | Build and maintain the API and integration layer |
| Security & Privacy Team | Ensure data handling compliance |

---

## 5. Functional Requirements

### 5.1 Message Ingestion

**FR-01** — The system shall accept a message payload via a REST API endpoint.  
**FR-02** — The payload shall include the message body (required) and optional metadata fields: channel (`whatsapp` | `sms` | `email`), sender identifier, and email subject line.  
**FR-03** — The system shall support message bodies up to 10,000 characters.  
**FR-04** — The system shall extract and separately analyze any URLs found within the message body.  
**FR-05** — For email messages, the system shall analyze the sender domain and reply-to domain as additional scam signals.

### 5.2 Scam Risk Score

**FR-06** — The system shall return a numeric `risk_score` between 0.0 and 1.0, where 0.0 is no risk and 1.0 is certain scam.  
**FR-07** — The system shall map the numeric score to a categorical `risk_level`: `low` (0.0–0.39), `medium` (0.40–0.69), `high` (0.70–0.89), `critical` (0.90–1.0).  
**FR-08** — The score shall be derived from a combination of signals including linguistic patterns, URL reputation, sender metadata, and contextual urgency cues.

### 5.3 Explanation

**FR-09** — The system shall return a plain-language `explanation` string describing why the message received its score.  
**FR-10** — The explanation shall reference the primary contributing factors (e.g., "The message impersonates a bank and requests credentials via a suspicious link").  
**FR-11** — The explanation shall be concise — no longer than 3 sentences.

### 5.4 Suspicious Phrases

**FR-12** — The system shall return a `suspicious_phrases` array containing specific text fragments from the original message that contributed to the score.  
**FR-13** — Each entry shall include the phrase text and a tag indicating the scam pattern it represents (e.g., `urgency`, `impersonation`, `credential_harvesting`, `prize_fraud`, `financial_lure`, `threat`).  
**FR-14** — If no suspicious phrases are identified, the array shall be empty.

### 5.5 Safety Recommendations

**FR-15** — The system shall return a `recommendations` array with actionable advice tailored to the detected scam type and risk level.  
**FR-16** — Recommendations shall be ordered by priority (most important first).  
**FR-17** — For `low` risk, recommendations shall be informational only.  
**FR-18** — For `medium` risk, recommendations shall advise caution and verification steps.  
**FR-19** — For `high` and `critical` risk, recommendations shall advise the user not to interact with the message and provide steps to report it.  
**FR-20** — Recommendations shall reference the appropriate reporting channel based on the message channel (e.g., WhatsApp's "Report" feature, forwarding SMS scams to 7726 in applicable regions, email spam reporting).

### 5.6 API Response Structure

The API shall return responses conforming to the following structure:

```json
{
  "request_id": "uuid-v4",
  "channel": "email",
  "risk_score": 0.91,
  "risk_level": "critical",
  "explanation": "This email impersonates a major bank and directs the recipient to a spoofed login page to harvest credentials. The sender domain does not match the claimed institution. Extreme urgency language is used to pressure immediate action.",
  "suspicious_phrases": [
    {
      "phrase": "Your account will be suspended within 24 hours",
      "tag": "urgency"
    },
    {
      "phrase": "Verify your identity now",
      "tag": "credential_harvesting"
    },
    {
      "phrase": "secure-login-bankofamerica.phishingsite.com",
      "tag": "spoofed_url"
    }
  ],
  "recommendations": [
    "Do not click any links in this message.",
    "Do not provide any personal or financial information.",
    "Report this email as phishing using your email client's 'Report Spam' or 'Report Phishing' option.",
    "If you believe your account may be at risk, contact your bank directly using the number on the back of your card.",
    "Delete the message."
  ],
  "analyzed_at": "2026-06-06T14:32:00Z"
}
```

---

## 6. Non-Functional Requirements

### 6.1 Performance
**NFR-01** — The API shall return a response within 2 seconds for 95% of requests under normal load.  
**NFR-02** — The system shall support at least 500 concurrent analysis requests.

### 6.2 Accuracy
**NFR-03** — The detection model shall achieve a minimum precision of 92% and recall of 90% on the held-out test set at the `high` + `critical` threshold.  
**NFR-04** — The false positive rate (legitimate messages flagged as `high` or `critical`) shall not exceed 2%.

### 6.3 Privacy & Security
**NFR-05** — Message content submitted to the API shall not be persisted after the analysis response is returned, unless the user explicitly consents to data retention for model improvement.  
**NFR-06** — All API communication shall use TLS 1.2 or higher.  
**NFR-07** — API access shall require authentication via API key or OAuth 2.0 bearer token.  
**NFR-08** — The system shall comply with GDPR and applicable regional data protection regulations.

### 6.4 Availability
**NFR-09** — The service shall target 99.9% uptime (SLA).

### 6.5 Scalability
**NFR-10** — The system shall scale horizontally to handle traffic spikes without degradation in response time.

---

## 7. Scam Pattern Taxonomy

The detection engine shall be capable of identifying the following scam categories:

| Tag | Description | Example |
|---|---|---|
| `urgency` | Artificial time pressure to force hasty action | "Act now or lose your account" |
| `impersonation` | Pretending to be a trusted entity | "Your bank", "HMRC", "Apple Support" |
| `credential_harvesting` | Requests for passwords, PINs, or 2FA codes | "Enter your login to verify" |
| `financial_lure` | Promises of unexpected money or prizes | "You have won £500" |
| `prize_fraud` | Lottery or competition fraud | "Claim your prize today" |
| `threat` | Coercive or threatening language | "Legal action will be taken" |
| `spoofed_url` | URLs that mimic legitimate domains | `paypa1.com`, `amaz0n-support.net` |
| `unsolicited_attachment` | References to unexpected attachments | "Open the invoice attached" |
| `personal_info_request` | Requests for sensitive personal data | "Confirm your NI number" |

---

## 8. Channel-Specific Considerations

### WhatsApp
- Analyze forwarded message indicators (messages marked as "Forwarded many times" carry higher prior risk).
- Flag messages from unknown numbers with high-risk content.

### SMS
- Flag messages containing URLs from non-brand short-link domains.
- Cross-reference sender numbers against known smishing number databases where available.
- Recognize common SMS scam patterns: parcel delivery, bank fraud alerts, HMRC tax refunds.

### Email
- Analyze `From`, `Reply-To`, and envelope sender for domain spoofing and lookalike domains.
- Inspect embedded URLs in HTML email body (not just visible link text).
- Flag mismatches between display name and actual sender domain.
- Check domain age and reputation signals for sender domain.

---

## 9. API Specification

### Endpoint

```
POST /v1/analyze
```

### Request Headers

| Header | Required | Description |
|---|---|---|
| `Authorization` | Yes | `Bearer <token>` or `ApiKey <key>` |
| `Content-Type` | Yes | `application/json` |

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `message_body` | string | Yes | The full text content of the message |
| `channel` | enum | No | `whatsapp`, `sms`, `email`. Defaults to `unknown` |
| `sender` | string | No | Sender phone number, email address, or identifier |
| `subject` | string | No | Email subject line (email channel only) |
| `reply_to` | string | No | Reply-to address (email channel only) |

### Error Responses

| HTTP Status | Code | Description |
|---|---|---|
| 400 | `INVALID_REQUEST` | Missing required fields or malformed payload |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication |
| 413 | `MESSAGE_TOO_LONG` | Message body exceeds 10,000 characters |
| 429 | `RATE_LIMITED` | Request rate limit exceeded |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## 10. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-01 | A submitted phishing email returns `risk_level: critical` and at least one `spoofed_url` or `credential_harvesting` suspicious phrase. |
| AC-02 | A legitimate transactional SMS (e.g., bank OTP) returns `risk_level: low`. |
| AC-03 | The API responds within 2 seconds for a 500-character message body. |
| AC-04 | A message with no suspicious content returns an empty `suspicious_phrases` array. |
| AC-05 | `recommendations` for a `critical` message always include a "do not click" instruction. |
| AC-06 | Submitting a request without an `Authorization` header returns HTTP 401. |
| AC-07 | A message body exceeding 10,000 characters returns HTTP 413. |

---

## 11. Future Considerations

- **Multilingual support:** Extend detection to Spanish, French, Portuguese, Hindi, and Mandarin.
- **Attachment analysis:** Scan PDFs and images for scam indicators using OCR and document analysis.
- **Feedback loop:** Allow users to flag false positives/negatives to improve model accuracy over time.
- **Browser extension:** Surface scam detection results inline in webmail clients.
- **Mobile SDK:** Embed detection directly into iOS/Android apps with on-device inference for privacy-preserving analysis.
- **Threat intelligence integration:** Connect to external feeds (e.g., PhishTank, Google Safe Browsing) for real-time URL reputation.

---

## 12. Open Questions

| # | Question | Owner | Status |
|---|---|---|---|
| 1 | Should message content ever be retained for model retraining, and under what consent model? | Privacy Team | Open |
| 2 | Which regions/languages should be prioritized for v1? | Product Owner | Open |
| 3 | Will URL reputation checks use a third-party API or an internally maintained list? | ML Team | Open |
| 4 | What is the target rate limit per API key (requests per minute)? | Backend Team | Open |
