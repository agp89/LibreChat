# Product Requirements Document: User Chat Data Encryption at Rest

**Document Version:** 1.1
**Date:** 2026-03-10
**Status:** Draft — Open Questions Resolved
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
   - 7.3 [Data Scope — What Gets Encrypted](#73-data-scope--what-gets-encrypted)
   - 7.4 [Database Layer Changes](#74-database-layer-changes)
   - 7.5 [File Storage Encryption](#75-file-storage-encryption)
   - 7.6 [Search Integration](#76-search-integration)
   - 7.7 [Shared Conversations](#77-shared-conversations)
   - 7.8 [Memory / RAG System](#78-memory--rag-system)
   - 7.9 [Streaming & Real-Time Decryption](#79-streaming--real-time-decryption)
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

This PRD defines a **server-side encryption-at-rest** architecture where every piece of user-generated content is encrypted before it reaches the database. Encryption keys are derived per-user so that **only the owning user's authenticated session can decrypt their data**. The server never persists plaintext user content or long-lived decryption keys to disk.

The design integrates with the existing OpenID Connect / Azure AD authentication flow and builds on LibreChat's existing `encryptV3` (AES-256-CTR) cryptographic primitives in `packages/data-schemas/src/crypto/`.

---

## 2. Problem Statement

| Concern | Current State | Required State |
|---|---|---|
| Message content in MongoDB | Plaintext `text` and `content` fields | Encrypted at rest; decryptable only by the owning user |
| Conversation titles | Plaintext `title` field | Encrypted at rest |
| File metadata & extracted text | Plaintext `text` field in File documents | Encrypted at rest |
| User memories | Plaintext `value` field | Encrypted at rest |
| Tool call results | Plaintext `result` field | Encrypted at rest |
| Database compromise | Full exposure of all user data | Attacker obtains only ciphertext; no keys stored alongside data |
| Regulatory compliance | Does not meet GDPR Art. 32 / BDSG §64 encryption requirements | Meets encryption-at-rest requirements for regulated industries |
| Admin/DBA access | Full read access to all user content | No access to plaintext without user cooperation |

### Who is affected?

- **Enterprise IT / Compliance Officers** — cannot approve LibreChat deployment without encryption at rest.
- **End Users** — whose confidential prompts and AI responses are exposed in the database.
- **Database Administrators** — who currently have unrestricted access to sensitive user content.

---

## 3. Goals & Non-Goals

### Goals

1. **Encrypt all user-generated content at rest** in MongoDB so that a database dump or unauthorized DB access reveals no plaintext.
2. **Per-user key isolation** — User A's key cannot decrypt User B's data.
3. **Zero plaintext key persistence** — No long-lived decryption keys stored unencrypted on disk or in the database.
4. **Transparent to end users** — No changes to the user experience or workflow (no passphrase prompts, no key management UI).
5. **Compatible with OpenID Connect / Azure AD** — Key derivation integrates with existing OIDC authentication flow.
6. **Backward compatible** — Existing unencrypted deployments can opt in and migrate incrementally.
7. **Opt-in via configuration** — Encryption at rest is enabled by a deployment-level environment variable.
8. **Auditable** — Encryption status is logged; encrypted fields are clearly identifiable in the database.

### Non-Goals

1. **End-to-end encryption (client-side)** — This PRD covers server-side encryption at rest. True E2E encryption (where the server never sees plaintext) is a future consideration but out of scope because the server must process plaintext to call LLM APIs.
2. **Encrypting LLM API traffic** — Traffic to upstream providers (OpenAI, Azure OpenAI, Anthropic, etc.) is protected by TLS; this PRD does not add an additional encryption layer to those calls.
3. **Encrypting non-user data** — System configuration, model parameters, endpoint settings, and agent definitions that are not user-generated content are out of scope.
4. **Key escrow or admin recovery** — If a user's key material is lost (e.g., OIDC provider deletes the account), their encrypted data is unrecoverable by design. An optional admin-recovery mechanism is discussed as a future extension.
5. **Homomorphic encryption for search** — Full-text search over encrypted data is a known hard problem. This PRD defines a practical approach using encrypted search indexes rather than homomorphic encryption.
6. **Multi-party decryption** — Shared conversations are handled by re-encryption, not by multi-party key schemes.

---

## 4. User Stories

### US-1: Enterprise Compliance Officer
> As a compliance officer, I need assurance that all user chat data stored in our self-hosted LibreChat MongoDB instance is encrypted at rest with per-user keys, so that a database compromise does not expose regulated data and we can satisfy GDPR Art. 32 / BDSG §64 audit requirements.

### US-2: End User (Azure AD)
> As an employee logging in via Azure AD, I want my chat history to be automatically encrypted and decrypted without any additional steps, so that my experience remains seamless while my data is protected.

### US-3: Database Administrator
> As a DBA, when I query the MongoDB collections directly, I should see only ciphertext for user message content, conversation titles, and memory values, so that I cannot accidentally or intentionally read user data.

### US-4: IT Administrator (Deployment)
> As an IT admin deploying LibreChat, I want to enable encryption at rest with a single environment variable toggle and have the system handle key management automatically, so that setup remains simple.

### US-5: Existing Deployment Migration
> As an admin of an existing LibreChat deployment, I want to migrate my existing plaintext data to encrypted form without downtime, so that I can adopt encryption without disrupting active users.

### US-6: User Sharing a Conversation
> As a user, I want to continue sharing conversations via shared links even after encryption is enabled, so that collaboration workflows are not broken.

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
| User Encryption Key (UEK) | Critical — decrypts all user data | Derived in-memory only; never persisted |
| Key Encryption Key (KEK) | Critical — wraps UEK for storage | Derived from server secret + user identity |

### 5.2 Threat Actors

| Actor | Capability | Mitigated By |
|---|---|---|
| **External attacker with DB access** | Reads/dumps MongoDB collections | All user content is ciphertext; keys not stored in DB |
| **Malicious DBA** | Queries collections, reads documents | Per-user encryption; DBA sees only ciphertext |
| **Compromised backup** | Reads MongoDB backup files | Backup contains only ciphertext |
| **Rogue server admin with env access** | Reads environment variables, server memory | KEK alone cannot decrypt without per-user UEK salt; UEK is session-scoped |
| **Compromised application server** | Full memory access during runtime | Accepted risk — server must process plaintext for LLM calls; mitigated by short-lived key caching |
| **Other authenticated user** | Accesses API endpoints | Per-user key isolation; authorization checks unchanged |

### 5.3 Accepted Risks

- **Server-side plaintext processing**: The server must decrypt data to send it to LLM providers. A fully compromised running server can access plaintext during a user's active session. This is inherent to the architecture and mitigated by standard server hardening.
- **Memory-resident keys**: User encryption keys exist in server memory during active sessions. Mitigated by session-scoped key caching with TTL eviction.

---

## 6. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                             │
│  ┌───────────┐   ┌──────────────┐   ┌────────────────────────────┐ │
│  │  Azure AD  │──▶│ OIDC Login   │──▶│ JWT + Session Established  │ │
│  │  / IdP     │   │  Callback    │   │                            │ │
│  └───────────┘   └──────────────┘   └────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS + JWT
┌──────────────────────────────▼──────────────────────────────────────┐
│                     APPLICATION SERVER                               │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   AUTH MIDDLEWARE                              │   │
│  │  1. Validate JWT                                              │   │
│  │  2. If encryption enabled:                                    │   │
│  │     a. Derive KEK from (ENCRYPTION_MASTER_KEY + user.id)     │   │
│  │     b. Fetch wrapped UEK from user record                     │   │
│  │     c. Unwrap UEK using KEK                                   │   │
│  │     d. Cache UEK in memory (session-scoped, TTL)             │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                  ENCRYPTION SERVICE                            │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │   │
│  │  │ encryptField │  │ decryptField │  │ Key Derivation     │  │   │
│  │  │ (AES-256-   │  │ (AES-256-    │  │ (HKDF-SHA-256)     │  │   │
│  │  │  GCM)       │  │  GCM)        │  │                    │  │   │
│  │  └─────────────┘  └──────────────┘  └────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                DATA ACCESS LAYER                              │   │
│  │  Mongoose Middleware (pre-save / post-find hooks)             │   │
│  │  • Pre-save: encrypt sensitive fields                         │   │
│  │  • Post-find: decrypt sensitive fields                        │   │
│  │  • Transparent to business logic                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ Encrypted data
┌──────────────────────────────▼──────────────────────────────────────┐
│                         MONGODB                                      │
│  ┌──────────┐ ┌──────────────┐ ┌────────┐ ┌──────────┐ ┌────────┐ │
│  │ messages │ │conversations │ │ files  │ │ memories │ │toolcalls│ │
│  │(encrypted│ │(encrypted    │ │(encrypt│ │(encrypted│ │(encrypt │ │
│  │ text,    │ │ title)       │ │ text)  │ │ value)   │ │ result) │ │
│  │ content) │ │              │ │        │ │          │ │         │ │
│  └──────────┘ └──────────────┘ └────────┘ └──────────┘ └────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Hierarchy

```
ENCRYPTION_MASTER_KEY (env var, 256-bit, hex-encoded)
        │
        ▼
   ┌─────────┐
   │  HKDF   │◀── user.id (salt) + "librechat-kek" (info)
   └────┬────┘
        │
        ▼
 KEK (Key Encryption Key) — per-user, derived deterministically
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
| Key Derivation | **HKDF-SHA-256** | Standardized (RFC 5869); deterministic; used by WebCrypto and Node.js |
| Key Wrapping | **AES-256-KW** (RFC 3394) or AES-256-GCM envelope | Wrap UEK with KEK for storage |
| IV/Nonce | **96-bit random per encryption** | GCM standard nonce size; generated via `crypto.randomBytes(12)` |
| Auth Tag | **128-bit** | Full GCM authentication tag |

> **Why AES-256-GCM over AES-256-CTR (existing encryptV3)?**
> GCM provides authenticated encryption (integrity + confidentiality). CTR provides only confidentiality. For user data at rest, we need tamper detection to prevent silent data corruption.

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

export function deriveKEK(masterKey: Buffer, userId: string): Buffer;
export function generateUEK(): Buffer;
export function wrapUEK(uek: Buffer, kek: Buffer): string;
export function unwrapUEK(wrappedUEK: string, kek: Buffer): Buffer;
export function encryptUserData(plaintext: string, uek: Buffer): string;
export function decryptUserData(ciphertext: string, uek: Buffer): string;
export function isEncrypted(value: string): boolean;
```

### 7.2 Key Derivation & Management

#### Key Lifecycle

```
1. FIRST LOGIN (no encryptedUEK on User document)
   ├── Derive KEK = HKDF(ENCRYPTION_MASTER_KEY, salt=userId, info="librechat-kek")
   ├── Generate UEK = crypto.randomBytes(32)
   ├── Wrap: encryptedUEK = AES-256-GCM(UEK, KEK)
   ├── Store encryptedUEK on User document
   └── Cache UEK in memory (session-scoped)

2. SUBSEQUENT LOGIN
   ├── Derive KEK = HKDF(ENCRYPTION_MASTER_KEY, salt=userId, info="librechat-kek")
   ├── Fetch encryptedUEK from User document
   ├── Unwrap: UEK = decrypt(encryptedUEK, KEK)
   └── Cache UEK in memory (session-scoped)

3. ACTIVE SESSION
   ├── UEK cached in in-memory store (Map or Redis)
   ├── TTL: matches session/JWT expiry
   ├── Used for all encrypt/decrypt operations
   └── Evicted on logout or TTL expiry

4. KEY ROTATION (admin-triggered)
   ├── Derive old KEK and new KEK
   ├── Unwrap UEK with old KEK
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
  encryptionVersion: {
    type: Number,
    default: 0,  // 0 = unencrypted, 1 = enc1 scheme
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

### 7.3 Data Scope — What Gets Encrypted

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
| **sharedLinks** | *(none — see §7.7)* | — | Shared data is re-encrypted or stored separately |

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

### 7.4 Database Layer Changes

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
      ii.  If field is an array/object, JSON.stringify() first
      iii. Encrypt: ciphertext = encryptUserData(plaintext, uek)
      iv.  Set field to ciphertext
3. Mark document with encryptionVersion = 1
```

**Post-Find Hook** (decrypt after read):
```
1. Check if ENCRYPTION_ENABLED is true
2. For each document in result:
   a. If document.encryptionVersion > 0:
      i.   Get UEK from request context (AsyncLocalStorage)
      ii.  For each sensitive field:
           - If value starts with "enc1:":
             decrypt: plaintext = decryptUserData(ciphertext, uek)
           - If field was serialized, JSON.parse() after decrypt
      iii. Return decrypted document
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
    encryptionStore.run({ uek, userId: req.user.id }, next);
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
        update.$set[field] = encryptUserData(update.$set[field], ctx.uek);
      }
    }
  }
  next();
});
```

### 7.5 File Storage Encryption

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

### 7.6 Search Integration

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
- This can be implemented as a Phase 2 enhancement.

#### Configuration

```env
# When ENCRYPT_USER_DATA=true, controls search behavior
ENCRYPTED_SEARCH_MODE=fallback  # "fallback" | "blind_index" | "disabled"
SEARCH_MAX_DECRYPT_BATCH=500
```

### 7.7 Shared Conversations

#### Challenge

Shared conversations must be readable by users other than the owner. The owner's UEK cannot be shared.

#### Solution: Re-Encryption on Share Creation

When a user creates a shared link:

```
1. Server decrypts messages using owner's UEK
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
- **Con**: The server (via ENCRYPTION_MASTER_KEY) can decrypt shared conversations. This is acceptable because shared conversations are intentionally shared and the server must serve them.

### 7.8 Memory / RAG System

#### Memory Encryption

User memories (`key` and `value` fields) are encrypted using the same Mongoose middleware as messages. The `tokenCount` field remains unencrypted for quota enforcement.

#### Impact on Memory Injection

When memories are injected into agent system prompts:

```
1. Fetch user memories from MongoDB (encrypted)
2. Post-find hook decrypts values automatically
3. Format memories into prompt string
4. Send to LLM (plaintext, over TLS)
```

No changes to the memory injection logic are needed; the Mongoose middleware handles decryption transparently.

#### RAG / File Search

For agent file search (tool_resources.file_search):
- File content stored in vector databases or search indexes must use the same encryption approach as MeiliSearch (§7.6).
- When encryption is enabled, file embeddings are generated from decrypted content at query time rather than pre-computed.
- This has performance implications addressed in §11.

### 7.9 Streaming & Real-Time Decryption

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

---

## 8. Authentication & Key Lifecycle

### 8.1 OpenID Connect / Azure AD Flow

```
1. User initiates login → redirected to Azure AD
2. Azure AD authenticates → redirects back with auth code
3. LibreChat exchanges code for tokens (ID token + access token)
4. OpenID strategy extracts user identity (sub claim)
5. findOpenIDUser() locates or creates User document
6. ──── NEW STEPS ────
7. If ENCRYPT_USER_DATA=true:
   a. Derive KEK = HKDF-SHA-256(
        ikm = Buffer.from(ENCRYPTION_MASTER_KEY, 'hex'),
        salt = Buffer.from(user._id.toString()),
        info = Buffer.from('librechat-kek'),
        length = 32
      )
   b. If user.encryptedUEK exists:
      - Unwrap: UEK = unwrapUEK(user.encryptedUEK, KEK)
   c. Else (first login after encryption enabled):
      - Generate: UEK = crypto.randomBytes(32)
      - Wrap: encryptedUEK = wrapUEK(UEK, KEK)
      - Store encryptedUEK on user document
   d. Cache UEK in keyCache with TTL = JWT_REFRESH_EXPIRY
8. Issue JWT and refresh token (standard flow)
9. Subsequent requests: UEK resolved from cache by userId
```

### 8.2 Session Refresh

When a JWT is refreshed:
1. Validate refresh token.
2. Check if UEK is still in cache.
3. If evicted: re-derive KEK, unwrap UEK from user document, re-cache.
4. Issue new JWT.

### 8.3 Logout

On logout:
1. Evict UEK from keyCache.
2. Invalidate refresh token (standard flow).
3. UEK is no longer accessible until next login.

### 8.4 Multi-Instance / Horizontal Scaling

For deployments with multiple server instances behind a load balancer:

**Option A — Sticky Sessions**: Route all requests from a user to the same instance. The in-memory keyCache on that instance holds the UEK.

**Option B — Redis Key Cache (Recommended)**: Store encrypted UEKs in Redis.
```
Redis Key: uek:<userId>
Redis Value: AES-256-GCM(UEK, instanceEphemeralKey)
TTL: matches session TTL
```
Each instance generates an `instanceEphemeralKey` on startup (in-memory only). On cache miss, the instance re-derives KEK and unwraps UEK from the user document.

---

## 9. Configuration & Environment Variables

### New Environment Variables

```env
# ─── Encryption at Rest ───────────────────────────────────────────

# Enable/disable user data encryption at rest.
# When true, all new user data is encrypted before storage.
# Existing data remains readable and is encrypted on next write.
# Type: boolean | Default: false
ENCRYPT_USER_DATA=true

# Master key for deriving per-user Key Encryption Keys (KEKs).
# MUST be a 64-character hex string (256-bit key).
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# CRITICAL: Back up this key securely. Loss = inability to derive KEKs = data loss.
# Type: string | Required when ENCRYPT_USER_DATA=true
ENCRYPTION_MASTER_KEY=

# TTL for in-memory User Encryption Key cache (milliseconds).
# Lower values = more frequent key derivation; higher values = longer exposure window.
# Type: number | Default: 900000 (15 minutes)
ENCRYPTION_KEY_CACHE_TTL=900000

# Search mode when encryption is enabled.
# "fallback" = server-side decrypt-and-filter (slower, full security)
# "blind_index" = HMAC-based word matching (faster, exact match only) [Phase 2]
# "disabled" = search disabled when encryption is active
# Type: string | Default: fallback
ENCRYPTED_SEARCH_MODE=fallback

# Maximum documents to decrypt per search request.
# Limits server load during fallback search.
# Type: number | Default: 500
SEARCH_MAX_DECRYPT_BATCH=500

# Enable Redis-based key cache for multi-instance deployments.
# Requires REDIS_URI to be configured.
# Type: boolean | Default: false
ENCRYPTION_USE_REDIS_CACHE=false
```

### Existing Variables (No Changes)

- `CREDS_KEY` / `CREDS_IV` — Continue to be used for API key encryption (separate concern).
- `OPENID_*` — Authentication configuration unchanged.
- `MEILI_*` — MeiliSearch configuration unchanged; behavior adapts based on `ENCRYPT_USER_DATA`.

---

## 10. Migration Strategy

### 10.1 Principles

1. **Zero downtime** — Migration runs in the background while the application serves requests.
2. **Incremental** — Data is encrypted document-by-document, not in a single bulk operation.
3. **Idempotent** — The migration can be restarted safely if interrupted.
4. **Reversible** — A decrypt-migration tool is provided for rollback.

### 10.2 Migration Phases

#### Phase 0: Pre-Migration

```bash
# 1. Generate ENCRYPTION_MASTER_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. BACK UP the key to a secure vault (e.g., Azure Key Vault, HashiCorp Vault)

# 3. BACK UP MongoDB before migration
mongodump --uri="<MONGO_URI>" --out=/backup/pre-encryption

# 4. Set environment variables
ENCRYPT_USER_DATA=true
ENCRYPTION_MASTER_KEY=<generated_key>
```

#### Phase 1: Enable Encryption for New Data

1. Deploy with `ENCRYPT_USER_DATA=true`.
2. All **new** messages, conversations, memories, files, and tool calls are encrypted on write.
3. All **existing** data remains plaintext and is read normally (encryptionVersion=0 check).
4. Mixed state: some documents encrypted, some plaintext. This is handled by the `isEncrypted()` check in post-find hooks.

#### Phase 2: Background Migration of Existing Data

A migration script/command processes existing unencrypted documents:

```typescript
// packages/api/src/crypto/migration.ts

export async function migrateUserData(options: {
  batchSize?: number;    // Default: 100
  dryRun?: boolean;      // Default: false
  userId?: string;       // Migrate specific user; omit for all
  collection?: string;   // Migrate specific collection; omit for all
}): Promise<MigrationReport>;
```

**Migration Flow per User**:
```
1. Derive KEK for user
2. Generate or fetch UEK for user
3. For each collection (messages, conversations, files, memories, toolcalls):
   a. Query: { user: userId, encryptionVersion: { $ne: 1 } }
   b. For each batch of documents:
      i.   Read document
      ii.  Encrypt sensitive fields with UEK
      iii. Set encryptionVersion = 1
      iv.  Update document with $set
   c. Log progress: "Migrated <count> <collection> for user <userId>"
4. Update user.encryptionVersion = 1
```

**CLI Command**:
```bash
# Migrate all users
npm run migrate:encrypt

# Migrate specific user
npm run migrate:encrypt -- --user=<userId>

# Dry run (report only)
npm run migrate:encrypt -- --dry-run

# Rollback (decrypt all)
npm run migrate:decrypt
```

#### Phase 3: Verification

```bash
# Verify migration completeness
npm run migrate:verify

# Output:
# Users: 150 total, 150 migrated, 0 pending
# Messages: 45,230 total, 45,230 encrypted, 0 plaintext
# Conversations: 1,200 total, 1,200 encrypted, 0 plaintext
# ...
```

### 10.3 Rollback Procedure

If encryption must be disabled after migration:

```bash
# 1. Run decrypt migration
ENCRYPT_USER_DATA=true npm run migrate:decrypt

# 2. Verify all data is decrypted
npm run migrate:verify --expect-plaintext

# 3. Disable encryption
ENCRYPT_USER_DATA=false

# 4. Redeploy
```

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
| Key derivation (HKDF) | — | ~0.1ms | One-time per session |
| UEK unwrap | — | ~0.05ms | One-time per session |

### 11.2 Optimization Strategies

1. **UEK Caching**: The most expensive operation (key derivation + unwrap) happens once per session, not per request.
2. **Batch Decryption**: When fetching multiple documents, decrypt in a single `Promise.all` or synchronous loop rather than individual awaits.
3. **Lazy Decryption**: For list views that show only titles (conversation list), decrypt only the `title` field, not all encrypted fields.
4. **Streaming Unaffected**: Encryption only applies at the storage layer. SSE streaming performance is unchanged.
5. **Connection Pooling**: MongoDB connection overhead dominates latency; encryption adds negligible CPU time.
6. **Hardware Acceleration**: AES-NI instructions on modern CPUs make AES-256-GCM effectively free for small payloads.

### 11.3 Memory Overhead

- **Key Cache**: ~64 bytes per active user (32-byte key + metadata). 10,000 concurrent users ≈ 640 KB.
- **Decryption Buffers**: Temporary; garbage-collected per request. No persistent memory overhead.

---

## 12. Compliance & Regulatory Mapping

| Regulation | Requirement | How This Design Addresses It |
|---|---|---|
| **GDPR Art. 32** | Implement appropriate technical measures including encryption | AES-256-GCM encryption at rest for all user data |
| **GDPR Art. 34** | Notification exemption if data is encrypted | Encrypted data breach may not require individual notification |
| **BDSG §64** | Technical measures for data protection | Per-user encryption keys; key hierarchy with master key |
| **HIPAA §164.312(a)(2)(iv)** | Encryption of ePHI at rest | All user-generated content encrypted; keys access-controlled |
| **SOC 2 CC6.1** | Logical access controls over information assets | Per-user key isolation; session-scoped key access |
| **SOC 2 CC6.7** | Restrict transmission of data | TLS in transit + AES-256 at rest |
| **ISO 27001 A.10.1** | Cryptographic controls policy | Documented algorithm selection; key management lifecycle |
| **CCPA/CPRA** | Reasonable security measures | Industry-standard encryption for personal information |
| **NIS2 (EU)** | Risk management measures | Encryption as defense-in-depth for data at rest |

---

## 13. API Changes

### 13.1 No Breaking API Changes

The encryption layer is transparent to API consumers. All existing request/response contracts remain identical. Encryption and decryption occur within the server between the API layer and the database layer.

### 13.2 New Admin API Endpoints

#### GET /api/admin/encryption/status

Returns encryption system status. Requires admin role.

```json
{
  "enabled": true,
  "algorithm": "AES-256-GCM",
  "version": 1,
  "keyCacheProvider": "memory",
  "migration": {
    "totalUsers": 150,
    "migratedUsers": 142,
    "pendingUsers": 8,
    "collections": {
      "messages": { "total": 45230, "encrypted": 44100, "pending": 1130 },
      "conversations": { "total": 1200, "encrypted": 1200, "pending": 0 },
      "files": { "total": 380, "encrypted": 380, "pending": 0 },
      "memories": { "total": 500, "encrypted": 480, "pending": 20 },
      "toolcalls": { "total": 2100, "encrypted": 2100, "pending": 0 }
    }
  }
}
```

#### POST /api/admin/encryption/migrate

Triggers background migration for a specific user or all users. Requires admin role.

```json
// Request
{ "userId": "optional-specific-user-id" }

// Response
{ "status": "started", "jobId": "migration-job-uuid" }
```

#### POST /api/admin/encryption/rotate-master-key

Initiates master key rotation. Requires admin role and the new master key in the request.

```json
// Request
{ "newMasterKey": "<64-char-hex>" }

// Response
{ "status": "started", "jobId": "rotation-job-uuid" }
```

---

## 14. Frontend Changes

### 14.1 No User-Facing Changes

The encryption system is fully server-side. The frontend does not need to perform any encryption or decryption. All data arrives decrypted via the API.

### 14.2 Admin Dashboard (Optional Enhancement)

If an admin dashboard exists or is planned, add an "Encryption Status" panel showing:

- Encryption enabled/disabled status
- Migration progress (percentage complete per collection)
- Key cache statistics (active keys, hit rate)

This is a low-priority enhancement and not required for the initial release.

---

## 15. Testing Strategy

### 15.1 Unit Tests

| Test Suite | Scope | Location |
|---|---|---|
| Crypto primitives | `encryptUserData`, `decryptUserData`, `deriveKEK`, `wrapUEK`, `unwrapUEK` | `packages/data-schemas/src/crypto/__tests__/` |
| Key cache | `UserKeyCache` set/get/evict/TTL behavior | `packages/api/src/crypto/__tests__/` |
| Mongoose middleware | Encryption on save, decryption on find, mixed-state handling | `packages/data-schemas/src/__tests__/` |
| Field detection | `isEncrypted()` correctly identifies ciphertext vs plaintext | `packages/data-schemas/src/crypto/__tests__/` |
| Migration | Batch processing, idempotency, error handling | `packages/api/src/crypto/__tests__/` |

### 15.2 Integration Tests

| Test | Description |
|---|---|
| Message CRUD with encryption | Create, read, update, delete messages with `ENCRYPT_USER_DATA=true` |
| Conversation CRUD with encryption | Full conversation lifecycle with encrypted titles |
| Mixed-state reads | Read a mix of encrypted and unencrypted documents |
| Multi-user isolation | Verify User A's key cannot decrypt User B's data |
| Search fallback | Verify search returns correct results with fallback mode |
| Shared conversation | Create share, verify re-encryption, verify access |
| Session lifecycle | Login → encrypt → logout → login → decrypt |
| Key rotation | Rotate master key, verify data still accessible |

### 15.3 Performance Tests

| Test | Metric | Target |
|---|---|---|
| Message save latency | p99 latency with encryption | < 5ms |
| Batch message fetch (50) | p99 latency | < 20ms |
| Fallback search (500 docs) | p99 latency | < 500ms |
| Key derivation | Time per derivation | < 1ms |
| Migration throughput | Documents per second | > 1000/s |

### 15.4 Security Tests

| Test | Validation |
|---|---|
| DB dump analysis | Confirm no plaintext user content in a mongodump |
| Cross-user decryption | Verify decryption fails with wrong user's key |
| Key cache eviction | Verify UEK is removed from memory after TTL/logout |
| Tamper detection | Modify ciphertext in DB; verify GCM auth tag failure |
| Master key rotation | Verify old master key cannot unwrap UEKs after rotation |

---

## 16. Rollout Plan

### Phase 1: Core Implementation (Weeks 1–4)

- [ ] Implement crypto primitives (`encryptUserData`, `decryptUserData`, `deriveKEK`, `wrapUEK`, `unwrapUEK`)
- [ ] Implement `UserKeyCache` with in-memory store
- [ ] Implement Mongoose middleware for encrypt-on-save / decrypt-on-find
- [ ] Implement `AsyncLocalStorage`-based encryption context
- [ ] Add `encryptedUEK` and `encryptionVersion` fields to User schema
- [ ] Add `encryptionVersion` field to Message, Conversation, File, Memory, ToolCall schemas
- [ ] Integrate key derivation into authentication flow (OIDC and local)
- [ ] Unit tests for all crypto primitives and middleware

### Phase 2: Feature Integration (Weeks 5–7)

- [ ] Integrate encryption into message save/read paths
- [ ] Integrate encryption into conversation save/read paths
- [ ] Integrate encryption into file metadata save/read paths
- [ ] Integrate encryption into memory save/read paths
- [ ] Integrate encryption into tool call save/read paths
- [ ] Implement shared conversation re-encryption
- [ ] Implement search fallback mode
- [ ] Integration tests for all CRUD operations with encryption

### Phase 3: Migration & Admin Tooling (Weeks 8–9)

- [ ] Implement background migration script (encrypt existing data)
- [ ] Implement rollback migration script (decrypt all data)
- [ ] Implement migration verification command
- [ ] Implement admin API endpoints (`/encryption/status`, `/encryption/migrate`)
- [ ] Implement master key rotation command
- [ ] Migration integration tests

### Phase 4: Hardening & Performance (Weeks 10–11)

- [ ] Redis-based key cache for multi-instance deployments
- [ ] Performance benchmarking and optimization
- [ ] Security test suite (tamper detection, cross-user isolation, key eviction)
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
| **Master key loss** | Critical | Low | Document backup procedure; require key stored in external vault (Azure Key Vault, AWS KMS, HashiCorp Vault); startup check warns if key is not backed up |
| **Performance degradation** | Medium | Medium | UEK caching, batch decryption, lazy decryption for list views; benchmark before release |
| **Migration data corruption** | High | Low | Idempotent migration; pre-migration backup mandatory; verification step; dry-run mode |
| **Search quality degradation** | Medium | High | Fallback search provides functional but slower search; blind index (Phase 2) improves this; clear documentation of trade-offs |
| **Memory pressure from key cache** | Low | Low | 64 bytes per user; 10K users = 640 KB; negligible; TTL eviction prevents unbounded growth |
| **Complexity increase** | Medium | High | Transparent middleware approach minimizes business logic changes; comprehensive test suite; clear documentation |
| **Multi-instance key sync** | Medium | Medium | Redis cache option; sticky sessions as alternative; documented in deployment guide |
| **Incompatibility with future features** | Medium | Medium | Version prefix (`enc1:`) allows algorithm migration; `encryptionVersion` field supports schema evolution |

---

## 18. Open Questions

| # | Question | Status | Decision |
|---|---|---|---|
| 1 | Should conversation `tags` be encrypted? Tags are used for filtering and would require decryption for tag-based queries. | **Resolved** | **Yes — encrypt tags in Phase 1.** Tag filtering will use server-side decryption. See §18.1 for full rationale. |
| 2 | Should file `filename` be encrypted? Filenames may contain sensitive information but are used for serving files. | **Resolved** | **No for Phase 1; yes for Phase 2.** Files are already served by `file_id`, not filename. Filename is only used in `Content-Disposition` headers. See §18.2. |
| 3 | Should admin users have a recovery mechanism for user data if a user leaves the organization? | **Resolved** | **Phase 2 — optional key escrow.** No admin data-recovery features exist today. Initial release prioritizes per-user isolation; key escrow adds complexity without blocking adoption. See §18.3. |
| 4 | Should the encryption feature be available for non-OIDC authentication methods (local, LDAP)? | **Resolved** | **Yes — all authentication methods supported.** Key derivation uses `user._id` (MongoDB ObjectId), which is stable and unique across every auth provider. See §18.4. |
| 5 | Should MongoDB Client-Side Field Level Encryption (CSFLE) be evaluated as an alternative to application-layer encryption? | **Resolved** | **Evaluated and rejected.** CSFLE requires MongoDB Atlas (not self-hosted), does not support per-user keys, and limits queries to equality only. Application-layer encryption is the correct approach for LibreChat. See §18.5. |
| 6 | What is the maximum supported message size for encryption? AES-GCM has a theoretical limit of ~64 GB per nonce, but practical limits may be lower. | **Resolved** | **16 MB limit (MongoDB BSON constraint).** AES-256-GCM overhead is negligible (~28 bytes per field). No application-level message size validation exists today; add validation during implementation. See §18.6. |
| 7 | How should encrypted data be handled in MongoDB aggregation pipelines? Some analytics may operate on encrypted fields. | **Resolved** | **No immediate impact — defer to Phase 2.** All current aggregation pipelines operate on metadata fields (categories, authors, counts), not user-generated content. Provide application-layer decryption utilities for future analytics needs. See §18.7. |

### 18.1 Resolution: Conversation Tags Encryption

**Decision:** Encrypt tags in Phase 1.

**Investigation findings:**

Tags are defined in the conversation schema (`packages/data-schemas/src/schema/convo.ts`) as `[String]` with `meiliIndex: true`. They are managed through dedicated routes (`api/server/routes/tags.js`) and a separate model (`api/models/ConversationTag.js`) that maintains per-tag usage counts.

Tag filtering happens via a direct MongoDB `$in` query in `api/models/Conversation.js`:

```javascript
if (Array.isArray(tags) && tags.length > 0) {
  filters.push({ tags: { $in: tags } });
}
```

**Impact of encryption:**

- The `$in` query on encrypted tag values will not work because the ciphertext for the same tag differs each time (random IV in AES-256-GCM).
- MeiliSearch indexing of tags will index ciphertext, breaking search.

**Implementation approach:**

1. **Blind indexes for tag filtering**: Since tags are short, low-cardinality values, compute a deterministic HMAC-SHA-256 blind index for each tag using the user's UEK. Store the blind index in a parallel `tagsIndex` array field. The `$in` query targets `tagsIndex` instead of `tags`.
2. **Tag display**: The actual tag names in the `tags` array are encrypted. On read, the Mongoose post-find hook decrypts them for display.
3. **MeiliSearch**: Index blind-index values (not useful for full-text, but enables exact-match filtering). Alternatively, exclude tags from MeiliSearch when encryption is enabled.
4. **ConversationTag model**: Tag names stored encrypted; looked up via blind index.

**Trade-off accepted:** Fuzzy/substring search on tags is not possible with blind indexes. Tags are typically short exact-match values (e.g., "work", "personal"), so this is acceptable.

### 18.2 Resolution: File Filename Encryption

**Decision:** Keep filenames unencrypted in Phase 1; encrypt in Phase 2.

**Investigation findings:**

File download routes (`api/server/routes/files/files.js`) serve files by `file_id`, not by filename:

```
GET /api/files/download/:userId/:file_id
```

The filename is used only in two places:
1. `Content-Disposition` header: `attachment; filename="${cleanedFilename}"` — controls the download dialog filename shown to the user.
2. `X-File-Metadata` header: JSON metadata sent alongside the file.

No file access patterns use the filename for routing or lookup. All queries use `file_id`.

**Why defer to Phase 2:**

- Encrypting filenames in Phase 1 adds complexity to the `Content-Disposition` header handling (would need to decrypt before setting the header).
- Filenames are low-sensitivity metadata compared to message content.
- The file content itself (both the extracted `text` field and the binary file in storage) IS encrypted in Phase 1.
- Phase 2 implementation is straightforward: encrypt filename on save, decrypt on download when building the `Content-Disposition` header.

### 18.3 Resolution: Admin Recovery / Key Escrow

**Decision:** Not in Phase 1. Implement optional key escrow in Phase 2.

**Investigation findings:**

LibreChat currently has no admin data-recovery or data-export features:
- The only admin data operation is the cascading user deletion script (`config/delete-user.js`) which irreversibly deletes all user data across all collections.
- Admin middleware (`api/server/middleware/roles/admin.js`) provides only RBAC checks.
- No "view as user" or "export user data" capabilities exist.

**Why defer:**

- Key escrow adds significant complexity: a separate admin KEK hierarchy, consent flows, and audit logging.
- The primary use case (enterprise compliance) values data isolation over admin recovery — GDPR's "right to be forgotten" actually benefits from unrecoverable encryption.
- Organizations that require admin recovery can delay enabling encryption until Phase 2.

**Phase 2 design direction:**

1. **Admin KEK hierarchy**: A separate admin-level KEK that can wrap a copy of each user's UEK, stored in a dedicated `keyEscrow` collection.
2. **Opt-in consent**: Users or organization policy explicitly enables key escrow.
3. **Audit trail**: Every escrow key access logged with timestamp, admin identity, and reason.
4. **Data export endpoint**: Admin-initiated export that uses escrowed UEK to decrypt, producing an encrypted archive (encrypted with the admin's key or a transport key).

### 18.4 Resolution: Non-OIDC Authentication Support

**Decision:** Yes — encryption is available for all authentication methods.

**Investigation findings:**

LibreChat supports 9 authentication strategies:

| Strategy | File | ID Field |
|---|---|---|
| Local (email/password) | `api/strategies/localStrategy.js` | `email` |
| OpenID Connect | `api/strategies/openidStrategy.js` | `openidId` |
| LDAP | `api/strategies/ldapStrategy.js` | `ldapId` |
| SAML | `api/strategies/samlStrategy.js` | `samlId` |
| Google | `api/strategies/googleStrategy.js` | `googleId` |
| GitHub | `api/strategies/githubStrategy.js` | `githubId` |
| Discord | `api/strategies/discordStrategy.js` | `discordId` |
| Facebook | `api/strategies/facebookStrategy.js` | `facebookId` |
| Apple | via passport-apple | `appleId` |

**Critical finding:** All strategies ultimately create a User document with a MongoDB `_id` (ObjectId) that is:
- Generated once on first user creation
- Immutable regardless of authentication method
- Used as the foreign key in all data collections (`messages.user`, `conversations.user`, `files.user`, etc.)

The key derivation formula `KEK = HKDF(ENCRYPTION_MASTER_KEY, salt=user._id, info="librechat-kek")` depends only on `user._id`, not on any provider-specific field. This means:

- A user logging in via Azure AD gets the same KEK as if they logged in via local auth (assuming same `_id`).
- Switching authentication providers for the same user account does not invalidate the encryption key.
- No auth-provider-specific code is needed in the encryption layer.

### 18.5 Resolution: MongoDB CSFLE Evaluation

**Decision:** CSFLE is not suitable for LibreChat. Use application-layer encryption.

**Investigation findings:**

LibreChat uses Mongoose v8.12.1 (`api/package.json`) with MongoDB driver v6.14.2 (`packages/api/package.json`). The driver version supports CSFLE.

However, CSFLE is unsuitable for LibreChat for the following reasons:

| Requirement | Application-Layer (Chosen) | CSFLE |
|---|---|---|
| Self-hosted MongoDB support | ✅ Works with any MongoDB | ❌ Requires MongoDB Atlas M10+ |
| Per-user encryption keys | ✅ UEK per user via HKDF | ❌ Shared data encryption key for all users |
| Query flexibility | ⚠️ Fallback search with decryption | ❌ Equality queries only on encrypted fields |
| MeiliSearch integration | ⚠️ Requires encrypted-search workaround | ❌ Not compatible with external search engines |
| Shared conversations | ✅ Re-encryption with per-share keys | ❌ No built-in sharing model for encrypted data |
| Mongoose middleware integration | ✅ Natural fit with pre-save/post-find hooks | ⚠️ Requires bypassing Mongoose, using raw driver |
| Cost | ✅ No additional infrastructure cost | ❌ Atlas M10+ tier ($57+/month minimum) + KMS costs |

**Key disqualifier:** LibreChat explicitly supports self-hosted MongoDB. Many enterprise deployments targeted by this feature run on-premise specifically to avoid cloud dependencies. CSFLE's Atlas-only requirement conflicts with this core deployment model.

**Note for documentation:** CSFLE can be mentioned as a complementary defense-in-depth measure for Atlas-hosted deployments, but it cannot replace application-layer encryption.

### 18.6 Resolution: Message Size Limits

**Decision:** 16 MB limit, dictated by MongoDB BSON document size.

**Investigation findings:**

**AES-256-GCM constraints:**
- Theoretical maximum: ~64 GB per nonce (2^39 bytes) — not a practical concern.
- Recommended maximum per NIST: ~64 GB per key before nonce reuse risk — also not a concern for chat messages.

**MongoDB constraints:**
- BSON document maximum: 16 MB (hard limit enforced by the database).
- This is the practical ceiling for any single message document.

**Current LibreChat behavior:**
- The Message schema (`packages/data-schemas/src/schema/message.ts`) has no `maxlength` validation on the `text` field.
- No application-level size validation exists in message routes.
- MongoDB naturally rejects documents exceeding 16 MB.

**Encryption overhead per field:**
- Version prefix (`enc1:`): 4 bytes
- IV: 24 hex characters (12 bytes binary)
- Auth tag: 32 hex characters (16 bytes binary)
- Separators (3 colons): 3 bytes
- Ciphertext: hex-encoded, so 2× the plaintext size
- **Total overhead: ~63 bytes fixed + 1× plaintext size** (hex encoding doubles the size)

**Practical limit calculation:**
- A 7.5 MB plaintext message produces ~15 MB ciphertext (hex-encoded) + 63 bytes overhead.
- With other document fields (~1 KB), the effective plaintext limit is ~7.5 MB per encrypted field.
- For typical chat messages (< 100 KB), this is a non-issue.

**Recommendation:** Add application-level validation during encryption implementation:

```typescript
const MAX_PLAINTEXT_SIZE = 7 * 1024 * 1024; // 7 MB (safe margin for hex encoding + overhead)
```

Consider binary encoding (base64 instead of hex) to reduce overhead from 2× to 1.33×, increasing the effective limit to ~11 MB plaintext.

### 18.7 Resolution: Aggregation Pipeline Handling

**Decision:** No immediate action needed. Provide decryption utilities for Phase 2 analytics.

**Investigation findings:**

All existing aggregation pipelines in the codebase operate exclusively on metadata fields, not on user-generated content:

| Location | Collection | Fields Aggregated | Encrypted? |
|---|---|---|---|
| `api/server/controllers/PermissionsController.js` | `AclEntry` | `resourceType`, `resourceId`, `roleId`, `principalId` | No |
| `packages/data-schemas/src/methods/agentCategory.ts` | `Agent` | `category`, count | No |
| `packages/api/src/prompts/migration.ts` | `PromptGroup` | `author`, migration fields | No |

**No aggregation pipelines currently access:**
- `messages.text` or `messages.content`
- `conversations.title`
- `files.text`
- `memories.value` or `memories.key`
- `toolcalls.result`

This means encryption introduces **zero breaking changes to existing aggregation pipelines**.

**Future analytics considerations:**

For organizations that want analytics over encrypted data (e.g., message volume by topic, sentiment analysis):

1. **Application-layer approach**: Fetch encrypted documents, decrypt in memory, run analytics in application code. Suitable for small-to-medium datasets.
2. **Pre-computed statistics**: During message save, compute and store unencrypted statistical fields (e.g., `wordCount`, `languageCode`, `tokenCount` — already present). These support analytics without decryption.
3. **Batch export**: An admin analytics endpoint that streams decrypted data (using escrowed keys from Phase 2) through an analytics pipeline.

The existing `tokenCount` field on messages is already unencrypted and provides usage analytics without decryption.

---

## 19. Appendix

### A. Glossary

| Term | Definition |
|---|---|
| **UEK** | User Encryption Key — A random 256-bit symmetric key unique to each user. Used to encrypt/decrypt all of that user's data. |
| **KEK** | Key Encryption Key — Derived from the master key and user ID via HKDF. Used only to wrap/unwrap the UEK. |
| **ENCRYPTION_MASTER_KEY** | A 256-bit secret stored as an environment variable. Used as input key material for HKDF to derive per-user KEKs. |
| **HKDF** | HMAC-based Key Derivation Function (RFC 5869). Derives cryptographic keys from a master key with salt and context info. |
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
| `packages/data-schemas/src/schema/user.ts` | User schema; will add `encryptedUEK` and `encryptionVersion` fields |
| `api/server/middleware/requireJwtAuth.js` | Auth middleware; will add UEK resolution and caching |
| `api/strategies/openidStrategy.js` | OIDC strategy; UEK provisioning on first login |
| `api/models/Message.js` | Message model operations; encryption middleware applies here |
| `api/models/Conversation.js` | Conversation model operations; encryption middleware applies here |
| `api/server/routes/messages.js` | Message routes; search behavior changes when encryption enabled |
| `api/server/routes/share.js` | Share routes; re-encryption logic on share creation |
| `packages/api/src/auth/openid.ts` | OIDC user lookup; key provisioning integration point |

### C. External References

- [NIST SP 800-38D — GCM Mode](https://csrc.nist.gov/publications/detail/sp/800-38d/final)
- [RFC 5869 — HKDF](https://datatracker.ietf.org/doc/html/rfc5869)
- [RFC 3394 — AES Key Wrap](https://datatracker.ietf.org/doc/html/rfc3394)
- [Node.js Crypto API](https://nodejs.org/api/crypto.html)
- [MongoDB Client-Side Field Level Encryption](https://www.mongodb.com/docs/manual/core/csfle/)
- [GDPR Article 32 — Security of Processing](https://gdpr-info.eu/art-32-gdpr/)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

### D. Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-03-10 | Use AES-256-GCM over AES-256-CTR | GCM provides authenticated encryption (integrity + confidentiality); CTR provides only confidentiality |
| 2026-03-10 | Use HKDF for key derivation over PBKDF2 | HKDF is designed for deriving keys from already-strong key material (master key); PBKDF2 is for password-based derivation |
| 2026-03-10 | Server-side encryption over client-side E2E | Server must see plaintext to call LLM APIs; true E2E is architecturally incompatible with current design |
| 2026-03-10 | Mongoose middleware over explicit encrypt/decrypt calls | Minimizes changes to existing business logic; transparent to developers |
| 2026-03-10 | Per-user UEK over per-conversation keys | Simpler key management; one key per user vs. potentially thousands per user; per-conversation adds complexity for shared conversations |
| 2026-03-10 | Fallback search over disabling search entirely | Preserves functionality, albeit with performance trade-off; users expect search to work |
| 2026-03-10 | Encrypt conversation tags with blind indexes (Q1) | Tags are user-generated content that may reveal topics; blind indexes (HMAC-SHA-256) enable exact-match `$in` queries without exposing plaintext |
| 2026-03-10 | Defer filename encryption to Phase 2 (Q2) | Files already served by `file_id`; filename only used in `Content-Disposition` header; low sensitivity relative to message content |
| 2026-03-10 | Defer admin key escrow to Phase 2 (Q3) | No admin data-recovery features exist today; per-user isolation is the priority; GDPR right-to-be-forgotten benefits from unrecoverable encryption |
| 2026-03-10 | Support all authentication methods (Q4) | Key derivation uses `user._id` (MongoDB ObjectId), stable and unique across all 9 auth strategies (local, OIDC, LDAP, SAML, Google, GitHub, Discord, Facebook, Apple) |
| 2026-03-10 | Reject CSFLE in favor of application-layer encryption (Q5) | CSFLE requires MongoDB Atlas M10+; LibreChat supports self-hosted MongoDB; CSFLE lacks per-user keys and limits queries to equality only |
| 2026-03-10 | Set 16 MB message size limit with 7 MB plaintext recommendation (Q6) | MongoDB BSON limit is 16 MB; hex-encoded ciphertext doubles size; 7 MB plaintext → ~15 MB ciphertext is safe margin |
| 2026-03-10 | No changes to aggregation pipelines for Phase 1 (Q7) | All existing aggregations operate on metadata fields (categories, authors, counts), not user-generated content; zero breaking changes |
