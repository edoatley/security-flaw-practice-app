import { useEffect } from "react";
import { useAuth } from "../auth/useAuth";
import { useNavigate } from "react-router-dom";

// @spec AUTH-001, AUTH-002, AUTH-003, AUTH-004, AUTH-005

const COGNITO_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN as string;
const COGNITO_CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string;
const REDIRECT_URI = import.meta.env.VITE_COGNITO_REDIRECT_URI as string;

function base64urlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = base64urlEncode(array.buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64urlEncode(digest);
  return { verifier, challenge };
}

function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return base64urlEncode(array.buffer);
}

export function LandingPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate("/game", { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  const handleSignIn = async () => {
    const { verifier, challenge } = await generatePkce();
    const state = generateState();

    sessionStorage.setItem("pkce_verifier", verifier);
    sessionStorage.setItem("oauth_state", state);

    const url = new URL(`${COGNITO_DOMAIN}/oauth2/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", COGNITO_CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", "openid email");

    window.location.href = url.toString();
  };

  if (isLoading) return null;

  return (
    <div style={{ padding: "2rem", fontFamily: "monospace" }}>
      <h1>Security Flaw Practice</h1>
      <p>Identify vulnerabilities in Java code snippets. Learn OWASP Top 10 patterns hands-on.</p>
      <button onClick={handleSignIn} style={{ marginTop: "1rem", padding: "0.5rem 1.5rem", cursor: "pointer" }}>
        Sign in to start
      </button>
    </div>
  );
}
