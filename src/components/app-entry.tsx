"use client";

import { MessageCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import AuthScreen from "@/components/auth-screen";
import PingTalkApp from "@/components/pingtalk-app";
import { authClient, type AuthUser } from "@/lib/auth-client";

type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: AuthUser }
  | { status: "error"; message: string };

export default function AppEntry() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [logoutError, setLogoutError] = useState("");

  useEffect(() => {
    let active = true;
    void authClient
      .getSession()
      .then((result) => {
        if (!active) return;
        if (result.error) {
          setAuth({
            status: "error",
            message: "Unable to check your session. Check the API connection and retry.",
          });
        } else {
          setAuth(
            result.data
              ? { status: "signed-in", user: result.data.user }
              : { status: "signed-out" },
          );
        }
      })
      .catch(() => {
        if (active) {
          setAuth({
            status: "error",
            message: "Unable to reach PingTalk. Check the API connection and retry.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    function handleUnauthorized() {
      setAuth({ status: "signed-out" });
    }
    window.addEventListener("pingtalk:unauthorized", handleUnauthorized);
    return () =>
      window.removeEventListener("pingtalk:unauthorized", handleUnauthorized);
  }, []);

  const handleAuthenticated = useCallback((user: AuthUser) => {
    setAuth({ status: "signed-in", user });
  }, []);

  const handleLogout = useCallback(async () => {
    setLogoutError("");
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setLogoutError("Unable to sign out. Please try again.");
        return;
      }
      setAuth({ status: "signed-out" });
    } catch {
      setLogoutError("Unable to reach PingTalk to sign out. Please try again.");
    }
  }, []);

  if (auth.status === "loading") {
    return (
      <main className="auth-loading auth-refined-loading" role="status" aria-label="Opening PingTalk">
        <span className="auth-brand__mark"><MessageCircle size={19} /></span>
        <span>Opening your space…</span>
      </main>
    );
  }

  if (auth.status === "signed-out") {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  if (auth.status === "error") {
    return (
      <main className="auth-loading auth-refined-loading" role="alert">
        <span>{auth.message}</span>
        <button type="button" onClick={() => window.location.reload()}>
          Retry
        </button>
      </main>
    );
  }

  return (
    <>
      {logoutError && (
        <p role="alert" className="auth-refined__error session-error-banner">
          {logoutError}
        </p>
      )}
      <PingTalkApp user={auth.user} onLogout={handleLogout} />
    </>
  );
}
