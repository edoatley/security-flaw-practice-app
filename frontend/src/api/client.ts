// @spec AUTH-023, AUTH-024, AUTH-025, AUTH-026, AUTH-031

const API_URL = import.meta.env.VITE_API_URL as string;

let accessToken: string | null = null;
let isRefreshing = false;
let refreshQueue: Array<(token: string | null) => void> = [];

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

async function doRefresh(): Promise<string | null> {
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token: string; expires_in: number };
  accessToken = data.access_token;
  return data.access_token;
}

export async function refreshTokens(): Promise<string | null> {
  if (isRefreshing) {
    return new Promise((resolve) => {
      refreshQueue.push(resolve);
    });
  }
  isRefreshing = true;
  const token = await doRefresh();
  refreshQueue.forEach((cb) => cb(token));
  refreshQueue = [];
  isRefreshing = false;
  if (!token) {
    window.dispatchEvent(new Event("SESSION_EXPIRED"));
  }
  return token;
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  const makeRequest = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "include",
      signal: controller.signal,
    });

  try {
    let res = await makeRequest(accessToken);

    if (res.status === 401) {
      const newToken = await refreshTokens();
      if (!newToken) throw new Error("SESSION_EXPIRED");
      res = await makeRequest(newToken);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { code: "UNKNOWN" } }));
      throw Object.assign(new Error((err as { error?: { code?: string } }).error?.code ?? "REQUEST_FAILED"), {
        status: res.status,
        body: err,
      });
    }

    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}
