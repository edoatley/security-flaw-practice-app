import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import type { AuthTokens } from "../types";

// @spec AUTH-006, AUTH-007, AUTH-008, AUTH-009, AUTH-010, AUTH-011, AUTH-012

const COGNITO_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN as string;
const COGNITO_CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string;
const REDIRECT_URI = import.meta.env.VITE_COGNITO_REDIRECT_URI as string;

export function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { onLoginSuccess } = useAuth();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const error = searchParams.get("error");
    if (error) {
      setErrorMsg(`Login failed: ${searchParams.get("error_description") ?? error}`);
      return;
    }

    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const savedState = sessionStorage.getItem("oauth_state");
    const verifier = sessionStorage.getItem("pkce_verifier");

    if (!code || state !== savedState || !verifier) {
      navigate("/", { replace: true });
      return;
    }

    sessionStorage.removeItem("oauth_state");
    sessionStorage.removeItem("pkce_verifier");

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: COGNITO_CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });

    fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    })
      .then((res) => {
        if (!res.ok) throw new Error("Token exchange failed");
        return res.json() as Promise<AuthTokens>;
      })
      .then(async (tokens) => {
        if (!tokens.refresh_token) throw new Error("No refresh token in response");
        await onLoginSuccess(tokens.access_token, tokens.refresh_token, tokens.expires_in);
        navigate("/game", { replace: true });
      })
      .catch((err: Error) => {
        setErrorMsg(err.message ?? "Authentication failed");
      });
  }, []);

  if (errorMsg) {
    return (
      <div style={{ padding: "2rem", fontFamily: "monospace" }}>
        <p style={{ color: "red" }}>{errorMsg}</p>
        <a href="/">Try again</a>
      </div>
    );
  }

  return (
    <div style={{ padding: "2rem", fontFamily: "monospace" }}>
      <p>Completing sign in…</p>
    </div>
  );
}
