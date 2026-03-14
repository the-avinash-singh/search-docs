## Distributed Document Search Service (Prototype)

This repository contains a **prototype implementation** of a multi-tenant distributed document search service for the technical assessment.

The focus is on **clean architecture, multi-tenancy, and production thinking**, not on fully production-ready infrastructure.

### 1. Features

- **REST API** with required endpoints:
  - `POST /documents` – index a new document
  - `GET /search` – search documents
  - `GET /documents/:id` – retrieve a document
  - `DELETE /documents/:id` – delete a document
  - `GET /health` – health check
- **Multi-tenancy**:
  - Documents endpoints use `X-Tenant-Token` header
  - Search endpoint accepts `tenant` query parameter (per assignment)
- **In-memory search index**:
  - Simple inverted index with basic relevance ranking
- **Caching**:
  - In-memory per-tenant cache of search results with TTL and basic LRU eviction
- **Rate limiting**:
  - Simple per-tenant sliding-window limiter (requests/minute)

See `ARCHITECTURE.md` for detailed architectural explanation and production-oriented design.

### 2. Running Locally (Node.js)

**Prerequisites**:

- Node.js 18+ (tested with 18/20)
- npm

```bash
npm install
npm run build
npm start
```

The service will listen on port `3000` by default. You can change the port via `PORT` environment variable.

For rapid iteration in development:

```bash
npm run dev
```

### 3. Running with Docker

Build and run using Docker:

```bash
docker build -t doc-search-service .
docker run --rm -p 3000:3000 doc-search-service
```

Or using `docker-compose`:

```bash
docker-compose up --build
```

The API will be available at `http://localhost:3000`.

### 4. Sample API Requests (curl)

#### 4.1 Index a document

```bash
curl -X POST http://localhost:3000/documents \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Token: tenant-a" \
  -d '{
    "title": "Distributed Systems Basics",
    "content": "This document introduces distributed systems and scalability concepts.",
    "metadata": { "category": "intro" }
  }'
```

#### 4.2 Search documents

```bash
curl "http://localhost:3000/search?q=distributed&tenant=tenant-a"
```

#### 4.3 Get a document by ID

```bash
curl http://localhost:3000/documents/<DOCUMENT_ID> \
  -H "X-Tenant-Token: tenant-a"
```

#### 4.4 Delete a document

```bash
curl -X DELETE http://localhost:3000/documents/<DOCUMENT_ID> \
  -H "X-Tenant-Token: tenant-a"
```

#### 4.5 Health check

```bash
curl http://localhost:3000/health
```

### 5. Project Structure

- `src/server.ts` – Express application with endpoints, multi-tenancy, caching, and rate limiting
- `ARCHITECTURE.md` – Architecture design, data flow, and key decisions
- `README.md` – How to build and run, sample requests
- `Dockerfile` / `docker-compose.yml` – Container and orchestration setup

### 6. Notes

- This is intentionally an in-memory prototype for simplicity and clarity during review.
- A realistic production deployment would plug in external services (OpenSearch/Elasticsearch, PostgreSQL, Redis, Kafka/RabbitMQ, etc.) as outlined in `ARCHITECTURE.md`.

