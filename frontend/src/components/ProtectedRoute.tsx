import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";

// @spec AUTH-031, AUTH-032, AUTH-033

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!isLoading) setChecked(true);
  }, [isLoading]);

  if (!checked) return null;
  if (!isAuthenticated) return <Navigate to="/" replace />;
  return <>{children}</>;
}
