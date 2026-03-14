## Distributed Document Search Service - Architecture

### 1. Overview

This prototype implements a **multi-tenant document search service** that can be evolved into an enterprise-grade, horizontally scalable system. The goal of the implementation is to demonstrate solid architectural thinking (separation of concerns, clear contracts, extensibility) while keeping the runtime dependencies lightweight for local execution.

- **Tech stack (prototype)**: Node.js, TypeScript, Express, in-memory storage and search index
- **Intended production stack**: Node.js (or JVM/.NET), API gateway, Elasticsearch or PostgreSQL FTS, Redis, message broker (Kafka/RabbitMQ), observability stack (Prometheus/Grafana/OpenTelemetry)

The prototype focuses on:
- Clean **API contracts**
- Explicit **multi-tenancy boundaries**
- A pluggable **search engine abstraction**
- Demonstrations of **caching**, **rate limiting**, and **health checks**

---

### 2. High-Level Architecture

#### 2.1 Component Diagram (conceptual)

```text
+---------------------------+        +------------------------+
|        API Clients        |        |   Admin / Dev Tools    |
+-------------+-------------+        +-----------+------------+
              |                                   |
              v                                   v
        +-----+-----------------------------------+--------------------+
        |                  API Gateway / Load Balancer                 |
        +-----+----------------------------+---------------------------+
              |                            |
              v                            v
      +-------+---------+          +-------+---------+
      |  Search Service |          |Document service |
      |  (this service) |          |                 |
      +---+------+------+          +-----------------+
          |      |       
          |      |        
   +-------+  +---+---+ 
   | DB    |  | Index |
   |       |  | Store |
   +---+---+  +---+---+
       |          |
       v          v
   +---+----------+------------+--------------------+
   |           Persistent Storage                   |
   |  - Elasticsearch                               |
   |  - PostgreSQL (metadata, tenants, auth)        |
   +-----------------------------------------------+
```

In the prototype, the **Search Service** is implemented as a single Node.js process with:
- In-memory **document store**
- In-memory **inverted index** per tenant
- In-memory **cache** and **rate limiter**

These components are wrapped behind interfaces so they can be swapped for real infrastructure later.

---

### 3. Data Flow

#### 3.1 Indexing a Document (`POST /documents`)

```text
Client
  |
  | 1. HTTP POST /documents (with tenant header)
  v
API Layer (Express)
  |
  | 2. Tenant resolution & validation
  | 3. Request Validation & ID generation
  v
Document Service
  |
  | 4. Persist to document store (prototype: in-memory map)
  | 5. Update search index (prototype: in-memory inverted index)
  | 6. Invalidate relevant cache entries for this tenant
  v
Response (201 + document)
```

In a production system, step 4 would be **preparesd statement write** to a database, and step 5 would typically be **asynchronous** via a message broker:
- API writes document to primary store
- Emits an `DocumentIndexed` event to Kafka/RabbitMQ
- Dedicated indexer workers consume the event and update Elasticsearch index

#### 3.2 Searching Documents (`GET /search?q=&tenant=`)

```text
Client
  |
  | 1. HTTP GET /search?q=foo&tenant=tenantA
  v
API Layer
  |
  | 2. Resolve tenant (from query / header)
  | 3. Normalize query -> cache key
  v
Caching Layer
  |
  | 4a. Cache hit -> return cached results
  | 4b. Cache miss ->
  v
Search Engine
  |
  | 5. Lookup index for tenant
  | 6. Score and rank documents
  v
API Layer
  |
  | 7. Store results in cache (with TTL)
  v
Response (200 + ranked results)
```

In production, the **Search Engine** would be an Elasticsearch cluster and the cache would be Redis or a managed distributed cache.

---

### 4. Storage & Search Strategy

#### 4.1 Prototype Storage

- **Document store**: In-memory map keyed by `tenantId` and `documentId`
- **Search index**: Per-tenant in-memory inverted index:
  - Tokenization: lowercase, split on non-alphanumeric characters
  - Index key: term -> set of document IDs for that tenant
  - Scoring: simple term frequency / overlap count for relevance

This is intentionally simple but mirrors how a real inverted index works conceptually.

#### 4.2 Production Storage

- **Primary database**: PostgreSQL or similar RDBMS
  - Tables: `tenants`, `documents`, `users`, `permissions`, etc.
  - Use PostgreSQL FTS or materialized views for simple deployments
- **Search engine**: Elasticsearch 
  - Dedicated indices per tenant, or index-per-region with a `tenant_id` field
  - Sharding and replication configured for horizontal scalability
  - Index templates and analyzers tuned per language/domain
- **Cache**: Redis
  - Search result cache by `(tenantId, queryHash)`
  - Hot document cache by `(tenantId, documentId)`

---

### 5. API Design

#### 5.1 Key Endpoints

- `POST /documents`
  - Headers: `X-Tenant-Token: <tenantId>`
  - Body: `{ "title": string, "content": string, "metadata"?: object }`
  - Response: `201 Created` with `{ "id": string, "tenantId": string, ... }`

- `GET /documents/{id}`
  - Headers: `X-Tenant-Token: <tenantId>`
  - Response: `200 OK` with document, or `404` if not found in that tenant

- `DELETE /documents/{id}`
  - Headers: `X-Tenant-Token: <tenantId>`
  - Response: `204 No Content` or `404`

- `GET /search?q={query}&tenant={tenantId}`
  - Query: `q` (required), `tenant` (required), `limit` (optional)
  - Response: list of documents with basic relevance scores

- `GET /health`
  - Response: `{ "status": "ok", "uptime": number, "dependencies": { ... } }`

All endpoints return machine-friendly error objects with clear messages and correlation IDs (for observability).

#### 5.2 Consistency Model & Trade-offs

- **Prototype**: All operations are in-memory and synchronous -> effectively **strongly consistent** within a single process.
- **Intended production model**:
  - **Write path**: Document is written to primary store and an event is published for indexing.
  - **Search path**: Queries hit the search index which is eventually consistent with the primary store.

Trade-offs:
- **Eventual consistency** on search results in exchange for:
  - Higher write throughput
  - Decoupled indexing pipelines
  - Ability to reindex without impacting the primary database
- For strict requirements (e.g., legal documents), the API can expose a **read-your-writes** option that hits the primary store directly or forces a refresh on the search index (with stricter latency/SLA).

---

### 6. Caching Strategy

- **Prototype**:
  - In-memory LRU cache of search results per tenant keyed by `(tenantId, normalizedQuery)`.
  - Short TTL (e.g., 30–60 seconds) to reduce stale data issues.
  - Cache invalidation on document create/delete for the affected tenant (simple: clear tenant’s cache namespace).

- **Production**:
  - Redis cluster as centralized cache.
  - Separate keys for:
    - Hot search queries (`search:{tenantId}:{hash(query)}`)
    - Frequently accessed documents (`doc:{tenantId}:{id}`)
  - Use probabilistic TTL jitter to avoid cache stampedes.
  - Apply **request coalescing** on cache misses for expensive queries.

---

### 7. Message Queue Usage (for real deployment)

Although the prototype is single-process and synchronous, the architecture is designed around an **event-driven indexing pipeline**:

- On `POST /documents` or `DELETE /documents/{id}`:
  - Persist the change to the primary DB.
  - Publish events such as `DocumentCreated`, `DocumentUpdated`, `DocumentDeleted` to Kafka or RabbitMQ.
- Dedicated **indexer workers**:
  - Consume events and update the search index.
  - Can be scaled independently based on indexing load.

Benefits:
- Decouples API latency from indexing latency.
- Enables **bulk reindexing** and **backfills** without impacting API.
- Provides a natural place to add transformations, enrichment, or ML-based relevance signals.

---

### 8. Multi-Tenancy & Isolation

- **Prototype**:
  - Tenant is resolved from `X-Tenant-Token` header (for document endpoints) and from `tenant` query parameter (for `/search` to match the assignment).
  - All in-memory structures are **namespaced by tenant**:
    - `documents[tenantId][documentId]`
    - `index[tenantId][term] -> Set<documentId>`
    - `rateLimits[tenantId]`
    - `cache[tenantId]`
  - There is **no possibility of cross-tenant leaks** within the process because every store lookup is keyed by tenant ID.

- **Production options**:
  - **Logical isolation**: Single cluster, indices keyed by tenant field, RLS (Row-Level Security) in the DB.
  - **Index-per-tenant**: Each tenant has its own index (or schema). Better isolation and tuning at the cost of operational overhead.
  - **Physical isolation**: High-value or regulated tenants get dedicated clusters/DBs.

Tenant security considerations:
- user Authorization should be tied to the **authenticated principal** (e.g., from JWT claims), not accepted blindly from headers.
- Access control performed at the **API gateway** and **service layer**, enforcing per-tenant quotas, roles, and data access policies.

---

### 9. Rate Limiting & Health Checks

- **Rate limiting (prototype)**:
  - Simple token-bucket / sliding-window implementation keyed by tenant ID.
  - Applies per-tenant limits (e.g., X requests/minute).
  - Enforced via Express middleware, returning `429 Too Many Requests` when exceeded.

- **Production rate limiting**:
  - Move enforcement to the **API gateway** (e.g., NGINX, Envoy, AWS API Gateway, Kong).
  - Maintain counters in Redis or a purpose-built rate-limiting service.
  - Support differentiated plans (per-tenant SLAs, burst limits, paid tiers).

- **Health checks**:
  - `GET /health` in prototype returns:
    - Service uptime
    - Basic self-check for in-memory stores
  - In production:
    - Liveness and readiness probes for container orchestration (Kubernetes).
    - Dependency checks for DB, cache, search cluster, and message broker.

---

### 10. Assumptions

- The prototype is **single-node** and optimized for local evaluation, not massive scale.
- Authentication and authorization are **out of scope** for the prototype but are addressed in the production-readiness section.
- Target response times such as **sub-500ms for most search requests and 1000+ queries per second** are validated at the full system level (with a real search backend and distributed cache) rather than in this lightweight implementation.

---

### 11. Production Readiness Analysis

#### 11.1 Scalability

- **Scale-out strategy**:
  - Stateless API pods behind a load balancer (Kubernetes Deployment / HPA).
  - Search clusters (Elasticsearch) scaled horizontally via shards and replicas.
  - Separate read/write nodes and dedicated ingestion clusters for heavy indexing workloads.
- **Handling 100x growth**:
  - Partition tenants by region or tier to avoid hot-spot clusters.
  - Use index lifecycle management (ILM) and tiered storage (hot/warm/cold) for aging documents.
  - Apply aggressive caching and query optimization to ensure **most search requests return in under 500ms**, even as traffic grows.

#### 11.2 Resilience

- **Circuit breakers and retries**:
  - Use a resilience library (e.g., Resilience4j, Envoy retry policies) for outbound calls to search, DB, and cache.
  - Implement exponential backoff with jitter and bounded retries.
- **Failover strategies**:
  - Multi-AZ deployment for API, DB, and search clusters.
  - Read replicas and automated failover (e.g., managed PostgreSQL with HA).
  - Graceful degradation: if search is degraded, fall back to cached results or reduced-fidelity queries.

#### 11.3 Security

- **Authentication / authorization**:
  - OAuth2/OIDC with JWT access tokens, validated at the API gateway and in the service.
  - Tenant ID derived from token claims (e.g., `tenant_id`), not from client-supplied headers.
  - Fine-grained roles: e.g., admin vs. read-only user per tenant.
- **Data protection**:
  - TLS for all in-transit communication (client → gateway → service → dependencies).
  - Encryption at rest via managed services (KMS-backed keys).
  - Per-tenant encryption keys for high-sensitivity tenants where required.
- **API security**:
  - Strict input validation and structured error responses.
  - Rate limiting and WAF rules to mitigate brute-force and abuse.

#### 11.4 Observability

- **Metrics**:
  - Request rate and response time percentiles (median, slow requests, and tail latency) by endpoint and tenant tier.
  - Error rates and cause breakdown (4xx vs. 5xx).
  - Indexing throughput and lag between primary DB and search index.
- **Logging**:
  - Structured JSON logs with correlation IDs, tenant IDs, and key request metadata.
  - Centralized log aggregation and search (e.g., ELK stack, Loki, Cloud provider).
- **Tracing**:
  - OpenTelemetry instrumentation end-to-end (client → gateway → service → dependencies).
  - Traces tagged with tenant and request context for rapid incident triage.

#### 11.5 Performance

- **Database optimization**:
  - Proper indexing on `tenant_id`, `document_id`, and frequently filtered fields.
  - Connection pooling and prepared statements.
  - Background jobs for maintenance (VACUUM, index rebalancing, stats collection).
- **Search optimization**:
  - Carefully chosen analyzers, stop-word filters, and query templates.
  - Use of query-time boosts and pre-computed relevance signals when available.
  - Throttling and pagination for very heavy queries.

#### 11.6 Operations & SLA

- **Deployments**:
  - Blue-green or canary deployment strategies with automated rollbacks.
  - Infrastructure-as-code (Terraform, CloudFormation) for repeatable environments.
  - Zero-downtime schema and index migrations via dual-write / shadow indices.
- **Backups & recovery**:
  - Regular DB backups with tested restore procedures and RPO/RTO targets.
  - Snapshot/restore policies for search indices.
- **SLA (99.95% availability)**:
  - Multi-AZ redundancy, health-checked instances, and automatic restarts.
  - Capacity planning using historical load and headroom targets.
  - Runbooks and on-call rotations for critical paths (search, indexing, auth).

---

### 12. Enterprise Experience Showcase

#### 12.1 Similar Distributed System

On a previous project, I worked on CP Grams, a large-scale grievance and event processing platform that handled data ingestion and search across multiple government and enterprise systems. The system leveraged PostgreSQL as the primary transactional database, with Elasticsearch and vector search to power fast full-text and semantic retrieval across large datasets. One of the key components was a user complaints module, where the complaints table was partitioned by the created_at timestamp to efficiently manage high-volume time-series data and improve query performance. To ensure reliability and scalability, we implemented database replication across multiple PostgreSQL nodes, enabling high availability and read scaling. The platform also required careful handling of schema evolution and tenant isolation while maintaining low query latency as data volume grew.

#### 12.2 Performance Optimization

In another engagement, a critical API was experiencing **very slow response times for some requests (several seconds)** due to repeated N+1 queries and inefficient database access patterns.

Additionally, we leveraged **shared buffers** to keep frequently accessed query results and data pages readily available, which further improved response times. With improved connection pooling and these caching optimizations in place, **Response times for even the slower requests dropped from several seconds to under 150 ms**, while **database load was reduced by more than half**.


#### 12.3 Production Incident Resolution

Implemented a health monitoring service to detect system disturbances. If a service became unhealthy, it was automatically restarted, and alerts were sent to the relevant Slack channels and email groups to ensure quick visibility and response.


#### 12.4 Architectural Trade-off Decision

On a large SaaS platform, we had to choose between a **monolithic architecture and microservices**. We adopted a **hybrid approach**: less frequently used APIs and stable components remained in the monolith for simplicity, while high-traffic and performance-critical features were extracted into **dedicated microservices**. This allowed us to scale the most demanding parts of the system independently while keeping operational complexity manageable.


---

### 13. AI Tool Usage

For this assessment, I used AI assistance primarily to:

- Accelerate boilerplate scaffolding (Node.js/TypeScript project setup, Dockerfile, and basic Express wiring).
- Sanity-check wording and structure of documentation sections while ensuring the architecture and trade-offs reflect my own design choices and prior experience.
- I used cursor, ChatGPT for assistance.

Design decisions (e.g., multi-tenancy model, indexing pipeline, consistency model, and production-readiness strategies) are based on patterns I have successfully used in real distributed systems.


