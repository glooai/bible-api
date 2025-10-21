import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSearchBible = vi.fn();

vi.mock("@/lib/bible/index", () => ({
  searchBible: mockSearchBible,
}));

const createRequest = (options?: {
  headers?: Record<string, string>;
  search?: Record<string, string | number | undefined | null>;
}) => {
  const init: ConstructorParameters<typeof NextRequest>[1] = {};

  if (options?.headers) {
    init.headers = new Headers(options.headers);
  }

  const url = new URL("https://example.com/api/search");
  if (options?.search) {
    for (const [key, value] of Object.entries(options.search)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return new NextRequest(url, init);
};

const loadRoute = () => import("./route");

describe("GET /api/search", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.API_KEY;
    mockSearchBible.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 500 when API key is not configured", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { GET } = await loadRoute();
    const response = await GET(createRequest());
    const body = await response.json();

    expect(errorSpy).toHaveBeenCalledWith(
      "API_KEY environment variable is not set"
    );
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "Server misconfiguration: missing API key",
    });
  });

  it("returns 401 when request does not include a valid API key", async () => {
    process.env.API_KEY = "super-secret-key";

    const { GET } = await loadRoute();

    const missingKeyResponse = await GET(createRequest());
    const missingKeyBody = await missingKeyResponse.json();

    expect(missingKeyResponse.status).toBe(401);
    expect(missingKeyBody).toEqual({ error: "Unauthorized" });

    const wrongKeyResponse = await GET(
      createRequest({ headers: { "x-api-key": "wrong-key" } })
    );
    const wrongKeyBody = await wrongKeyResponse.json();

    expect(wrongKeyResponse.status).toBe(401);
    expect(wrongKeyBody).toEqual({ error: "Unauthorized" });
  });

  it("returns 400 when no search term is provided", async () => {
    process.env.API_KEY = "super-secret-key";
    const { GET } = await loadRoute();

    const response = await GET(
      createRequest({ headers: { "x-api-key": "super-secret-key" } })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "Missing search term. Provide `term` or `q` query parameter.",
    });
    expect(mockSearchBible).not.toHaveBeenCalled();
  });

  it("returns search results when API key matches request header", async () => {
    const apiKey = "super-secret-key";
    process.env.API_KEY = apiKey;
    const fakeResults = [
      {
        book: "John",
        chapter: 3,
        verse: 16,
        text: "For God so loved the world...",
        translation: "NLT",
        score: 0.99,
      },
    ];

    mockSearchBible.mockResolvedValue(fakeResults);

    const { GET } = await loadRoute();
    const response = await GET(
      createRequest({
        headers: { "x-api-key": apiKey },
        search: { term: "love", limit: "5", translation: "KJV" },
      })
    );
    const body = await response.json();

    expect(mockSearchBible).toHaveBeenCalledWith({
      term: "love",
      limit: 5,
      maxResults: undefined,
      translation: "KJV",
    });
    expect(response.status).toBe(200);
    expect(body).toEqual({
      term: "love",
      translation: "KJV",
      results: fakeResults,
    });
  });

  it("returns 400 when limit is invalid", async () => {
    const apiKey = "super-secret-key";
    process.env.API_KEY = apiKey;

    const { GET } = await loadRoute();
    const response = await GET(
      createRequest({
        headers: { "x-api-key": apiKey },
        search: { term: "love", limit: "invalid" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "Query parameter `limit` must be a finite number.",
    });
    expect(mockSearchBible).not.toHaveBeenCalled();
  });

  it("returns 500 when searchBible throws", async () => {
    const apiKey = "super-secret-key";
    process.env.API_KEY = apiKey;
    const error = new Error("Database unavailable");
    mockSearchBible.mockRejectedValue(error);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { GET } = await loadRoute();
    const response = await GET(
      createRequest({
        headers: { "x-api-key": apiKey },
        search: { term: "love" },
      })
    );
    const body = await response.json();

    expect(errorSpy).toHaveBeenCalledWith("Bible search failed", error);
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "Unable to complete Bible search.",
    });
  });

  it("handles maxResults parameter correctly", async () => {
    const apiKey = "super-secret-key";
    process.env.API_KEY = apiKey;
    const fakeResults = [
      {
        book: "John",
        chapter: 3,
        verse: 16,
        text: "For God so loved the world...",
        translation: "NLT",
        score: 0.99,
      },
    ];

    mockSearchBible.mockResolvedValue(fakeResults);

    const { GET } = await loadRoute();
    const response = await GET(
      createRequest({
        headers: { "x-api-key": apiKey },
        search: { term: "love", maxResults: "3" },
      })
    );
    const body = await response.json();

    expect(mockSearchBible).toHaveBeenCalledWith({
      term: "love",
      limit: undefined,
      maxResults: 3,
      translation: undefined,
    });
    expect(response.status).toBe(200);
    expect(body).toEqual({
      term: "love",
      translation: undefined,
      results: fakeResults,
    });
  });

  it("returns 400 when maxResults is invalid", async () => {
    const apiKey = "super-secret-key";
    process.env.API_KEY = apiKey;

    const { GET } = await loadRoute();
    const response = await GET(
      createRequest({
        headers: { "x-api-key": apiKey },
        search: { term: "love", maxResults: "invalid" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "Query parameter `maxResults` must be a finite number.",
    });
    expect(mockSearchBible).not.toHaveBeenCalled();
  });

  it("returns 400 when maxResults is negative", async () => {
    const apiKey = "super-secret-key";
    process.env.API_KEY = apiKey;

    const { GET } = await loadRoute();
    const response = await GET(
      createRequest({
        headers: { "x-api-key": apiKey },
        search: { term: "love", maxResults: "-1" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "Query parameter `maxResults` cannot be negative.",
    });
    expect(mockSearchBible).not.toHaveBeenCalled();
  });

  it("returns 400 when maxResults is not an integer", async () => {
    const apiKey = "super-secret-key";
    process.env.API_KEY = apiKey;

    const { GET } = await loadRoute();
    const response = await GET(
      createRequest({
        headers: { "x-api-key": apiKey },
        search: { term: "love", maxResults: "1.5" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "Query parameter `maxResults` must be an integer.",
    });
    expect(mockSearchBible).not.toHaveBeenCalled();
  });

  it("handles q parameter as alias for term", async () => {
    const apiKey = "super-secret-key";
    process.env.API_KEY = apiKey;
    const fakeResults = [
      {
        book: "John",
        chapter: 3,
        verse: 16,
        text: "For God so loved the world...",
        translation: "NLT",
        score: 0.99,
      },
    ];

    mockSearchBible.mockResolvedValue(fakeResults);

    const { GET } = await loadRoute();
    const response = await GET(
      createRequest({
        headers: { "x-api-key": apiKey },
        search: { q: "love" },
      })
    );
    const body = await response.json();

    expect(mockSearchBible).toHaveBeenCalledWith({
      term: "love",
      limit: undefined,
      maxResults: undefined,
      translation: undefined,
    });
    expect(response.status).toBe(200);
    expect(body).toEqual({
      term: "love",
      translation: undefined,
      results: fakeResults,
    });
  });
});
