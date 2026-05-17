import { useAuth } from "../auth/useAuth";

export function GamePage() {
  const { logout } = useAuth();

  return (
    <div style={{ padding: "2rem", fontFamily: "monospace" }}>
      <h1>Game</h1>
      <p>Authenticated! Game coming soon.</p>
      <button onClick={logout} style={{ marginTop: "1rem", cursor: "pointer" }}>
        Sign out
      </button>
    </div>
  );
}
