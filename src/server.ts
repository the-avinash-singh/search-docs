import express, { Request, Response, NextFunction } from "express";
import morgan from "morgan";
import { v4 as uuidv4 } from "uuid";

type TenantId = string;

interface Document {
  id: string;
  tenantId: TenantId;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// In-memory stores (prototype only)
const documentsByTenant: Map<TenantId, Map<string, Document>> = new Map();
const indexByTenant: Map<TenantId, Map<string, Set<string>>> = new Map();

// Simple per-tenant search cache
interface CachedResult {
  results: Document[];
  createdAt: number;
}

const cacheByTenant: Map<TenantId, Map<string, CachedResult>> = new Map();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES_PER_TENANT = 100;

// Simple per-tenant rate limiting
interface RateLimitBucket {
  windowStart: number;
  count: number;
}

const rateLimitByTenant: Map<TenantId, RateLimitBucket> = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS_PER_TENANT = 120; // per minute (prototype)

// Utilities
function getTenantIdFromRequest(req: Request): TenantId | null {
  // For document endpoints we expect header; for /search we also support query param to match spec.
  const fromHeader = (req.header("X-Tenant-Id") || req.header("x-tenant-id") || "").trim();
  const fromQuery = (req.query.tenant as string | undefined)?.trim();
  return fromQuery || fromHeader || null;
}

function getOrCreateTenantDocStore(tenantId: TenantId): Map<string, Document> {
  let store = documentsByTenant.get(tenantId);
  if (!store) {
    store = new Map();
    documentsByTenant.set(tenantId, store);
  }
  return store;
}

function getOrCreateTenantIndex(tenantId: TenantId): Map<string, Set<string>> {
  let idx = indexByTenant.get(tenantId);
  if (!idx) {
    idx = new Map();
    indexByTenant.set(tenantId, idx);
  }
  return idx;
}

function getOrCreateTenantCache(tenantId: TenantId): Map<string, CachedResult> {
  let cache = cacheByTenant.get(tenantId);
  if (!cache) {
    cache = new Map();
    cacheByTenant.set(tenantId, cache);
  }
  return cache;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function indexDocument(doc: Document): void {
  const index = getOrCreateTenantIndex(doc.tenantId);
  const terms = new Set<string>([
    ...tokenize(doc.title),
    ...tokenize(doc.content),
  ]);
  for (const term of terms) {
    let postings = index.get(term);
    if (!postings) {
      postings = new Set();
      index.set(term, postings);
    }
    postings.add(doc.id);
  }
}

function removeDocumentFromIndex(tenantId: TenantId, docId: string): void {
  const index = indexByTenant.get(tenantId);
  if (!index) return;
  for (const [, postings] of index) {
    postings.delete(docId);
  }
}

function clearTenantCache(tenantId: TenantId): void {
  cacheByTenant.delete(tenantId);
}

function searchDocuments(tenantId: TenantId, query: string, limit = 10): Document[] {
  const docs = documentsByTenant.get(tenantId);
  const index = indexByTenant.get(tenantId);
  if (!docs || !index) return [];

  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const scores: Map<string, number> = new Map();

  for (const term of terms) {
    const postings = index.get(term);
    if (!postings) continue;
    for (const docId of postings) {
      scores.set(docId, (scores.get(docId) ?? 0) + 1);
    }
  }

  const ranked = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([docId]) => docs.get(docId))
    .filter((d): d is Document => Boolean(d));

  return ranked;
}

// Express app setup
const app = express();
app.use(express.json());
app.use(morgan("dev"));

// Correlation ID for logging (simple prototype)
app.use((req: Request, res: Response, next: NextFunction) => {
  (req as any).correlationId = uuidv4();
  res.setHeader("X-Correlation-Id", (req as any).correlationId);
  next();
});

// Tenant resolution middleware
function requireTenant(req: Request, res: Response, next: NextFunction) {
  const tenantId = getTenantIdFromRequest(req);
  if (!tenantId) {
    return res.status(400).json({
      error: "TENANT_REQUIRED",
      message: "Tenant identifier is required (X-Tenant-Id header or tenant query param).",
    });
  }
  (req as any).tenantId = tenantId;
  next();
}

// Rate limiting middleware
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const tenantId = (req as any).tenantId as TenantId | undefined;
  if (!tenantId) return next(); // requireTenant should have run first

  const now = Date.now();
  let bucket = rateLimitByTenant.get(tenantId);
  if (!bucket) {
    bucket = { windowStart: now, count: 0 };
    rateLimitByTenant.set(tenantId, bucket);
  }

  if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    bucket.windowStart = now;
    bucket.count = 0;
  }

  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX_REQUESTS_PER_TENANT) {
    return res.status(429).json({
      error: "RATE_LIMIT_EXCEEDED",
      message: "Rate limit exceeded for tenant.",
    });
  }

  next();
}

// Health check
app.get("/health", (req: Request, res: Response) => {
  const now = new Date().toISOString();

  const dependencies = {
    documentStore: {
      status: "ok",
      tenants: documentsByTenant.size,
    },
    searchIndex: {
      status: "ok",
      tenants: indexByTenant.size,
    },
    cache: {
      status: "ok",
      tenants: cacheByTenant.size,
    },
    rateLimiter: {
      status: "ok",
      tenants: rateLimitByTenant.size,
    },
  };

  res.json({
    status: "ok",
    uptimeSeconds: process.uptime(),
    timestamp: now,
    dependencies,
  });
});

// Document endpoints
app.post("/documents", requireTenant, rateLimit, (req: Request, res: Response) => {
  const tenantId = (req as any).tenantId as TenantId;
  const { title, content, metadata } = req.body ?? {};

  if (!title || !content || typeof title !== "string" || typeof content !== "string") {
    return res.status(400).json({
      error: "INVALID_PAYLOAD",
      message: "Both 'title' and 'content' fields are required as strings.",
    });
  }

  const now = new Date().toISOString();
  const doc: Document = {
    id: uuidv4(),
    tenantId,
    title,
    content,
    metadata: typeof metadata === "object" && metadata !== null ? metadata : undefined,
    createdAt: now,
    updatedAt: now,
  };

  const store = getOrCreateTenantDocStore(tenantId);
  store.set(doc.id, doc);
  indexDocument(doc);
  clearTenantCache(tenantId);

  return res.status(201).json(doc);
});

app.get("/documents/:id", requireTenant, rateLimit, (req: Request, res: Response) => {
  const tenantId = (req as any).tenantId as TenantId;
  const id = req.params.id;

  const store = documentsByTenant.get(tenantId);
  const doc = store?.get(id);
  if (!doc) {
    return res.status(404).json({
      error: "NOT_FOUND",
      message: "Document not found for this tenant.",
    });
  }

  return res.json(doc);
});

app.delete("/documents/:id", requireTenant, rateLimit, (req: Request, res: Response) => {
  const tenantId = (req as any).tenantId as TenantId;
  const id = req.params.id;

  const store = documentsByTenant.get(tenantId);
  if (!store || !store.has(id)) {
    return res.status(404).json({
      error: "NOT_FOUND",
      message: "Document not found for this tenant.",
    });
  }

  store.delete(id);
  removeDocumentFromIndex(tenantId, id);
  clearTenantCache(tenantId);

  return res.status(204).send();
});

// Search endpoint (uses tenant query param to match spec)
app.get("/search", requireTenant, rateLimit, (req: Request, res: Response) => {
  const tenantId = (req as any).tenantId as TenantId;
  const q = (req.query.q as string | undefined)?.trim();
  const limit = req.query.limit ? Number(req.query.limit) : 10;

  if (!q) {
    return res.status(400).json({
      error: "INVALID_QUERY",
      message: "Query parameter 'q' is required.",
    });
  }

  const cache = getOrCreateTenantCache(tenantId);
  const cacheKey = JSON.stringify({ q: q.toLowerCase(), limit });
  const now = Date.now();

  const cached = cache.get(cacheKey);
  if (cached && now - cached.createdAt <= CACHE_TTL_MS) {
    return res.json({
      source: "cache",
      results: cached.results,
    });
  }

  const results = searchDocuments(tenantId, q, limit);

  // Simple LRU eviction strategy
  if (cache.size >= CACHE_MAX_ENTRIES_PER_TENANT) {
    const iterator = cache.keys().next();
    if (!iterator.done) {
      cache.delete(iterator.value);
    }
  }
  cache.set(cacheKey, { results, createdAt: now });

  return res.json({
    source: "live",
    results,
  });
});

// Basic error handler
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error", { err });
  res.status(500).json({
    error: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred.",
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Document search service listening on port ${PORT}`);
});

