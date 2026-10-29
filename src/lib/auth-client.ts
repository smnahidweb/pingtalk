"use client";

import { createAuthClient } from "better-auth/react";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:5000" : undefined);

if (!apiBaseUrl) {
  throw new Error("NEXT_PUBLIC_API_URL must be configured for the frontend.");
}

export const authClient = createAuthClient({
  baseURL:
    typeof window === "undefined"
      ? apiBaseUrl.replace(/\/+$/, "")
      : window.location.origin,
  fetchOptions: {
    credentials: "include",
  },
});

export type AuthUser = typeof authClient.$Infer.Session.user;
