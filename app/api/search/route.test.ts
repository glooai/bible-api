import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createRequest = (headers?: Record<string, string>) => {
  const init: RequestInit = {};

  if (headers) {
    init.headers = new Headers(headers);
  }

  return new NextRequest('https://example.com/api/search', init);
};

const loadRoute = () => import('./route');

describe('GET /api/search', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 500 when API key is not configured', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await loadRoute();
    const response = await GET(createRequest());
    const body = await response.json();

    expect(errorSpy).toHaveBeenCalledWith('API_KEY environment variable is not set');
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: 'Server misconfiguration: missing API key',
    });
  });

  it('returns 401 when request does not include a valid API key', async () => {
    process.env.API_KEY = 'super-secret-key';

    const { GET } = await loadRoute();

    const missingKeyResponse = await GET(createRequest());
    const missingKeyBody = await missingKeyResponse.json();

    expect(missingKeyResponse.status).toBe(401);
    expect(missingKeyBody).toEqual({ error: 'Unauthorized' });

    const wrongKeyResponse = await GET(
      createRequest({ 'x-api-key': 'wrong-key' }),
    );
    const wrongKeyBody = await wrongKeyResponse.json();

    expect(wrongKeyResponse.status).toBe(401);
    expect(wrongKeyBody).toEqual({ error: 'Unauthorized' });
  });

  it('returns placeholder payload when API key matches request header', async () => {
    const apiKey = 'super-secret-key';
    process.env.API_KEY = apiKey;

    const { GET } = await loadRoute();
    const response = await GET(createRequest({ 'x-api-key': apiKey }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      message: 'Search endpoint placeholder',
      results: [],
    });
  });
});
