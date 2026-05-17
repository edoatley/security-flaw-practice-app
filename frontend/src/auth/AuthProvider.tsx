import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { setAccessToken, refreshTokens } from "../api/client";

// @spec AUTH-001, AUTH-002, AUTH-003, AUTH-023, AUTH-031, AUTH-055

const API_URL = import.meta.env.VITE_API_URL as string;
const COGNITO_DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN as string;
const COGNITO_CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string;

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => Promise<void>;
  onLoginSuccess: (accessToken: string, refreshToken: string, expiresIn: number) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuthContext must be used inside AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRefresh = useCallback((expiresIn: number) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const delay = Math.max((expiresIn - 300) * 1000, 10_000);
    refreshTimerRef.current = setTimeout(async () => {
      const token = await refreshTokens();
      if (token) {
        setAccessToken(token);
        scheduleRefresh(expiresIn);
      }
    }, delay);
  }, []);

  const onLoginSuccess = useCallback(
    async (accessToken: string, refreshToken: string, expiresIn: number) => {
      setAccessToken(accessToken);
      await fetch(`${API_URL}/auth/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      setIsAuthenticated(true);
      scheduleRefresh(expiresIn);
    },
    [scheduleRefresh]
  );

  const logout = useCallback(async () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    await fetch(`${API_URL}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    setAccessToken(null);
    setIsAuthenticated(false);
    const logoutUrl = new URL(`${COGNITO_DOMAIN}/logout`);
    logoutUrl.searchParams.set("client_id", COGNITO_CLIENT_ID);
    logoutUrl.searchParams.set("logout_uri", import.meta.env.VITE_COGNITO_REDIRECT_URI.replace("/auth/callback", ""));
    window.location.href = logoutUrl.toString();
  }, [scheduleRefresh]);

  useEffect(() => {
    const onExpired = () => {
      setAccessToken(null);
      setIsAuthenticated(false);
    };
    window.addEventListener("SESSION_EXPIRED", onExpired);
    return () => window.removeEventListener("SESSION_EXPIRED", onExpired);
  }, []);

  useEffect(() => {
    refreshTokens(true).then((token) => {
      if (token) {
        setIsAuthenticated(true);
        scheduleRefresh(3600);
      }
      setIsLoading(false);
    });
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [scheduleRefresh]);

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, logout, onLoginSuccess }}>
      {children}
    </AuthContext.Provider>
  );
}
