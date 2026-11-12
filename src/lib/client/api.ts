"use client";

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new ApiError(body?.error?.code ?? "server_error", body?.error?.message ?? `Request failed (${res.status})`);
  }
  return body.data as T;
}

export async function act<T = unknown>(name: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/actions/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parse<T>(res);
}

export async function getJson<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url, { cache: "no-store" }));
}

export async function post<T = unknown>(url: string, payload: unknown): Promise<T> {
  return parse<T>(await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
}
