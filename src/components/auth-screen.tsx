"use client";

import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { FormEvent, useState } from "react";
import { authClient, type AuthUser } from "@/lib/auth-client";

type AuthMode = "login" | "signup";

export default function AuthScreen({
  onAuthenticated,
}: {
  onAuthenticated: (user: AuthUser) => void;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isSignup = mode === "signup";
  const passwordsMismatch =
    isSignup && confirmPassword.length > 0 && password !== confirmPassword;

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError("");
    setPassword("");
    setConfirmPassword("");
    setPasswordVisible(false);
    setConfirmVisible(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (isSignup && name.trim().length < 2) {
      setError("Enter your full name.");
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }

    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }

    if (isSignup && password !== confirmPassword) {
      setError("Passwords don’t match.");
      return;
    }

    setLoading(true);
    try {
      if (isSignup) {
        const result = await authClient.signUp.email({
          name: name.trim(),
          email: email.trim(),
          password,
        });
        if (result.error) {
          setError(result.error.message || "We couldn’t create your account.");
          return;
        }
        onAuthenticated(result.data.user);
      } else {
        const result = await authClient.signIn.email({
          email: email.trim(),
          password,
          rememberMe: remember,
        });
        if (result.error) {
          setError(result.error.message || "Email or password is incorrect.");
          return;
        }
        onAuthenticated(result.data.user);
      }
    } catch {
      setError("Unable to reach PingTalk. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page auth-refined">
      <section
        className="auth-form-side auth-refined__side"
        aria-label={isSignup ? "Create your account" : "Sign in"}
      >
        <div className="auth-form-wrap auth-refined__panel">
          <div className="auth-brand auth-refined__brand" aria-label="PingTalk">
            <span className="auth-brand__mark auth-refined__mark">
              <svg
                className="auth-refined__orbit"
                viewBox="0 0 48 48"
                aria-hidden="true"
              >
                <circle
                  className="auth-refined__orbit-path"
                  cx="24"
                  cy="24"
                  r="17"
                />
                <g className="auth-refined__orbit-points">
                  <circle cx="24" cy="7" r="2" />
                  <circle cx="38.7" cy="32.5" r="1.7" />
                  <circle cx="9.3" cy="32.5" r="1.7" />
                </g>
                <path
                  className="auth-refined__chat-mark"
                  d="M16 17.5a3.5 3.5 0 0 1 3.5-3.5h9a3.5 3.5 0 0 1 3.5 3.5v7a3.5 3.5 0 0 1-3.5 3.5h-4.7l-4.6 3.4v-3.7a3.5 3.5 0 0 1-3.2-3.5z"
                />
                <circle className="auth-refined__chat-dot" cx="21" cy="21" r="1.15" />
                <circle className="auth-refined__chat-dot" cx="24" cy="21" r="1.15" />
                <circle className="auth-refined__chat-dot" cx="27" cy="21" r="1.15" />
              </svg>
            </span>
            <span>pingtalk</span>
          </div>

          <div className="auth-refined__content" key={mode}>
            <header
              className="auth-heading auth-refined__heading"
              aria-live="polite"
            >
              <h1>{isSignup ? "Create your account" : "Welcome back"}</h1>
              {!isSignup && <p>Your conversations are waiting.</p>}
            </header>

            <form
              className="auth-form auth-refined__form"
              onSubmit={submit}
              noValidate
            >
            {isSignup && (
              <label className="auth-field auth-refined__field">
                <span>Full name</span>
                <input
                  type="text"
                  name="name"
                  autoComplete="name"
                  placeholder="Your name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setError("");
                  }}
                  minLength={2}
                  required
                />
              </label>
            )}

            <label className="auth-field auth-refined__field">
              <span>Email address</span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setError("");
                }}
                required
              />
            </label>

            <div className="auth-field auth-refined__field">
              <label htmlFor="auth-password">Password</label>
              <span className="auth-refined__password">
                <input
                  id="auth-password"
                  type={passwordVisible ? "text" : "password"}
                  name="password"
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  placeholder={isSignup ? "At least 8 characters" : "Your password"}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError("");
                  }}
                  minLength={8}
                  required
                />
                <button
                  className="auth-password-toggle auth-refined__toggle"
                  type="button"
                  onClick={() => setPasswordVisible((visible) => !visible)}
                  aria-label={passwordVisible ? "Hide password" : "Show password"}
                  aria-pressed={passwordVisible}
                >
                  {passwordVisible ? (
                    <EyeOff size={17} aria-hidden="true" />
                  ) : (
                    <Eye size={17} aria-hidden="true" />
                  )}
                </button>
              </span>
            </div>

            {isSignup ? (
              <div className="auth-field auth-refined__field">
                <label htmlFor="auth-confirm-password">Confirm password</label>
                <span
                  className={`auth-refined__password ${passwordsMismatch ? "has-error" : ""}`}
                >
                  <input
                    id="auth-confirm-password"
                    type={confirmVisible ? "text" : "password"}
                    name="confirm-password"
                    autoComplete="new-password"
                    placeholder="Enter your password again"
                    value={confirmPassword}
                    onChange={(event) => {
                      setConfirmPassword(event.target.value);
                      setError("");
                    }}
                    required
                    aria-invalid={passwordsMismatch}
                    aria-describedby={
                      passwordsMismatch && !error
                        ? "confirm-password-error"
                        : undefined
                    }
                  />
                  <button
                    className="auth-password-toggle auth-refined__toggle"
                    type="button"
                    onClick={() => setConfirmVisible((visible) => !visible)}
                    aria-label={
                      confirmVisible
                        ? "Hide confirmation password"
                        : "Show confirmation password"
                    }
                    aria-pressed={confirmVisible}
                  >
                    {confirmVisible ? (
                      <EyeOff size={17} aria-hidden="true" />
                    ) : (
                      <Eye size={17} aria-hidden="true" />
                    )}
                  </button>
                </span>
                {passwordsMismatch && !error && (
                  <span
                    className="auth-field-error auth-refined__field-error"
                    id="confirm-password-error"
                  >
                    Passwords don’t match.
                  </span>
                )}
              </div>
            ) : (
              <label className="auth-checkbox auth-refined__remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                <span className="auth-checkbox__box">
                  <span aria-hidden="true">✓</span>
                </span>
                Remember me
              </label>
            )}

            {error && (
              <p className="auth-error auth-refined__error" role="alert">
                {error}
              </p>
            )}

            <button
              className={`auth-submit auth-refined__submit ${loading ? "is-loading" : ""}`}
              type="submit"
              disabled={loading}
            >
              {loading ? (
                <>
                  <span className="auth-spinner" aria-hidden="true" />
                  {isSignup ? "Creating account…" : "Signing in…"}
                </>
              ) : (
                <>
                  {isSignup ? "Create account" : "Sign in"}
                  <ArrowRight size={17} aria-hidden="true" />
                </>
              )}
            </button>
            </form>

          </div>
          <p className="auth-switch-prompt auth-refined__switch">
            {isSignup ? "Already have an account?" : "New to PingTalk?"}{" "}
            <button
              type="button"
              onClick={() => switchMode(isSignup ? "login" : "signup")}
            >
              {isSignup ? "Sign in" : "Create account"}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}
