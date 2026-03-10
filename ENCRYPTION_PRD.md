# Product Requirements Document: User Chat Data Encryption at Rest with Passphrase-Protected Keys

**Document Version:** 2.0
**Date:** 2026-03-10
**Status:** Draft
**Author:** Engineering Team

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Goals & Non-Goals](#3-goals--non-goals)
4. [User Stories](#4-user-stories)
5. [Threat Model](#5-threat-model)
6. [Architecture Overview](#6-architecture-overview)
7. [Detailed Design](#7-detailed-design)
   - 7.1 [Encryption Scheme](#71-encryption-scheme)
   - 7.2 [Key Derivation & Management](#72-key-derivation--management)
   - 7.3 [Passphrase Handling](#73-passphrase-handling)
   - 7.4 [Data Scope — What Gets Encrypted](#74-data-scope--what-gets-encrypted)
   - 7.5 [Database Layer Changes](#75-database-layer-changes)
   - 7.6 [File Storage Encryption](#76-file-storage-encryption)
   - 7.7 [Search Integration](#77-search-integration)
   - 7.8 [Shared Conversations](#78-shared-conversations)
   - 7.9 [Memory / RAG System](#79-memory--rag-system)
   - 7.10 [Streaming & Real-Time Decryption](#710-streaming--real-time-decryption)
8. [Authentication & Key Lifecycle](#8-authentication--key-lifecycle)
9. [Configuration & Environment Variables](#9-configuration--environment-variables)
10. [Migration Strategy](#10-migration-strategy)
11. [Performance Considerations](#11-performance-considerations)
12. [Compliance & Regulatory Mapping](#12-compliance--regulatory-mapping)
13. [API Changes](#13-api-changes)
14. [Frontend Changes](#14-frontend-changes)
15. [Testing Strategy](#15-testing-strategy)
16. [Rollout Plan](#16-rollout-plan)
17. [Risks & Mitigations](#17-risks--mitigations)
18. [Open Questions](#18-open-questions)
19. [Appendix](#19-appendix)

---

## 1. Executive Summary

LibreChat currently stores all user chat data (messages, conversation titles, file metadata, memories) as plaintext in MongoDB. For organizations with strict data-protection and legal requirements (GDPR, BDSG, HIPAA, SOC 2), this is a blocker for adoption.

This PRD defines a **passphrase-protected encryption-at-rest** architecture where every piece of user-generated content is encrypted before it reaches the database. Encryption keys are derived per-user using a combination of a server-side master key, the user's identity, **and a user-held encryption passphrase** so that **neither database access alone nor admin access to the server environment is sufficient to read user data at rest**.

The user's encryption passphrase is entered after authentication (e.g., after OpenID Connect / Azure AD login) and is processed client-side via PBKDF2 before being sent to the server. The server incorporates the derived secret into its key hierarchy, ensuring that an administrator who possesses both the `ENCRYPTION_MASTER_KEY` environment variable and the database **cannot** derive per-user keys without the user's passphrase.

> **Security Properties:** This design protects against database-only breaches, unauthorized DBA access, compromised backups, **and** offline decryption by administrators who control the server environment. The server must still decrypt data during an active user session to call LLM APIs, so an administrator who actively modifies running server code could intercept plaintext transiently. See §5.4 for the full security assessment.

The design integrates with the existing OpenID Connect / Azure AD authentication flow (and all other auth methods) and builds on LibreChat's existing `encryptV3` (AES-256-CTR) cryptographic primitives in `packages/data-schemas/src/crypto/`.

---

## 2. Problem Statement

| Concern | Current State | Required State |
|---|---|---|
| Message content in MongoDB | Plaintext `text` and `content` fields | Encrypted at rest; decryptable only with the owning user's passphrase |
| Conversation titles | Plaintext `title` field | Encrypted at rest |
| File metadata & extracted text | Plaintext `text` field in File documents | Encrypted at rest |
| User memories | Plaintext `value` field | Encrypted at rest |
| Tool call results | Plaintext `result` field | Encrypted at rest |
| Database compromise | Full exposure of all user data | Attacker obtains only ciphertext; no keys stored alongside data |
| Regulatory compliance | Does not meet GDPR Art. 32 / BDSG §64 encryption requirements | Meets encryption-at-rest requirements for regulated industries |
| Admin/DBA access | Full read access to all user content | Admin with master key + DB access sees only ciphertext; passphrase required for decryption |

### Who is affected?

- **Enterprise IT / Compliance Officers** — cannot approve LibreChat deployment without encryption at rest and admin-proof key isolation.
- **End Users** — whose confidential prompts and AI responses are exposed in the database and must be protected even from server administrators.
- **Database Administrators** — who currently have unrestricted access to sensitive user content.

---

## 3. Goals & Non-Goals

### Goals

1. **Encrypt all user-generated content at rest** in MongoDB so that a database dump or unauthorized DB access reveals no plaintext.
2. **Per-user key isolation** — User A's key cannot decrypt User B's data.
3. **Passphrase-protected keys** — Key derivation includes a user-held secret (encryption passphrase) so that no one — including server administrators — can derive decryption keys without the user's cooperation.
4. **Zero plaintext key persistence** — No long-lived decryption keys stored unencrypted on disk or in the database. The wrapped UEK is stored in the database but can only be unwrapped with the user's passphrase-derived secret.
5. **Compatible with all authentication methods** — The encryption passphrase is separate from the login credential. Users log in via OpenID Connect / Azure AD / LDAP / local auth as usual, then enter their encryption passphrase. Key derivation uses `user._id` (stable across all auth providers) plus the passphrase-derived secret.
6. **Backward compatible** — Existing unencrypted deployments can opt in and migrate incrementally.
7. **Opt-in via configuration** — Encryption at rest is enabled by a deployment-level environment variable.
8. **Auditable** — Encryption status is logged; encrypted fields are clearly identifiable in the database.

### Non-Goals

1. **End-to-end encryption (client-side)** — The server must decrypt data to call LLM APIs. This PRD provides the strongest achievable protection within that constraint: admin-proof at-rest encryption with passphrase-derived keys. True E2E where the server never sees plaintext is architecturally incompatible with server-side LLM API calls. See §5.4.
2. **Encrypting LLM API traffic** — Traffic to upstream providers (OpenAI, Azure OpenAI, Anthropic, etc.) is protected by TLS; this PRD does not add an additional encryption layer to those calls.
3. **Encrypting non-user data** — System configuration, model parameters, endpoint settings, and agent definitions that are not user-generated content are out of scope.
4. **Admin data recovery** — If a user loses their encryption passphrase, their encrypted data is unrecoverable by design. An optional admin-recovery mechanism (key escrow) is discussed as a future extension in §18.3 but is explicitly out of scope.
5. **Protection against active code modification** — An administrator who modifies the running server code could intercept plaintext during an active session (e.g., log decrypted data or capture the passphrase-derived secret at login). Protecting against this requires Trusted Execution Environments (TEE), which are out of scope. See Appendix D.
6. **Homomorphic encryption for search** — Full-text search over encrypted data is a known hard problem. This PRD defines a practical approach using encrypted search indexes rather than homomorphic encryption.
7. **Multi-party decryption** — Shared conversations are handled by re-encryption, not by multi-party key schemes.
8. **Transparent UX** — Unlike server-only encryption schemes, this design intentionally requires user interaction (passphrase entry) on each session start. This is the necessary trade-off for admin-proof key isolation.

---

## 4. User Stories

### US-1: Enterprise Compliance Officer
> As a compliance officer, I need assurance that all user chat data stored in our self-hosted LibreChat MongoDB instance is encrypted at rest with passphrase-protected per-user keys, so that a database compromise — or even an admin with server access — does not expose regulated data and we can satisfy GDPR Art. 32 / BDSG §64 audit requirements.

### US-2: End User Setting Up Encryption (First Login)
> As a new employee logging in via Azure AD for the first time after encryption is enabled, I want to be guided to create an encryption passphrase, with a clear explanation that this passphrase protects my chat data and cannot be recovered if lost.

### US-3: End User Returning (Subsequent Login)
> As an employee logging in via Azure AD, I expect to enter my encryption passphrase after authentication so that my chat history is decrypted for my session, and I understand why this extra step is necessary.

### US-4: Database Administrator
> As a DBA, when I query the MongoDB collections directly, I should see only ciphertext for user message content, conversation titles, and memory values, and I should have **no ability** to decrypt this data even if I also have access to the server's environment variables.

### US-5: IT Administrator (Deployment)
> As an IT admin deploying LibreChat, I want to enable passphrase-protected encryption at rest with a single environment variable toggle, configure passphrase policy (minimum length, PBKDF2 iterations), and have the system handle key management, so that setup remains simple.

### US-6: Existing Deployment Migration
> As an admin of an existing LibreChat deployment, I want to migrate my existing plaintext data to encrypted form without downtime. Each user sets their passphrase on their next login, and their data is encrypted at that point.

### US-7: User Sharing a Conversation
> As a user, I want to continue sharing conversations via shared links even after encryption is enabled, so that collaboration workflows are not broken.

### US-8: User Changing Passphrase
> As a user, I want to change my encryption passphrase by entering my current passphrase and a new one, so that my data remains accessible under the new passphrase.

### US-9: User Who Forgot Passphrase
> As a user who forgot my encryption passphrase, I understand that my previously encrypted data is permanently unrecoverable, but I can reset my encryption (losing old data) and start fresh with a new passphrase.

---

## 5. Threat Model

### 5.1 Assets

| Asset | Sensitivity | Location |
|---|---|---|
| Message text/content | High — may contain PII, trade secrets, regulated data | MongoDB `messages` collection |
| Conversation titles | Medium — may reveal topics | MongoDB `conversations` collection |
| File extracted text | High — may contain document content | MongoDB `files` collection |
| User memories | High — persistent user context | MongoDB `memories` collection |
| Tool call results | Medium — may contain external data | MongoDB `toolcalls` collection |
| User Encryption Key (UEK) | Critical — decrypts all user data | Random 256-bit; stored wrapped (encrypted) in User document |
| Key Encryption Key (KEK) | Critical — wraps UEK for storage | Derived from master key + user ID + **user passphrase**; exists only in memory |
| User passphrase | Critical — required for key derivation | Known only to the user; never stored; PBKDF2-derived secret sent once per session over TLS |
| Passphrase salt | Low — public parameter for PBKDF2 | Stored in User document |

### 5.2 Threat Actors

| Actor | Capability | Mitigated By |
|---|---|---|
| **External attacker with DB access** | Reads/dumps MongoDB collections | All user content is ciphertext; wrapped UEK requires passphrase to unwrap |
| **Malicious DBA** | Queries collections, reads documents | Per-user encryption; DBA sees only ciphertext; cannot derive KEK without user passphrase |
| **Compromised backup** | Reads MongoDB backup files | Backup contains only ciphertext and wrapped keys; passphrase not in backup |
| **Rogue server admin with env access** | Reads environment variables and database | ✅ **MITIGATED for offline attack.** Admin has `ENCRYPTION_MASTER_KEY` and `user._id` but NOT the user's passphrase. Cannot derive KEK offline. See §5.4. |
| **Admin who modifies running code** | Injects logging/exfiltration into server | **⚠️ NOT MITIGATED.** Can intercept passphrase-derived secret at login or plaintext during LLM calls. Requires active code modification. See §5.4. |
| **Compromised application server** | Full memory access during runtime | **Accepted risk** — server must process plaintext for LLM calls; UEKs cached in memory during active sessions only. See §5.4. |
| **Other authenticated user** | Accesses API endpoints | Per-user key isolation; authorization checks unchanged |

### 5.3 Accepted Risks

- **Server-side plaintext processing**: The server must decrypt data to send it to LLM providers. A fully compromised running server can access plaintext during a user's active session. This is inherent to the architecture and mitigated by standard server hardening and session-scoped key caching.
- **Memory-resident keys**: User encryption keys exist in server memory during active sessions. Mitigated by session-scoped key caching with TTL eviction.
- **Active code modification attack**: An administrator who modifies the running server code can intercept the passphrase-derived secret during login or capture plaintext during LLM calls. This requires deliberate, active tampering — not passive access to credentials. Mitigated by code review, deployment controls, and audit logging.
- **Lost passphrase = permanent data loss**: If a user forgets their encryption passphrase, their historical encrypted data is unrecoverable. This is by design — it is the necessary cost of admin-proof key isolation. See §17 for UX mitigations.

### 5.4 Security Assessment

> **This section provides an honest assessment of what this design protects against and what it does not.**

#### The Key Question: Can an Admin Read User Chats Offline?

**Short answer: No.** An administrator who controls both the application deployment environment and the database **cannot** decrypt user data offline because the key derivation chain includes a user-held secret.

#### Why: The Key Derivation Chain Includes a User Secret

The key hierarchy is:

```
ENCRYPTION_MASTER_KEY (env var, known to deployer)
    + user._id (in database, known to DBA)
    + sessionSecret (derived from user passphrase via PBKDF2; known ONLY to user)
    → KEK (derived via HKDF)
    → unwrap encryptedUEK (stored in database User document)
    → UEK (can now decrypt all user data)
```

**The passphrase-derived `sessionSecret` is the critical difference.** An admin can read `ENCRYPTION_MASTER_KEY` from the environment and `user._id` from the database, but they **cannot** derive the `sessionSecret` without the user's passphrase. The `sessionSecret` is:

- Derived client-side via PBKDF2 (600,000 iterations of SHA-256)
- Sent to the server once per session over TLS
- Never stored on the server (not in the database, not on disk, not in environment variables)
- Held in server memory only for the duration of KEK derivation (milliseconds)
- The UEK is then cached; the sessionSecret is discarded

An admin attempting offline decryption would need to:

1. Read `ENCRYPTION_MASTER_KEY` from the environment ✅ (has access)
2. Read `user._id` and `encryptedUEK` from MongoDB ✅ (has access)
3. Read `passphraseSalt` from the User document ✅ (has access)
4. Derive `sessionSecret = PBKDF2(passphrase, passphraseSalt, 600000, SHA-256)` ❌ **Does not know the passphrase**
5. Derive `KEK = HKDF(masterKey, userId + sessionSecret, "librechat-kek")` ❌ **Cannot compute**

**Step 4 blocks the entire chain.** The admin would need to brute-force the user's passphrase through 600,000-iteration PBKDF2, which is computationally expensive by design.

#### What This Design Protects Against

| Threat | Protected? | Explanation |
|---|---|---|
| **Database breach (stolen dump/backup)** | ✅ **Yes** | Attacker has only ciphertext and wrapped keys; no master key or passphrase |
| **Unauthorized DBA access** | ✅ **Yes** | DBA sees only ciphertext; cannot derive KEK without passphrase |
| **Admin with master key + DB access (offline)** | ✅ **Yes** | KEK derivation requires user's passphrase; admin does not have it |
| **Cross-user access via API** | ✅ **Yes** | Per-user key isolation; User A's passphrase cannot derive User B's KEK |
| **Accidental data exposure in logs** | ✅ **Yes** | Database fields contain ciphertext |
| **Compliance (GDPR Art. 32, HIPAA, SOC 2)** | ✅ **Yes** | Meets encryption-at-rest requirements; exceeds by including admin-proof key isolation |
| **Third-party MongoDB hosting (Atlas)** | ✅ **Yes** | Cloud provider employees cannot read user data |
| **Separation of duties (DBA ≠ DevOps)** | ✅ **Yes** | Neither can unilaterally decrypt — and combined access is also insufficient |

#### What This Design Does NOT Protect Against

| Threat | Protected? | Explanation |
|---|---|---|
| **Admin who modifies running server code** | ❌ **No** | Can add logging to intercept sessionSecret at login or plaintext during LLM calls. Requires **active tampering**, not passive access. |
| **Admin who inspects process memory of active sessions** | ❌ **No** | UEKs are cached in-process during active sessions; memory dump reveals active users' keys. Requires **active intrusion**. |
| **Compromised LLM provider** | ❌ **No** | Plaintext is sent to LLM APIs over TLS; the provider sees it (out of scope) |
| **Brute-force attack on weak passphrase** | ⚠️ **Partially** | 600K PBKDF2 iterations make brute-force expensive but not impossible for weak passphrases. Mitigated by passphrase policy enforcement (minimum length, complexity). |

#### The Critical Improvement Over Server-Only Encryption

The previous v1.x design (server-only key derivation without a user passphrase) allowed any admin with `ENCRYPTION_MASTER_KEY` + DB access to write a standalone script and decrypt all user data offline, with no user cooperation, no running application, and no trace. This was a fundamental limitation documented in v1.x §5.4.

**This design closes that gap.** The only remaining admin attack vector requires:
1. Active modification of production code (detectable via CI/CD, code review, binary signing)
2. Waiting for a target user to log in (temporal constraint)
3. Intercepting the transient plaintext or sessionSecret (requires code change in the auth or encryption service)

This changes the threat from **"passive offline access at any time"** to **"active, detectable, targeted attack during a user session."** This is a categorically different (and much harder) attack.

#### Remaining Enhancements for Even Stronger Protection

| Enhancement | What It Addresses | Complexity | Trade-offs |
|---|---|---|---|
| **Hardware Security Module (HSM)** | Master key never leaves tamper-proof hardware | High | Cost; vendor lock-in |
| **Trusted Execution Environment (TEE)** | Plaintext processing in isolated memory; even root cannot inspect | Very High | Hardware requirements; Intel SGX or AWS Nitro Enclaves |
| **Audit logging of key access** | Creates accountability trail for key derivation and passphrase submission | Medium | Useful as a deterrent; helps detect misuse after the fact |
| **Binary signing / attestation** | Ensures server code has not been tampered with | Medium | Operational complexity; requires trusted build pipeline |
| **Optional admin key escrow** | Allows admin recovery of user data with user consent | Medium | Weakens the "admin cannot decrypt" guarantee; must be opt-in |

---

## 6. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          CLIENT (Browser)                                │
│                                                                          │
│  ┌───────────┐   ┌──────────────┐   ┌──────────────────────────────────┐│
│  │  Azure AD  │──▶│ OIDC Login   │──▶│ JWT + Session Established       ││
│  │  / IdP     │   │  Callback    │   │ (auth complete, no encryption   ││
│  │  / Local   │   │              │   │  keys yet)                      ││
│  └───────────┘   └──────────────┘   └──────────┬───────────────────────┘│
│                                                  │                        │
│  ┌───────────────────────────────────────────────▼───────────────────────┐│
│  │              PASSPHRASE PROMPT (post-login)                           ││
│  │  1. User enters encryption passphrase                                 ││
│  │  2. Fetch passphraseSalt from server (GET /api/auth/encryption-salt)  ││
│  │  3. Derive sessionSecret = PBKDF2(passphrase, salt, 600000, SHA-256) ││
│  │  4. Send sessionSecret to server (POST /api/auth/unlock-encryption)   ││
│  │  5. sessionSecret is 256-bit; sent once over TLS                      ││
│  └───────────────────────────────────┬───────────────────────────────────┘│
└──────────────────────────────────────┼───────────────────────────────────┘
                                       │ TLS (sessionSecret + JWT)
┌──────────────────────────────────────▼───────────────────────────────────┐
│                       APPLICATION SERVER                                  │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │              ENCRYPTION UNLOCK ENDPOINT                             │  │
│  │  1. Receive sessionSecret from client                              │  │
│  │  2. Derive KEK = HKDF(ENCRYPTION_MASTER_KEY,                      │  │
│  │                        userId + sessionSecret,                      │  │
│  │                        "librechat-kek")                             │  │
│  │  3. Fetch wrapped UEK from User document                           │  │
│  │  4. Unwrap UEK using KEK                                           │  │
│  │  5. Discard sessionSecret from memory                              │  │
│  │  6. Cache UEK in memory (session-scoped, TTL)                      │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                    ENCRYPTION SERVICE                               │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │  │
│  │  │ encryptField │  │ decryptField │  │ Key Derivation           │  │  │
│  │  │ (AES-256-   │  │ (AES-256-    │  │ (HKDF-SHA-256 + PBKDF2) │  │  │
│  │  │  GCM)       │  │  GCM)        │  │                          │  │  │
│  │  └─────────────┘  └──────────────┘  └──────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                  DATA ACCESS LAYER                                  │  │
│  │  Mongoose Middleware (pre-save / post-find hooks)                   │  │
│  │  • Pre-save: encrypt sensitive fields                               │  │
│  │  • Post-find: decrypt sensitive fields                              │  │
│  │  • Transparent to business logic                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
└──────────────────────────────────────┬───────────────────────────────────┘
                                       │ Encrypted data
┌──────────────────────────────────────▼───────────────────────────────────┐
│                           MONGODB                                         │
│  ┌──────────┐ ┌──────────────┐ ┌────────┐ ┌──────────┐ ┌─────────────┐ │
│  │ messages │ │conversations │ │ files  │ │ memories │ │  toolcalls  │ │
│  │(encrypted│ │(encrypted    │ │(encrypt│ │(encrypted│ │ (encrypted  │ │
│  │ text,    │ │ title)       │ │ text)  │ │ value)   │ │  result)    │ │
│  │ content) │ │              │ │        │ │          │ │             │ │
│  └──────────┘ └──────────────┘ └────────┘ └──────────┘ └─────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

### Key Hierarchy

```
User Passphrase (known only to user, never stored)
        │
        ▼
   ┌──────────┐
   │  PBKDF2  │◀── passphraseSalt (stored in User doc) + 600,000 iterations
   └────┬─────┘
        │
        ▼
  sessionSecret (256-bit, derived client-side, sent once over TLS)
        │
        ▼
ENCRYPTION_MASTER_KEY (env var, 256-bit, hex-encoded)
   +    │
   userId (from User document)
   +    │
   sessionSecret
        │
        ▼
   ┌─────────┐
   │  HKDF   │◀── salt = userId + sessionSecret, info = "librechat-kek"
   └────┬────┘
        │
        ▼
 KEK (Key Encryption Key) — per-user, requires passphrase to derive
        │
        ▼  Wraps/Unwraps
 UEK (User Encryption Key) — per-user, random 256-bit
        │  Stored encrypted as user.encryptedUEK in User document
        │
        ▼  Encrypts/Decrypts
 User Data (messages, titles, memories, files, tool results)
```

---

## 7. Detailed Design

### 7.1 Encryption Scheme

#### Algorithm Selection

| Property | Choice | Rationale |
|---|---|---|
| Cipher | **AES-256-GCM** | Authenticated encryption; detects tampering; NIST-approved; native Node.js `crypto` support |
| Server Key Derivation | **HKDF-SHA-256** | Standardized (RFC 5869); deterministic; used by WebCrypto and Node.js |
| Client Key Derivation | **PBKDF2-SHA-256** | Standardized (RFC 8018); slow by design; 600,000 iterations; native WebCrypto support in all browsers (no WASM/JS library needed — see rationale below) |
| Key Wrapping | **AES-256-KW** (RFC 3394) or AES-256-GCM envelope | Wrap UEK with KEK for storage |
| IV/Nonce | **96-bit random per encryption** | GCM standard nonce size; generated via `crypto.randomBytes(12)` |
| Auth Tag | **128-bit** | Full GCM authentication tag |

> **Why AES-256-GCM over AES-256-CTR (existing encryptV3)?**
> GCM provides authenticated encryption (integrity + confidentiality). CTR provides only confidentiality. For user data at rest, we need tamper detection to prevent silent data corruption.

> **Why PBKDF2 on the client instead of Argon2id?**
> PBKDF2 is natively available in all browsers via the WebCrypto API (`crypto.subtle.deriveBits`). Argon2id is memory-hard and more brute-force-resistant, but requires a WASM or JS library to run in the browser, adding ~100 KB to the bundle and introducing a supply-chain dependency. PBKDF2 with 600,000 iterations provides adequate protection for reasonable passphrases and aligns with OWASP recommendations (2023).

#### Ciphertext Format

```
enc1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>
```

- `enc1` — Version prefix for future algorithm migration
- `iv_hex` — 24 hex characters (12 bytes)
- `auth_tag_hex` — 32 hex characters (16 bytes)
- `ciphertext_hex` — Variable length

#### Integration with Existing Crypto Module

New functions will be added to `packages/data-schemas/src/crypto/`:

```typescript
// packages/data-schemas/src/crypto/userEncryption.ts

export function deriveKEK(masterKey: Buffer, userId: string, sessionSecret: Buffer): Buffer;
export function generateUEK(): Buffer;
export function wrapUEK(uek: Buffer, kek: Buffer): string;
export function unwrapUEK(wrappedUEK: string, kek: Buffer): Buffer;
export function encryptUserData(plaintext: string, uek: Buffer): string;
export function decryptUserData(ciphertext: string, uek: Buffer): string;
export function isEncrypted(value: string): boolean;
export function generatePassphraseSalt(): Buffer;
```

### 7.2 Key Derivation & Management

#### Key Derivation Formula

```
Client-side (browser):
  sessionSecret = PBKDF2(
    password  = passphrase (user input, UTF-8 encoded),
    salt      = passphraseSalt (32 bytes, stored in User document),
    iterations = 600,000,
    hash      = SHA-256,
    keyLength = 256 bits
  )

Server-side:
  KEK = HKDF-SHA-256(
    ikm    = ENCRYPTION_MASTER_KEY (32 bytes from env var),
    salt   = concat(userId, sessionSecret),
    info   = "librechat-kek",
    length = 32 bytes
  )
```

The `sessionSecret` is the bridge between the user's passphrase and the server's key hierarchy. It is:
- **Derived client-side**: The raw passphrase never leaves the browser
- **Sent once per session**: Over TLS, in the `POST /api/auth/unlock-encryption` request body
- **Used transiently on the server**: Only held in memory for the ~0.1 ms needed to derive KEK and unwrap UEK
- **Never stored**: Not persisted to disk, database, or environment variables

#### Key Lifecycle

```
1. FIRST LOGIN — PASSPHRASE SETUP (no encryptedUEK on User document)
   ├── Client: User chooses encryption passphrase
   ├── Server: Generate passphraseSalt = crypto.randomBytes(32)
   ├── Server: Store passphraseSalt on User document
   ├── Client: sessionSecret = PBKDF2(passphrase, passphraseSalt, 600000, SHA-256)
   ├── Client: Send sessionSecret to server
   ├── Server: Derive KEK = HKDF(ENCRYPTION_MASTER_KEY, userId + sessionSecret, "librechat-kek")
   ├── Server: Generate UEK = crypto.randomBytes(32)
   ├── Server: Wrap: encryptedUEK = AES-256-GCM(UEK, KEK)
   ├── Server: Store encryptedUEK on User document
   ├── Server: Discard sessionSecret; cache UEK in memory (session-scoped)
   └── Encryption is now active for this user

2. SUBSEQUENT LOGIN — PASSPHRASE ENTRY
   ├── Client: User enters encryption passphrase
   ├── Client: Fetch passphraseSalt from GET /api/auth/encryption-salt
   ├── Client: sessionSecret = PBKDF2(passphrase, passphraseSalt, 600000, SHA-256)
   ├── Client: Send sessionSecret to POST /api/auth/unlock-encryption
   ├── Server: Derive KEK = HKDF(ENCRYPTION_MASTER_KEY, userId + sessionSecret, "librechat-kek")
   ├── Server: Fetch encryptedUEK from User document
   ├── Server: Unwrap: UEK = decrypt(encryptedUEK, KEK)
   │           (If decryption fails → wrong passphrase → return 401)
   ├── Server: Discard sessionSecret; cache UEK in memory (session-scoped)
   └── Session is now unlocked

3. ACTIVE SESSION
   ├── UEK cached in in-memory store (Map or Redis)
   ├── TTL: matches session/JWT expiry
   ├── Used for all encrypt/decrypt operations
   └── Evicted on logout or TTL expiry

4. PASSPHRASE CHANGE (user-initiated)
   ├── Client: User enters current passphrase and new passphrase
   ├── Client: Derive oldSessionSecret from current passphrase
   ├── Client: Derive newSessionSecret from new passphrase (with new salt)
   ├── Client: Send both to POST /api/auth/change-passphrase
   ├── Server: Derive oldKEK, unwrap UEK
   │           (If fails → wrong current passphrase → return 401)
   ├── Server: Generate new passphraseSalt
   ├── Server: Derive newKEK = HKDF(ENCRYPTION_MASTER_KEY, userId + newSessionSecret, "librechat-kek")
   ├── Server: Re-wrap: newEncryptedUEK = AES-256-GCM(UEK, newKEK)
   ├── Server: Update passphraseSalt and encryptedUEK on User document
   └── Data re-encryption NOT needed (UEK unchanged, only KEK changed)

5. MASTER KEY ROTATION (admin-triggered)
   ├── Requires each user to provide their passphrase (cannot be done without user)
   ├── On next login: derive KEK with old master key, unwrap UEK
   ├── Derive new KEK with new master key + same passphrase
   ├── Re-wrap UEK with new KEK
   ├── Update encryptedUEK on User document
   └── Data re-encryption NOT needed (UEK unchanged)
```

#### User Document Schema Addition

```typescript
// Addition to User schema in packages/data-schemas/src/schema/user.ts
{
  encryptedUEK: {
    type: String,
    select: false,  // Never returned in normal queries
  },
  passphraseSalt: {
    type: String,   // 32-byte salt, hex-encoded; used for PBKDF2 client-side
    select: false,
  },
  encryptionVersion: {
    type: Number,
    default: 0,  // 0 = unencrypted, 1 = enc1 passphrase-protected scheme
  },
}
```

#### In-Memory Key Cache

```typescript
// packages/api/src/crypto/keyCache.ts

interface CachedKey {
  uek: Buffer;
  expiresAt: number;
}

class UserKeyCache {
  private cache: Map<string, CachedKey>;
  private ttlMs: number; // Default: 15 minutes, configurable

  getUEK(userId: string): Buffer | null;
  setUEK(userId: string, uek: Buffer): void;
  evict(userId: string): void;
  evictExpired(): void;  // Called periodically
}
```

For multi-instance deployments, the key cache can optionally use Redis with encrypted values. The cache key is the user ID; the cache value is the UEK encrypted with a per-instance ephemeral key that exists only in memory.

### 7.3 Passphrase Handling

#### Passphrase Policy

Configurable via environment variables (see §9):

| Policy | Default | Rationale |
|---|---|---|
| Minimum length | 12 characters | OWASP recommendation for user-chosen secrets |
| Maximum length | 128 characters | Prevent DoS via extremely long inputs to PBKDF2 |
| PBKDF2 iterations | 600,000 | OWASP 2023 recommendation for SHA-256; ~300ms on modern hardware |
| Complexity requirements | None (length-based) | NIST SP 800-63B recommends against complexity rules; length is more effective |

#### Passphrase vs. Login Password

The encryption passphrase is **completely separate** from the user's login credential:

| Property | Login Credential | Encryption Passphrase |
|---|---|---|
| Purpose | Authenticate identity | Protect encryption keys |
| Provider | OpenID Connect / Azure AD / LDAP / local | User-chosen, managed by LibreChat |
| Storage | Managed by IdP (or bcrypt hash for local) | **Never stored** — only the PBKDF2 salt is stored |
| Recovery | IdP password reset / admin reset | **No recovery** — lost passphrase = data loss |
| Change frequency | Per IdP policy | User-initiated only |
| Scope | Session authentication | Encryption key derivation |

This separation means:
- **OIDC users**: Log in via Azure AD → then enter encryption passphrase
- **LDAP users**: Log in via LDAP → then enter encryption passphrase
- **Local users**: Log in via email/password → then enter encryption passphrase
- **All auth methods**: Same passphrase UX regardless of auth provider

#### Wrong Passphrase Detection

When a user enters the wrong passphrase:
1. Client derives `sessionSecret` from the wrong passphrase
2. Server derives a wrong `KEK`
3. Server attempts to unwrap `encryptedUEK` — AES-256-GCM decryption fails (auth tag mismatch)
4. Server returns `401 Unauthorized` with `{ "error": "invalid_passphrase" }`
5. Client prompts user to re-enter passphrase
6. After N failed attempts (configurable, default: 5), enforce a cooldown period (exponential backoff)

#### Passphrase Reset (Data Loss)

If a user irrecoverably forgets their passphrase:

```
1. User requests passphrase reset via UI
2. System warns: "All your encrypted chat history, memories, and files will be permanently deleted."
3. User confirms (double confirmation required)
4. Server:
   a. Delete all encrypted data for this user (messages, conversations, memories, files, tool calls)
   b. Remove encryptedUEK and passphraseSalt from User document
   c. Set encryptionVersion = 0
5. On next login: user is prompted to set up a new passphrase (fresh start)
```

### 7.4 Data Scope — What Gets Encrypted

#### Encrypted Fields by Collection

| Collection | Field | Type | Notes |
|---|---|---|---|
| **messages** | `text` | String | Primary message content |
| **messages** | `content` | Array\<Mixed\> | Rich content parts (serialized to JSON string before encryption) |
| **messages** | `feedback.text` | String | User feedback comments |
| **conversations** | `title` | String | Conversation title |
| **conversations** | `system` | String | System prompt (may contain sensitive instructions) |
| **conversations** | `promptPrefix` | String | Custom prompt prefix |
| **files** | `text` | String | Extracted file text content |
| **memories** | `value` | String | Memory content |
| **memories** | `key` | String | Memory key (may reveal topics) |
| **toolcalls** | `result` | Mixed | Tool execution results (serialized before encryption) |
| **sharedLinks** | *(none — see §7.8)* | — | Shared data is re-encrypted or stored separately |

#### Fields NOT Encrypted (Intentionally)

| Collection | Field | Reason |
|---|---|---|
| **messages** | `messageId`, `conversationId`, `user` | Required for indexing and access control |
| **messages** | `sender`, `model`, `endpoint` | Metadata needed for routing; not user-generated content |
| **messages** | `isCreatedByUser`, `tokenCount` | Structural metadata |
| **messages** | `parentMessageId`, `thread_id` | Required for conversation tree traversal |
| **messages** | `createdAt`, `updatedAt` | Required for sorting and pagination |
| **conversations** | `conversationId`, `user` | Required for indexing |
| **conversations** | `endpoint`, `model`, `agent_id` | Configuration metadata |
| **conversations** | `tags` | Required for filtering (see search section for encrypted alternative) |
| **conversations** | `isArchived`, `expiredAt` | Structural flags |
| **files** | `filename`, `filepath`, `type`, `bytes` | Required for file serving; filename may be encrypted in future version |
| **all** | `_id`, `__v` | MongoDB internal fields |

### 7.5 Database Layer Changes

#### Mongoose Middleware Approach

Encryption and decryption will be handled transparently via Mongoose middleware (hooks) so that business logic remains unchanged.

```typescript
// packages/data-schemas/src/middleware/encryption.ts

/**
 * Creates Mongoose pre-save middleware that encrypts specified fields.
 * Attached to schemas that contain user-sensitive data.
 */
export function createEncryptionMiddleware(
  fields: string[],
  options?: { serializeArrayFields?: string[] }
): {
  preSave: mongoose.PreSaveMiddleware;
  postFind: mongoose.PostFindMiddleware;
  postFindOne: mongoose.PostFindOneMiddleware;
  postFindOneAndUpdate: mongoose.PostFindOneAndUpdateMiddleware;
};
```

**Pre-Save Hook** (encrypt before write):
```
1. Check if ENCRYPTION_ENABLED is true
2. For each sensitive field in the document:
   a. If field value is not already encrypted (no "enc1:" prefix):
      i.   Get UEK from request context (AsyncLocalStorage)
      ii.  If UEK is not available (user has not unlocked encryption), reject the write
      iii. If field is an array/object, JSON.stringify() first
      iv.  Encrypt: ciphertext = encryptUserData(plaintext, uek)
      v.   Set field to ciphertext
3. Mark document with encryptionVersion = 1
```

**Post-Find Hook** (decrypt after read):
```
1. Check if ENCRYPTION_ENABLED is true
2. For each document in result:
   a. If document.encryptionVersion > 0:
      i.   Get UEK from request context (AsyncLocalStorage)
      ii.  If UEK is not available, return document with encrypted fields intact
           (frontend handles "encryption locked" state)
      iii. For each sensitive field:
           - If value starts with "enc1:":
             decrypt: plaintext = decryptUserData(ciphertext, uek)
           - If field was serialized, JSON.parse() after decrypt
      iv.  Return decrypted document
   b. Else: return as-is (unencrypted legacy document)
```

#### Request Context for Key Passing

The UEK must flow from the authentication middleware to the database layer without threading it through every function call. This is achieved via Node.js `AsyncLocalStorage`:

```typescript
// packages/api/src/crypto/encryptionContext.ts

import { AsyncLocalStorage } from 'node:async_hooks';

interface EncryptionContext {
  uek: Buffer;
  userId: string;
}

export const encryptionStore = new AsyncLocalStorage<EncryptionContext>();

// Middleware usage:
app.use((req, res, next) => {
  if (encryptionEnabled && req.user) {
    const uek = keyCache.getUEK(req.user.id);
    if (uek) {
      encryptionStore.run({ uek, userId: req.user.id }, next);
    } else {
      // UEK not in cache — encryption not unlocked for this session
      // Allow request to proceed but without decryption capability
      next();
    }
  } else {
    next();
  }
});
```

#### Handling `findOneAndUpdate` with `$set`

Many LibreChat operations use `findOneAndUpdate` with `$set` rather than `save()`. The encryption middleware must also intercept update operations:

```typescript
// Pre-findOneAndUpdate hook
schema.pre('findOneAndUpdate', function (next) {
  if (!encryptionEnabled) return next();
  const update = this.getUpdate();
  if (update.$set) {
    for (const field of encryptedFields) {
      if (update.$set[field] && !isEncrypted(update.$set[field])) {
        const ctx = encryptionStore.getStore();
        if (!ctx?.uek) return next(new Error('ENCRYPTION_LOCKED: Enter passphrase to unlock encryption'));
        update.$set[field] = encryptUserData(update.$set[field], ctx.uek);
      }
    }
  }
  next();
});
```

### 7.6 File Storage Encryption

#### Database File Metadata

The `text` field in File documents (extracted file content) is encrypted using the same Mongoose middleware approach as messages.

#### Binary File Storage

For files stored in local filesystem or S3:

**Option A — Application-Layer Encryption (Recommended)**:
```
Upload Flow:
1. Client uploads file via multipart/form-data
2. Server receives file in memory/temp
3. Server encrypts file content: encryptedBuffer = AES-256-GCM(fileBuffer, UEK)
4. Server stores encrypted file to storage backend
5. Server saves encrypted metadata to MongoDB

Download Flow:
1. Server fetches encrypted file from storage backend
2. Server decrypts: fileBuffer = AES-256-GCM-decrypt(encryptedBuffer, UEK)
3. Server streams decrypted file to client
```

**Option B — S3 Server-Side Encryption (Complementary)**:
For S3 deployments, enable SSE-S3 or SSE-KMS as an additional layer. This does not replace application-layer encryption but adds defense-in-depth.

#### File Encryption Format

For binary files, use a header-based format:

```
[4 bytes: magic "ENC1"]
[4 bytes: header length (big-endian uint32)]
[header: JSON { "iv": "<hex>", "tag": "<hex>", "origSize": <number> }]
[remaining: ciphertext]
```

### 7.7 Search Integration

#### Challenge

MeiliSearch requires plaintext to build search indexes. With encrypted data, the current approach of indexing `text`, `title`, `content`, and `tags` fields breaks.

#### Solution: Encrypted Search Index with Server-Side Decryption

**Approach — Search at Query Time (Recommended for Security)**:

When encryption is enabled, MeiliSearch integration behavior changes:

1. **Index only non-sensitive metadata**: `messageId`, `conversationId`, `user`, `sender`, `model`, `endpoint`, `createdAt`, `isCreatedByUser`.
2. **Disable full-text search on message content**: The MeiliSearch `text` and `content` fields are not indexed when encryption is enabled.
3. **Provide MongoDB-based search fallback**:
   - For conversation title search: Fetch all user conversations (paginated), decrypt titles in-memory, filter by search term.
   - For message search: Fetch messages by conversation, decrypt in-memory, filter by search term.
4. **Performance mitigation**: Use cursor-based pagination to limit the decryption scope per request. Add a `SEARCH_MAX_DECRYPT_BATCH` config (default: 500) to cap the number of documents decrypted per search request.

**Future Enhancement — Blind Index**:

A blind index approach can restore efficient search without exposing plaintext:

```
blindIndex = HMAC-SHA-256(UEK, lowercase(searchTerm))
```

- Store blind indexes for each word/token in the message.
- Search by computing HMAC of search term and matching against blind indexes.
- Limitation: exact word match only (no fuzzy search, no substring matching).
- This can be implemented as a future enhancement.

#### Configuration

```env
# When ENCRYPT_USER_DATA=true, controls search behavior
ENCRYPTED_SEARCH_MODE=fallback  # "fallback" | "blind_index" | "disabled"
SEARCH_MAX_DECRYPT_BATCH=500
```

### 7.8 Shared Conversations

#### Challenge

Shared conversations must be readable by users other than the owner. The owner's UEK cannot be shared.

#### Solution: Re-Encryption on Share Creation

When a user creates a shared link:

```
1. Server decrypts messages using owner's UEK (requires active session — user must be logged in)
2. If share is PUBLIC (isPublic=true):
   a. Generate a per-share symmetric key (ShareKey)
   b. Encrypt messages with ShareKey
   c. Store ShareKey encrypted with ENCRYPTION_MASTER_KEY in SharedLink document
   d. On access: server derives key from master, decrypts ShareKey, decrypts messages
3. If share is PRIVATE:
   a. Same as public, but access requires authentication
   b. ShareKey stored encrypted in SharedLink document
```

#### Schema Addition for SharedLink

```typescript
{
  encryptedShareKey: {
    type: String,   // ShareKey wrapped with master-derived key
    select: false,
  },
  encryptionVersion: {
    type: Number,
    default: 0,
  },
}
```

#### Trade-Off

- **Pro**: Owner's UEK is never exposed. Share access is controlled by the server.
- **Con**: The server (via ENCRYPTION_MASTER_KEY) can decrypt shared conversations. This is acceptable because shared conversations are intentionally shared — the user has explicitly chosen to make this data accessible.
- **Note**: Shared links created while the user's session is active. The user's passphrase is NOT needed by the recipient — only the server's master key is needed for the shared copy.

### 7.9 Memory / RAG System

#### Memory Encryption

User memories (`key` and `value` fields) are encrypted using the same Mongoose middleware as messages. The `tokenCount` field remains unencrypted for quota enforcement.

#### Impact on Memory Injection

When memories are injected into agent system prompts:

```
1. Fetch user memories from MongoDB (encrypted)
2. Post-find hook decrypts values automatically (UEK from session cache)
3. Format memories into prompt string
4. Send to LLM (plaintext, over TLS)
```

No changes to the memory injection logic are needed; the Mongoose middleware handles decryption transparently. Memory operations require an active (unlocked) encryption session.

#### RAG / File Search

For agent file search (tool_resources.file_search):
- File content stored in vector databases or search indexes must use the same encryption approach as MeiliSearch (§7.7).
- When encryption is enabled, file embeddings are generated from decrypted content at query time rather than pre-computed.
- This has performance implications addressed in §11.

### 7.10 Streaming & Real-Time Decryption

#### SSE Streaming (Chat Responses)

LLM responses are streamed via Server-Sent Events (SSE). The encryption layer operates on the **storage path**, not the streaming path:

```
LLM API ──(TLS)──▶ Server ──(SSE/TLS)──▶ Client
                      │
                      ▼ (async, after stream completes)
               encryptUserData(fullResponse, UEK)
                      │
                      ▼
                   MongoDB (ciphertext)
```

- Streaming to the client is unaffected — the response is sent to the client in real-time over TLS.
- Encryption occurs when the complete message is saved to MongoDB after streaming completes.
- Partial/incomplete messages (`unfinished: true`) are also encrypted on save.
- The UEK must be available in the session cache for the entire duration of the streaming request.

---

## 8. Authentication & Key Lifecycle

### 8.1 Login Flow (All Authentication Methods)

The encryption passphrase flow is the **same** regardless of authentication method (OIDC, LDAP, SAML, local, social). Authentication and encryption unlock are two separate steps:

```
STEP 1: AUTHENTICATION (unchanged — existing flow)

  1. User initiates login via their configured auth method:
     - OpenID Connect → redirected to Azure AD / Google / etc. → callback
     - LDAP → username/password validated against directory
     - Local → email/password validated against bcrypt hash
     - Social (GitHub, Discord, etc.) → OAuth flow → callback
  2. Auth strategy locates or creates User document
  3. JWT + refresh token issued
  4. User is now authenticated but encryption is NOT yet unlocked

STEP 2: ENCRYPTION UNLOCK (new — passphrase prompt)

  5. If ENCRYPT_USER_DATA=true:
     a. Frontend checks if user has encryption set up:
        - GET /api/auth/encryption-salt
        - If 404 → user has no passphrase → redirect to passphrase setup
        - If 200 → user has passphrase → show passphrase prompt

  6. FIRST TIME (passphrase setup):
     a. Frontend shows "Set Up Encryption Passphrase" dialog
     b. User enters and confirms passphrase
     c. Frontend: POST /api/auth/setup-encryption
        - Server generates passphraseSalt = crypto.randomBytes(32)
        - Server returns { passphraseSalt: "<hex>" }
     d. Frontend: sessionSecret = PBKDF2(passphrase, passphraseSalt, 600000, SHA-256)
     e. Frontend: POST /api/auth/unlock-encryption { sessionSecret: "<hex>" }
     f. Server:
        - KEK = HKDF(ENCRYPTION_MASTER_KEY, userId + sessionSecret, "librechat-kek")
        - UEK = crypto.randomBytes(32)
        - encryptedUEK = wrapUEK(UEK, KEK)
        - Store encryptedUEK + passphraseSalt on User document
        - Cache UEK in keyCache with TTL
        - Return { status: "encryption_active" }
     g. Discard sessionSecret from server memory

  7. SUBSEQUENT LOGIN (passphrase entry):
     a. Frontend shows "Enter Encryption Passphrase" dialog
     b. User enters passphrase
     c. Frontend: GET /api/auth/encryption-salt → { passphraseSalt: "<hex>" }
     d. Frontend: sessionSecret = PBKDF2(passphrase, passphraseSalt, 600000, SHA-256)
     e. Frontend: POST /api/auth/unlock-encryption { sessionSecret: "<hex>" }
     f. Server:
        - KEK = HKDF(ENCRYPTION_MASTER_KEY, userId + sessionSecret, "librechat-kek")
        - Fetch encryptedUEK from User document
        - UEK = unwrapUEK(encryptedUEK, KEK)
        - If unwrap fails (GCM auth tag mismatch) → return 401 { error: "invalid_passphrase" }
        - Cache UEK in keyCache with TTL
        - Return { status: "encryption_active" }
     g. Discard sessionSecret from server memory

  8. User is now authenticated AND encryption is unlocked
     - All subsequent API requests have UEK available via keyCache
     - Mongoose middleware can encrypt/decrypt transparently
```

### 8.2 Session Refresh

When a JWT is refreshed:
1. Validate refresh token.
2. Check if UEK is still in keyCache.
3. If UEK is still cached: issue new JWT. No passphrase needed.
4. If UEK was evicted (TTL expired):
   - Frontend detects `403 { error: "encryption_locked" }` on next API call
   - Frontend shows passphrase re-entry prompt
   - User re-enters passphrase → unlock flow (Step 7 above)
5. Issue new JWT after re-unlock.

### 8.3 Logout

On logout:
1. Evict UEK from keyCache.
2. Invalidate refresh token (standard flow).
3. UEK is no longer accessible until next login + passphrase entry.

### 8.4 Multi-Instance / Horizontal Scaling

For deployments with multiple server instances behind a load balancer:

**Option A — Sticky Sessions**: Route all requests from a user to the same instance. The in-memory keyCache on that instance holds the UEK.

**Option B — Redis Key Cache (Recommended)**: Store encrypted UEKs in Redis.
```
Redis Key: uek:<userId>
Redis Value: AES-256-GCM(UEK, instanceEphemeralKey)
TTL: matches session TTL
```
Each instance generates an `instanceEphemeralKey` on startup (in-memory only). On cache miss, the instance re-derives KEK and unwraps UEK from the user document — but this requires the user's `sessionSecret`, which is not cached. In practice, this means the user will be prompted for their passphrase if their request lands on a new instance that has not unlocked their encryption.

**Mitigation for Option B**: Use a shared Redis key cache where the UEK is encrypted with a deployment-wide ephemeral key. The ephemeral key is generated by the first instance at startup and distributed to other instances via an authenticated channel (e.g., HashiCorp Vault transit encryption, mutual TLS between instances, or a shared secrets manager). This avoids re-prompting on instance failover. The ephemeral key must NOT be stored in environment variables or configuration files — it exists only in instance memory and the secure distribution channel.

---

## 9. Configuration & Environment Variables

### New Environment Variables

```env
# ─── Encryption at Rest (Passphrase-Protected) ────────────────────

# Enable/disable user data encryption at rest.
# When true, users will be prompted to set an encryption passphrase.
# All user data is encrypted with passphrase-protected per-user keys.
# Existing data remains readable and is encrypted when the user sets their passphrase.
# Type: boolean | Default: false
ENCRYPT_USER_DATA=true

# Master key for deriving per-user Key Encryption Keys (KEKs).
# Combined with the user's passphrase-derived secret to create the KEK.
# MUST be a 64-character hex string (256-bit key).
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# CRITICAL: Back up this key securely. Loss = inability to derive KEKs = data loss.
# NOTE: Unlike server-only encryption, this key alone is NOT sufficient to decrypt
#       user data. The user's passphrase is also required.
# Type: string | Required when ENCRYPT_USER_DATA=true
ENCRYPTION_MASTER_KEY=

# TTL for in-memory User Encryption Key cache (milliseconds).
# Lower values = more frequent passphrase re-entry; higher values = longer exposure window.
# Type: number | Default: 900000 (15 minutes)
ENCRYPTION_KEY_CACHE_TTL=900000

# ─── Passphrase Policy ────────────────────────────────────────────

# Minimum passphrase length (characters).
# OWASP recommends 12+ characters for user-chosen secrets.
# Type: number | Default: 12
ENCRYPTION_PASSPHRASE_MIN_LENGTH=12

# Maximum passphrase length (characters).
# Prevents DoS via extremely long PBKDF2 inputs.
# Type: number | Default: 128
ENCRYPTION_PASSPHRASE_MAX_LENGTH=128

# PBKDF2 iteration count for client-side key derivation.
# Higher = more brute-force resistant but slower login.
# OWASP 2023 recommends 600,000 for SHA-256.
# Type: number | Default: 600000
ENCRYPTION_PBKDF2_ITERATIONS=600000

# Maximum failed passphrase attempts before cooldown.
# After this many failures, exponential backoff is enforced.
# Type: number | Default: 5
ENCRYPTION_MAX_PASSPHRASE_ATTEMPTS=5

# ─── Search ───────────────────────────────────────────────────────

# Search mode when encryption is enabled.
# "fallback" = server-side decrypt-and-filter (slower, full security)
# "blind_index" = HMAC-based word matching (faster, exact match only)
# "disabled" = search disabled when encryption is active
# Type: string | Default: fallback
ENCRYPTED_SEARCH_MODE=fallback

# Maximum documents to decrypt per search request.
# Limits server load during fallback search.
# Type: number | Default: 500
SEARCH_MAX_DECRYPT_BATCH=500

# ─── Multi-Instance ──────────────────────────────────────────────

# Enable Redis-based key cache for multi-instance deployments.
# Requires REDIS_URI to be configured.
# Type: boolean | Default: false
ENCRYPTION_USE_REDIS_CACHE=false
```

### Existing Variables (No Changes)

- `CREDS_KEY` / `CREDS_IV` — Continue to be used for API key encryption (separate concern).
- `OPENID_*` — Authentication configuration unchanged. The encryption passphrase is separate from OIDC credentials.
- `MEILI_*` — MeiliSearch configuration unchanged; behavior adapts based on `ENCRYPT_USER_DATA`.

---

## 10. Migration Strategy

### 10.1 Principles

1. **Zero downtime** — Migration runs in the background while the application serves requests.
2. **User-initiated** — Each user's data is encrypted when they first set up their passphrase. There is no bulk admin-triggered migration (admin does not have user passphrases).
3. **Incremental** — Data is encrypted document-by-document, not in a single bulk operation.
4. **Idempotent** — The migration can be restarted safely if interrupted.
5. **Mixed-state support** — The system handles a mix of encrypted and unencrypted documents gracefully.

### 10.2 Migration Phases

#### Phase 0: Pre-Migration (Admin)

```bash
# 1. Generate ENCRYPTION_MASTER_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. BACK UP the key to a secure vault (e.g., Azure Key Vault, HashiCorp Vault)

# 3. BACK UP MongoDB before enabling encryption
mongodump --uri="<MONGO_URI>" --out=/backup/pre-encryption

# 4. Set environment variables
ENCRYPT_USER_DATA=true
ENCRYPTION_MASTER_KEY=<generated_key>
# Configure passphrase policy as needed (see §9)

# 5. Deploy updated application
```

#### Phase 1: Enable Encryption — Users Set Passphrases On Login

1. Deploy with `ENCRYPT_USER_DATA=true`.
2. On next login, each user is prompted to **set up their encryption passphrase** (first-time setup flow described in §8.1).
3. After passphrase setup, the system migrates the user's **existing plaintext data** to encrypted form as a background job:

```typescript
// packages/api/src/crypto/migration.ts

export async function migrateUserDataOnSetup(
  userId: string,
  uek: Buffer,
  options?: {
    batchSize?: number;    // Default: 100
    dryRun?: boolean;      // Default: false
    collection?: string;   // Migrate specific collection; omit for all
  }
): Promise<MigrationReport>;
```

**Migration Flow per User** (triggered after passphrase setup):
```
1. UEK is already available in memory (user just completed passphrase setup)
2. For each collection (messages, conversations, files, memories, toolcalls):
   a. Query: { user: userId, encryptionVersion: { $ne: 1 } }
   b. For each batch of documents:
      i.   Read document
      ii.  Encrypt sensitive fields with UEK
      iii. Set encryptionVersion = 1
      iv.  Update document with $set
   c. Log progress: "Migrated <count> <collection> for user <userId>"
3. Update user.encryptionVersion = 1
```

4. Users who have NOT yet logged in still have plaintext data — it is readable normally.
5. Mixed state: some users encrypted, some not. Some documents encrypted, some plaintext. This is handled by the `isEncrypted()` check in post-find hooks.

#### Phase 2: Ongoing — New Users

- New users who register after encryption is enabled are prompted to set their passphrase during first login.
- All their data is encrypted from the start.

#### Phase 3: Verification (Admin)

```bash
# Verify migration completeness
npm run migrate:verify

# Output:
# Users: 150 total, 142 with passphrase set, 8 pending (not yet logged in)
# Messages: 45,230 total, 44,100 encrypted, 1,130 plaintext (belonging to 8 pending users)
# Conversations: 1,200 total, 1,150 encrypted, 50 plaintext
# ...
```

Admins can see which users have not yet set up encryption. They can notify these users to log in and complete setup, but they cannot force migration (they do not have the users' passphrases).

### 10.3 Rollback Procedure

Rollback is more complex with passphrase-protected keys because the admin does not have user passphrases:

**Option A — User-Initiated Rollback**: Each user logs in, enters passphrase, and their data is decrypted by a rollback background job. This requires every user to participate.

**Option B — Restore from Backup**: Restore the pre-encryption MongoDB backup from Phase 0. This loses all data created after migration but is guaranteed to work.

```bash
# Option B: Restore backup
# 1. Stop the application
# 2. Restore backup
mongorestore --uri="<MONGO_URI>" --drop /backup/pre-encryption

# 3. Disable encryption
ENCRYPT_USER_DATA=false

# 4. Redeploy
```

**Important**: Unlike server-only encryption (where admin can decrypt everything with the master key), passphrase-protected encryption means admin **cannot** decrypt user data for rollback without each user's passphrase. This is by design. The pre-migration backup is the safety net.

---

## 11. Performance Considerations

### 11.1 Benchmarks (Estimated)

| Operation | Without Encryption | With Encryption | Overhead |
|---|---|---|---|
| Save message (single) | ~2ms | ~2.5ms | +25% |
| Fetch 50 messages | ~8ms | ~12ms | +50% |
| Search (MeiliSearch) | ~15ms | N/A (disabled) | — |
| Search (fallback, 500 docs) | N/A | ~200ms | New cost |
| Save conversation | ~3ms | ~3.5ms | +17% |
| List 30 conversations | ~5ms | ~8ms | +60% |
| PBKDF2 derivation (client, 600K iter) | — | ~300ms | One-time per login (client-side) |
| HKDF key derivation (server) | — | ~0.1ms | One-time per session |
| UEK unwrap (server) | — | ~0.05ms | One-time per session |

### 11.2 Optimization Strategies

1. **UEK Caching**: The most expensive operation (PBKDF2 + HKDF + unwrap) happens once per session, not per request. PBKDF2 runs client-side and does not impact server load.
2. **Batch Decryption**: When fetching multiple documents, decrypt in a single `Promise.all` or synchronous loop rather than individual awaits.
3. **Lazy Decryption**: For list views that show only titles (conversation list), decrypt only the `title` field, not all encrypted fields.
4. **Streaming Unaffected**: Encryption only applies at the storage layer. SSE streaming performance is unchanged.
5. **Connection Pooling**: MongoDB connection overhead dominates latency; encryption adds negligible CPU time.
6. **Hardware Acceleration**: AES-NI instructions on modern CPUs make AES-256-GCM effectively free for small payloads.
7. **Client-side PBKDF2**: Running PBKDF2 in the browser (via WebCrypto) offloads the most CPU-intensive operation from the server.

### 11.3 Memory Overhead

- **Key Cache**: ~64 bytes per active user (32-byte key + metadata). 10,000 concurrent users ≈ 640 KB.
- **Decryption Buffers**: Temporary; garbage-collected per request. No persistent memory overhead.
- **No sessionSecret storage**: The passphrase-derived secret is discarded from server memory immediately after KEK derivation.

---

## 12. Compliance & Regulatory Mapping

| Regulation | Requirement | How This Design Addresses It |
|---|---|---|
| **GDPR Art. 32** | Implement appropriate technical measures including encryption | AES-256-GCM encryption at rest with passphrase-protected per-user keys; admin cannot decrypt without user cooperation |
| **GDPR Art. 34** | Notification exemption if data is encrypted | Encrypted data breach may not require individual notification; passphrase-protected keys strengthen this argument |
| **BDSG §64** | Technical measures for data protection | Per-user encryption keys with user-held secret; separation of duties enforced cryptographically |
| **HIPAA §164.312(a)(2)(iv)** | Encryption of ePHI at rest | All user-generated content encrypted; keys require user passphrase — exceeds basic encryption-at-rest requirements |
| **SOC 2 CC6.1** | Logical access controls over information assets | Per-user key isolation; admin-proof at-rest encryption; session-scoped key access |
| **SOC 2 CC6.7** | Restrict transmission of data | TLS in transit + AES-256 at rest with passphrase protection |
| **ISO 27001 A.10.1** | Cryptographic controls policy | Documented algorithm selection; key management lifecycle; user-held secret in derivation chain |
| **CCPA/CPRA** | Reasonable security measures | Industry-standard encryption with passphrase protection exceeds "reasonable" standard |
| **NIS2 (EU)** | Risk management measures | Encryption as defense-in-depth; admin-proof at-rest protection |

---

## 13. API Changes

### 13.1 No Breaking Changes to Existing APIs

The encryption layer is transparent to existing API consumers. All existing request/response contracts remain identical. Encryption and decryption occur within the server between the API layer and the database layer.

### 13.2 New Encryption API Endpoints

#### GET /api/auth/encryption-salt

Returns the user's PBKDF2 salt for client-side key derivation. Requires authenticated session.

```json
// Response (200 OK)
{ "passphraseSalt": "<64-char-hex>" }

// Response (404 Not Found — user has not set up encryption)
{ "error": "encryption_not_configured" }
```

#### POST /api/auth/setup-encryption

Initializes encryption for a user (first-time passphrase setup). Requires authenticated session.

```json
// Request — no body needed; server generates salt

// Response (200 OK)
{ "passphraseSalt": "<64-char-hex>" }
```

#### POST /api/auth/unlock-encryption

Unlocks encryption for the current session by providing the passphrase-derived secret. Requires authenticated session.

```json
// Request
{ "sessionSecret": "<64-char-hex>" }

// Response (200 OK)
{ "status": "encryption_active" }

// Response (401 Unauthorized — wrong passphrase)
{ "error": "invalid_passphrase" }

// Response (429 Too Many Requests — too many failed attempts)
{ "error": "passphrase_rate_limited", "retryAfter": 30 }
```

#### POST /api/auth/change-passphrase

Changes the user's encryption passphrase. Requires authenticated session with encryption unlocked.

```json
// Request
{
  "oldSessionSecret": "<64-char-hex>",
  "newSessionSecret": "<64-char-hex>"
}

// Response (200 OK)
{ "status": "passphrase_changed", "newPassphraseSalt": "<64-char-hex>" }

// Response (401 Unauthorized — wrong current passphrase)
{ "error": "invalid_passphrase" }
```

#### POST /api/auth/reset-encryption

Resets encryption by deleting all encrypted data and removing encryption setup. Requires authenticated session. Requires double confirmation.

```json
// Request
{ "confirm": true }

// Response (200 OK)
{ "status": "encryption_reset", "deletedData": { "messages": 1234, "conversations": 56, "memories": 78, "files": 12, "toolcalls": 90 } }
```

#### GET /api/admin/encryption/status

Returns encryption system status. Requires admin role.

```json
{
  "enabled": true,
  "algorithm": "AES-256-GCM",
  "keyDerivation": "HKDF-SHA-256 + PBKDF2-SHA-256",
  "version": 1,
  "keyCacheProvider": "memory",
  "pbkdf2Iterations": 600000,
  "users": {
    "total": 150,
    "encryptionSetUp": 142,
    "pending": 8
  },
  "collections": {
    "messages": { "total": 45230, "encrypted": 44100, "plaintext": 1130 },
    "conversations": { "total": 1200, "encrypted": 1200, "plaintext": 0 },
    "files": { "total": 380, "encrypted": 380, "plaintext": 0 },
    "memories": { "total": 500, "encrypted": 480, "plaintext": 20 },
    "toolcalls": { "total": 2100, "encrypted": 2100, "plaintext": 0 }
  }
}
```

---

## 14. Frontend Changes

### 14.1 User-Facing Changes

The encryption system requires frontend changes to support the passphrase flow.

#### Passphrase Setup Dialog (First Login After Encryption Enabled)

Shown when a user with `ENCRYPT_USER_DATA=true` has no passphrase set (`GET /api/auth/encryption-salt` returns 404).

**UI Elements:**
- Heading: "Set Up Encryption Passphrase"
- Explanatory text: "Your encryption passphrase protects your chat history. It is separate from your login password. If you lose this passphrase, your data cannot be recovered."
- Password input: "Encryption Passphrase" (with show/hide toggle)
- Password input: "Confirm Passphrase"
- Passphrase strength indicator (based on length)
- "Set Passphrase" button (disabled until criteria met)
- Localization keys: `com_ui_encryption_setup_title`, `com_ui_encryption_setup_description`, `com_ui_encryption_passphrase_label`, `com_ui_encryption_confirm_label`, `com_ui_encryption_setup_button`

#### Passphrase Prompt Dialog (Every Login)

Shown after authentication when the user has encryption set up but the session is not yet unlocked.

**UI Elements:**
- Heading: "Enter Encryption Passphrase"
- Explanatory text: "Enter your encryption passphrase to access your chat history."
- Password input: "Encryption Passphrase" (with show/hide toggle)
- "Unlock" button
- "Forgot passphrase?" link (leads to reset flow with data loss warning)
- Error state: "Incorrect passphrase. Please try again." (with attempt counter)
- Localization keys: `com_ui_encryption_unlock_title`, `com_ui_encryption_unlock_description`, `com_ui_encryption_passphrase_label`, `com_ui_encryption_unlock_button`, `com_ui_encryption_forgot_link`, `com_ui_encryption_wrong_passphrase`

#### Passphrase Re-Entry Prompt (Session Expired)

Shown when a request returns `403 { error: "encryption_locked" }` because the UEK was evicted from the cache.

**UI Elements:**
- Same as Passphrase Prompt, with additional text: "Your encryption session has expired. Please re-enter your passphrase."
- Localization key: `com_ui_encryption_session_expired`

#### Change Passphrase (Settings)

Available in user settings when encryption is active.

**UI Elements:**
- Password input: "Current Passphrase"
- Password input: "New Passphrase"
- Password input: "Confirm New Passphrase"
- "Change Passphrase" button
- Localization keys: `com_ui_encryption_change_title`, `com_ui_encryption_current_label`, `com_ui_encryption_new_label`, `com_ui_encryption_change_button`

#### Reset Encryption (Settings)

Available in user settings as a destructive action.

**UI Elements:**
- Warning: "⚠️ This will permanently delete all your encrypted chat history, memories, and files. This action cannot be undone."
- Confirmation checkbox: "I understand that all my encrypted data will be permanently deleted."
- "Reset Encryption" button (destructive styling, disabled until checkbox checked)
- Second confirmation dialog: "Are you absolutely sure? Type DELETE to confirm."
- Localization keys: `com_ui_encryption_reset_title`, `com_ui_encryption_reset_warning`, `com_ui_encryption_reset_confirm`, `com_ui_encryption_reset_button`

#### Encryption Locked State

When a user is authenticated but encryption is not unlocked (UEK not in cache), the frontend shows:
- Conversation list with encrypted titles replaced by placeholder text: "[Encrypted — enter passphrase to view]"
- Message view shows encrypted content placeholder
- A prominent banner: "Your encryption is locked. Enter your passphrase to access your chats."
- Localization keys: `com_ui_encryption_locked_banner`, `com_ui_encryption_locked_placeholder`

### 14.2 Client-Side PBKDF2 Implementation

```typescript
// client/src/utils/encryption.ts

/**
 * Derives a sessionSecret from the user's passphrase using PBKDF2 via WebCrypto.
 * This runs entirely in the browser — the raw passphrase never leaves the client.
 */
export async function deriveSessionSecret(
  passphrase: string,
  saltHex: string,
  iterations: number = 600_000,
): Promise<string> {
  const encoder = new TextEncoder();
  const salt = hexToBuffer(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return bufferToHex(new Uint8Array(bits)); // bufferToHex: standard hex encoding utility
}
```

### 14.3 Admin Dashboard (Optional Enhancement)

If an admin dashboard exists or is planned, add an "Encryption Status" panel showing:

- Encryption enabled/disabled status
- Number of users with encryption set up vs. pending
- Key cache statistics (active keys, hit rate)
- Passphrase policy configuration

---

## 15. Testing Strategy

### 15.1 Unit Tests

| Test Suite | Scope | Location |
|---|---|---|
| Crypto primitives | `encryptUserData`, `decryptUserData`, `deriveKEK`, `wrapUEK`, `unwrapUEK`, `generatePassphraseSalt` | `packages/data-schemas/src/crypto/__tests__/` |
| PBKDF2 compatibility | Verify that Node.js PBKDF2 output matches WebCrypto PBKDF2 output for the same inputs | `packages/data-schemas/src/crypto/__tests__/` |
| Key cache | `UserKeyCache` set/get/evict/TTL behavior | `packages/api/src/crypto/__tests__/` |
| Mongoose middleware | Encryption on save, decryption on find, mixed-state handling, locked-state handling | `packages/data-schemas/src/__tests__/` |
| Field detection | `isEncrypted()` correctly identifies ciphertext vs plaintext | `packages/data-schemas/src/crypto/__tests__/` |
| Migration | Batch processing, idempotency, error handling | `packages/api/src/crypto/__tests__/` |
| Passphrase validation | Min/max length, policy enforcement | `packages/api/src/crypto/__tests__/` |
| Wrong passphrase detection | GCM auth tag failure on wrong sessionSecret | `packages/data-schemas/src/crypto/__tests__/` |

### 15.2 Integration Tests

| Test | Description |
|---|---|
| Passphrase setup flow | First login → set passphrase → data encrypted |
| Passphrase entry flow | Login → enter passphrase → data decrypted |
| Wrong passphrase handling | Enter wrong passphrase → 401 → retry → success |
| Passphrase change | Change passphrase → verify data still accessible with new passphrase |
| Passphrase reset | Reset encryption → verify data deleted → set new passphrase |
| Message CRUD with encryption | Create, read, update, delete messages with `ENCRYPT_USER_DATA=true` |
| Conversation CRUD with encryption | Full conversation lifecycle with encrypted titles |
| Mixed-state reads | Read a mix of encrypted and unencrypted documents |
| Multi-user isolation | Verify User A's passphrase cannot decrypt User B's data |
| Search fallback | Verify search returns correct results with fallback mode |
| Shared conversation | Create share, verify re-encryption, verify access by non-owner |
| Session lifecycle | Login → passphrase → encrypt → logout → login → passphrase → decrypt |
| Session expiry re-prompt | UEK evicted → API returns 403 → re-enter passphrase → continue |
| Rate limiting | 5 wrong passphrases → cooldown enforced |

### 15.3 Performance Tests

| Test | Metric | Target |
|---|---|---|
| Message save latency | p99 latency with encryption | < 5ms |
| Batch message fetch (50) | p99 latency | < 20ms |
| Fallback search (500 docs) | p99 latency | < 500ms |
| HKDF key derivation (server) | Time per derivation | < 1ms |
| PBKDF2 derivation (client, 600K iter) | Time per derivation | < 500ms |
| Migration throughput | Documents per second | > 1000/s |

### 15.4 Security Tests

| Test | Validation |
|---|---|
| DB dump analysis | Confirm no plaintext user content in a mongodump |
| Cross-user decryption | Verify decryption fails with wrong user's passphrase-derived key |
| Admin offline attack simulation | Verify admin with master key + DB cannot derive UEK without passphrase |
| Key cache eviction | Verify UEK is removed from memory after TTL/logout |
| sessionSecret not persisted | Verify sessionSecret is not in DB, Redis, logs, or any persistent store |
| Tamper detection | Modify ciphertext in DB; verify GCM auth tag failure |
| Brute-force resistance | Verify PBKDF2 cost makes brute-force infeasible for 12+ char passphrase |
| Passphrase not logged | Verify passphrase and sessionSecret are never logged or sent to monitoring |

### 15.5 Frontend Tests

| Test | Validation |
|---|---|
| Passphrase setup dialog | Renders correctly; validates passphrase length; calls setup API |
| Passphrase prompt dialog | Renders on login; calls unlock API; handles wrong passphrase |
| Passphrase re-entry prompt | Shown on 403 encryption_locked; re-derives sessionSecret |
| Change passphrase UI | Validates current passphrase; calls change API; handles errors |
| Reset encryption UI | Shows double confirmation; calls reset API |
| Encryption locked state | Shows placeholder text for encrypted fields when not unlocked |
| Client-side PBKDF2 | `deriveSessionSecret()` produces correct output for known test vectors |

---

## 16. Rollout Plan

### Phase 1: Core Crypto & Passphrase Backend (Weeks 1–4)

- [ ] Implement crypto primitives (`encryptUserData`, `decryptUserData`, `deriveKEK` with sessionSecret, `wrapUEK`, `unwrapUEK`, `generatePassphraseSalt`)
- [ ] Implement `UserKeyCache` with in-memory store
- [ ] Implement Mongoose middleware for encrypt-on-save / decrypt-on-find
- [ ] Implement `AsyncLocalStorage`-based encryption context
- [ ] Add `encryptedUEK`, `passphraseSalt`, and `encryptionVersion` fields to User schema
- [ ] Add `encryptionVersion` field to Message, Conversation, File, Memory, ToolCall schemas
- [ ] Implement encryption API endpoints (`/encryption-salt`, `/setup-encryption`, `/unlock-encryption`, `/change-passphrase`, `/reset-encryption`)
- [ ] Implement passphrase rate limiting (wrong attempt tracking, exponential backoff)
- [ ] Unit tests for all crypto primitives, passphrase handling, and middleware

### Phase 2: Frontend Passphrase UI (Weeks 5–6)

- [ ] Implement passphrase setup dialog component
- [ ] Implement passphrase prompt dialog component (shown after login)
- [ ] Implement passphrase re-entry prompt (on session expiry / 403 encryption_locked)
- [ ] Implement change passphrase UI in settings
- [ ] Implement reset encryption UI in settings (with double confirmation)
- [ ] Implement encryption locked state (placeholder text for encrypted fields)
- [ ] Implement client-side `deriveSessionSecret()` using WebCrypto PBKDF2
- [ ] Add localization keys to `client/src/locales/en/translation.json`
- [ ] Frontend unit tests for all encryption UI components and `deriveSessionSecret()`

### Phase 3: Feature Integration (Weeks 7–9)

- [ ] Integrate encryption into message save/read paths
- [ ] Integrate encryption into conversation save/read paths
- [ ] Integrate encryption into file metadata save/read paths
- [ ] Integrate encryption into memory save/read paths
- [ ] Integrate encryption into tool call save/read paths
- [ ] Implement shared conversation re-encryption
- [ ] Implement search fallback mode
- [ ] Implement per-user background migration on passphrase setup
- [ ] Integration tests for all CRUD operations with encryption

### Phase 4: Hardening & Admin Tooling (Weeks 10–11)

- [ ] Redis-based key cache for multi-instance deployments
- [ ] Admin status API endpoint (`/admin/encryption/status`)
- [ ] Migration verification command
- [ ] Performance benchmarking and optimization
- [ ] Security test suite (admin offline attack simulation, brute-force resistance, sessionSecret not persisted)
- [ ] File binary encryption (local storage + S3)
- [ ] Documentation: deployment guide, configuration reference, security whitepaper

### Phase 5: Release (Week 12)

- [ ] Code review and security audit
- [ ] Update `.env.example` with new variables
- [ ] Update `librechat.example.yaml` if applicable
- [ ] Release notes and changelog
- [ ] Beta deployment with partner organization

---

## 17. Risks & Mitigations

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| **Lost passphrase = permanent data loss** | Critical | Medium | Clear UX warnings during setup; passphrase strength indicator; "forgot passphrase" flow explains consequences before reset; encourage users to store passphrase in a personal password manager. Organizations can enforce passphrase backup policy. |
| **User friction (passphrase prompt on every login)** | Medium | High | Clear explanatory text about why the passphrase is needed; browser password managers can remember the passphrase; session TTL keeps the session alive for the configured duration (default 15 min); re-prompt only when UEK is evicted. |
| **Weak passphrases vulnerable to brute-force** | High | Medium | Minimum 12-character policy; 600K PBKDF2 iterations make brute-force expensive; passphrase strength indicator; rate limiting on failed attempts. An attacker with master key + DB + passphraseSalt still needs to brute-force the passphrase through 600K iterations per guess. |
| **Active code modification attack** | High | Low–Medium (varies by deployment) | This is the remaining admin attack vector. Likelihood is **Low** for cloud-hosted deployments with separation of duties (separate teams for code, CI/CD, and infrastructure) and **Medium** for single-admin self-hosted deployments where one person controls codebase and deployment. Mitigated by: CI/CD pipeline integrity, code review requirements, deployment controls, audit logging of key access events, and binary signing (future enhancement). |
| **Master key loss** | Critical | Low | Document backup procedure; require key stored in external vault (Azure Key Vault, AWS KMS, HashiCorp Vault); startup check warns if key is not backed up. Note: master key loss is less catastrophic than in server-only encryption because the master key alone is insufficient to decrypt data. |
| **Performance degradation** | Medium | Medium | UEK caching, batch decryption, lazy decryption for list views; PBKDF2 runs client-side; benchmark before release |
| **Migration complexity (user-initiated)** | Medium | Medium | Each user's data migrates on passphrase setup; mixed-state is fully supported; admin dashboard shows migration progress; admins can notify pending users |
| **Search quality degradation** | Medium | High | Fallback search provides functional but slower search; blind index improves this; clear documentation of trade-offs |
| **Multi-device passphrase management** | Medium | Medium | Same passphrase works on all devices; browser password managers can store it; no device-specific key material |
| **Multi-instance key sync** | Medium | Medium | Redis cache option with shared ephemeral key; sticky sessions as alternative; documented in deployment guide |
| **Incompatibility with future features** | Medium | Medium | Version prefix (`enc1:`) allows algorithm migration; `encryptionVersion` field supports schema evolution; passphrase-based design is forward-compatible with future enhancements (HSM, TEE) |
| **Complexity increase** | Medium | High | Transparent middleware approach minimizes business logic changes; passphrase UI is self-contained; comprehensive test suite; clear documentation |

---

## 18. Open Questions

| # | Question | Status | Decision |
|---|---|---|---|
| 1 | Should conversation `tags` be encrypted? Tags are used for filtering and would require decryption for tag-based queries. | **Resolved** | **Yes — encrypt tags.** Tag filtering will use blind indexes (HMAC-SHA-256). See §18.1. |
| 2 | Should file `filename` be encrypted? Filenames may contain sensitive information but are used for serving files. | **Resolved** | **Not initially; encrypt in a future version.** Files are already served by `file_id`, not filename. See §18.2. |
| 3 | Should admin users have a recovery mechanism for user data if a user leaves the organization? | **Resolved** | **Future — optional key escrow.** Per-user passphrase isolation is the priority. See §18.3. |
| 4 | Should the encryption feature be available for non-OIDC authentication methods (local, LDAP)? | **Resolved** | **Yes — all authentication methods supported.** Passphrase is separate from auth credentials; key derivation uses `user._id`. See §18.4. |
| 5 | Should MongoDB Client-Side Field Level Encryption (CSFLE) be evaluated as an alternative? | **Resolved** | **Evaluated and rejected.** CSFLE requires MongoDB Atlas (not self-hosted). See §18.5. |
| 6 | What is the maximum supported message size for encryption? | **Resolved** | **16 MB limit (MongoDB BSON constraint).** See §18.6. |
| 7 | How should encrypted data be handled in MongoDB aggregation pipelines? | **Resolved** | **No immediate impact.** All current aggregations use metadata fields. See §18.7. |

### 18.1 Resolution: Conversation Tags Encryption

**Decision:** Encrypt tags with blind indexes for filtering.

**Implementation approach:**

1. **Blind indexes for tag filtering**: Compute a deterministic HMAC-SHA-256 blind index for each tag using the user's UEK. Store the blind index in a parallel `tagsIndex` array field. The `$in` query targets `tagsIndex` instead of `tags`.
2. **Tag display**: The actual tag names in the `tags` array are encrypted. On read, the Mongoose post-find hook decrypts them for display.
3. **MeiliSearch**: Exclude tags from MeiliSearch when encryption is enabled.
4. **ConversationTag model**: Tag names stored encrypted; looked up via blind index.

**Trade-off accepted:** Fuzzy/substring search on tags is not possible with blind indexes. Tags are typically short exact-match values, so this is acceptable.

### 18.2 Resolution: File Filename Encryption

**Decision:** Keep filenames unencrypted initially; encrypt in a future version.

File download routes serve files by `file_id`, not by filename. The filename is used only in `Content-Disposition` and `X-File-Metadata` headers. Low sensitivity relative to message content; file content itself IS encrypted.

### 18.3 Resolution: Admin Recovery / Key Escrow

**Decision:** Not in initial release. Implement optional key escrow in a future version.

Key escrow fundamentally weakens the "admin cannot decrypt" guarantee that is the core value of this design. Organizations that require admin recovery can evaluate it when available.

**Future design direction:**
1. **Admin KEK hierarchy**: A separate admin-level KEK that can wrap a copy of each user's UEK.
2. **Opt-in consent**: Users or organization policy explicitly enables key escrow.
3. **Audit trail**: Every escrow key access logged with timestamp, admin identity, and reason.

### 18.4 Resolution: Non-OIDC Authentication Support

**Decision:** Yes — all authentication methods supported. The passphrase is separate from the login credential.

All 9 auth strategies (local, OIDC, LDAP, SAML, Google, GitHub, Discord, Facebook, Apple) create a User document with a MongoDB `_id` that is stable and unique. Key derivation uses `user._id` + passphrase-derived `sessionSecret` — no auth-provider-specific code needed.

### 18.5 Resolution: MongoDB CSFLE Evaluation

**Decision:** CSFLE is not suitable for LibreChat.

CSFLE requires MongoDB Atlas M10+ (not self-hosted), does not support per-user keys or user-held secrets, and limits queries to equality only. Application-layer encryption with passphrase-protected keys is the correct approach.

### 18.6 Resolution: Message Size Limits

**Decision:** 16 MB limit, dictated by MongoDB BSON document size.

Encryption overhead per field: ~63 bytes fixed + 1× plaintext size (hex encoding doubles the size). Effective plaintext limit is ~7.5 MB per encrypted field. For typical chat messages (< 100 KB), this is a non-issue.

### 18.7 Resolution: Aggregation Pipeline Handling

**Decision:** No immediate action needed. All existing aggregation pipelines operate on metadata fields, not user-generated content. Zero breaking changes.

---

## 19. Appendix

### A. Glossary

| Term | Definition |
|---|---|
| **UEK** | User Encryption Key — A random 256-bit symmetric key unique to each user. Used to encrypt/decrypt all of that user's data. Stored wrapped (encrypted) in the User document. |
| **KEK** | Key Encryption Key — Derived from the master key, user ID, and passphrase-derived session secret via HKDF. Used only to wrap/unwrap the UEK. |
| **ENCRYPTION_MASTER_KEY** | A 256-bit secret stored as an environment variable. Used as input key material for HKDF. Alone, it is insufficient to derive any user's KEK. |
| **sessionSecret** | A 256-bit value derived client-side from the user's passphrase via PBKDF2. Sent to the server once per session over TLS. Never stored. |
| **passphraseSalt** | A 32-byte random value stored in the User document. Used as the salt for client-side PBKDF2 derivation of the sessionSecret. |
| **PBKDF2** | Password-Based Key Derivation Function 2 (RFC 8018). Derives a cryptographic key from a user-chosen passphrase. Intentionally slow (600,000 iterations) to resist brute-force attacks. |
| **HKDF** | HMAC-based Key Derivation Function (RFC 5869). Derives cryptographic keys from strong key material (master key + session secret) with salt and context info. |
| **AES-256-GCM** | Advanced Encryption Standard with 256-bit key in Galois/Counter Mode. Provides authenticated encryption (confidentiality + integrity). |
| **Authenticated Encryption** | Encryption that provides both confidentiality (data is unreadable) and integrity (data has not been tampered with). |
| **Key Wrapping** | Encrypting a cryptographic key with another key for safe storage. |
| **Blind Index** | A deterministic, one-way transformation of a value used for equality searches without exposing the plaintext. |
| **AsyncLocalStorage** | A Node.js API for maintaining context across asynchronous operations without explicit parameter passing. |

### B. Related Files in Codebase

| File | Relevance |
|---|---|
| `packages/data-schemas/src/crypto/index.ts` | Existing encryption primitives (V1/V2/V3); new user encryption functions will be added here |
| `packages/data-schemas/src/schema/message.ts` | Message schema; will add Mongoose encryption middleware |
| `packages/data-schemas/src/schema/convo.ts` | Conversation schema; will add encryption for `title`, `system`, `promptPrefix` |
| `packages/data-schemas/src/schema/file.ts` | File schema; will add encryption for `text` field |
| `packages/data-schemas/src/schema/memory.ts` | Memory schema; will add encryption for `key` and `value` |
| `packages/data-schemas/src/schema/toolCall.ts` | ToolCall schema; will add encryption for `result` |
| `packages/data-schemas/src/schema/share.ts` | SharedLink schema; will add `encryptedShareKey` and re-encryption logic |
| `packages/data-schemas/src/schema/user.ts` | User schema; will add `encryptedUEK`, `passphraseSalt`, and `encryptionVersion` fields |
| `api/server/middleware/requireJwtAuth.js` | Auth middleware; will add encryption-locked detection |
| `api/strategies/openidStrategy.js` | OIDC strategy; unchanged — passphrase flow is post-auth |
| `api/models/Message.js` | Message model operations; encryption middleware applies here |
| `api/models/Conversation.js` | Conversation model operations; encryption middleware applies here |
| `api/server/routes/messages.js` | Message routes; search behavior changes when encryption enabled |
| `api/server/routes/share.js` | Share routes; re-encryption logic on share creation |
| `packages/api/src/auth/openid.ts` | OIDC user lookup; unchanged — passphrase flow is separate |
| `client/src/utils/encryption.ts` | **New** — Client-side PBKDF2 derivation |
| `client/src/components/Auth/EncryptionPassphrase.tsx` | **New** — Passphrase setup and prompt dialogs |

### C. External References

- [NIST SP 800-38D — GCM Mode](https://csrc.nist.gov/publications/detail/sp/800-38d/final)
- [RFC 5869 — HKDF](https://datatracker.ietf.org/doc/html/rfc5869)
- [RFC 8018 — PBKDF2](https://datatracker.ietf.org/doc/html/rfc8018)
- [RFC 3394 — AES Key Wrap](https://datatracker.ietf.org/doc/html/rfc3394)
- [NIST SP 800-63B — Digital Identity Guidelines (Memorized Secrets)](https://pages.nist.gov/800-63-3/sp800-63b.html)
- [OWASP Password Storage Cheat Sheet (PBKDF2 Iterations)](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [Node.js Crypto API](https://nodejs.org/api/crypto.html)
- [Web Crypto API — SubtleCrypto.deriveBits()](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveBits)
- [GDPR Article 32 — Security of Processing](https://gdpr-info.eu/art-32-gdpr/)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

### D. End-to-End Encryption Feasibility Context

> **Why passphrase-derived keys instead of full client-side E2E?**

LibreChat is a **server-side AI chat application**. The server must read user plaintext to send it to LLM APIs, inject memories, execute tools, extract file text, and count tokens. This creates an unavoidable requirement: the server must access plaintext during an active user session.

**Full client-side E2E** (where the server never sees plaintext) would require the client to call LLM APIs directly, which exposes API keys to the browser and breaks memories, agents, tools, file processing, and search.

**Passphrase-derived keys** represent the optimal balance:
- ✅ Admin cannot decrypt data offline (passphrase not available)
- ✅ All server-side features work (server decrypts during active sessions)
- ✅ Minimal architectural change from existing design
- ✅ Self-hosted compatible (no special hardware)
- ⚠️ Server sees plaintext during active sessions (inherent to the use case)
- ⚠️ Active code modification attack remains possible (mitigated by deployment controls)

For organizations requiring protection against active code modification, Trusted Execution Environments (Intel SGX, AWS Nitro Enclaves) can be evaluated as a future enhancement but require specific hardware and add significant complexity.

### E. Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-03-10 | **Passphrase-derived keys as primary design** (v2.0) | Closes the admin offline-decryption gap that was the most significant limitation of v1.x. User passphrase in HKDF input means admin with master key + DB cannot derive any user's KEK. Trade-off: requires passphrase prompt on every session start. |
| 2026-03-10 | Use AES-256-GCM over AES-256-CTR | GCM provides authenticated encryption (integrity + confidentiality); CTR provides only confidentiality |
| 2026-03-10 | Use HKDF for server-side key derivation | HKDF is designed for deriving keys from already-strong key material (master key + session secret) |
| 2026-03-10 | Use PBKDF2 for client-side passphrase derivation | Natively available in all browsers via WebCrypto API; 600K iterations per OWASP 2023 recommendation |
| 2026-03-10 | Passphrase separate from login credential | Enables passphrase-protected encryption with any auth method (OIDC, LDAP, local, social); no auth-provider integration needed |
| 2026-03-10 | Mongoose middleware over explicit encrypt/decrypt calls | Minimizes changes to existing business logic; transparent to developers |
| 2026-03-10 | Per-user UEK over per-conversation keys | Simpler key management; one key per user vs. potentially thousands per user |
| 2026-03-10 | Fallback search over disabling search entirely | Preserves functionality, albeit with performance trade-off |
| 2026-03-10 | User-initiated migration over admin-triggered bulk migration | Admin does not have user passphrases; each user's data is encrypted when they set their passphrase |
| 2026-03-10 | Lost passphrase = permanent data loss (no admin recovery) | This is the necessary cost of admin-proof key isolation; key escrow is a future opt-in enhancement |
| 2026-03-10 | Encrypt conversation tags with blind indexes (Q1) | Tags are user-generated content that may reveal topics; blind indexes enable exact-match `$in` queries |
| 2026-03-10 | Defer filename encryption (Q2) | Files served by `file_id`; filename only used in `Content-Disposition` header; low sensitivity |
| 2026-03-10 | Defer admin key escrow (Q3) | Key escrow weakens the core admin-proof guarantee; organizations can evaluate when available |
| 2026-03-10 | Support all authentication methods (Q4) | Key derivation uses `user._id` + passphrase; stable and unique across all 9 auth strategies |
| 2026-03-10 | Reject CSFLE in favor of application-layer encryption (Q5) | CSFLE requires MongoDB Atlas M10+; LibreChat supports self-hosted; CSFLE lacks per-user keys and passphrase support |
| 2026-03-10 | Set 16 MB message size limit (Q6) | MongoDB BSON limit is 16 MB; hex-encoded ciphertext doubles size |
| 2026-03-10 | No changes to aggregation pipelines (Q7) | All existing aggregations operate on metadata fields, not user-generated content |
