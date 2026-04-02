import {
  createContext,
  useRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  deleteJson,
  fetchJson,
  postJson,
} from "./api";

interface AuthSessionState {
  authenticated: boolean;
  role: "viewer" | "admin" | null;
  csrf_token: string | null;
  password_configured: boolean;
  read_auth_required: boolean;
}

interface AuthContextValue {
  loading: boolean;
  authenticated: boolean;
  isAdmin: boolean;
  passwordConfigured: boolean;
  csrfToken: string | null;
  loginError: string | null;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchSession(): Promise<AuthSessionState> {
  return fetchJson<AuthSessionState>("/v1/auth/session", {
    credentials: "include",
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSessionState>({
    authenticated: false,
    role: null,
    csrf_token: null,
    password_configured: false,
    read_auth_required: false,
  });
  const [loading, setLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await fetchSession();
    setSession(next);
    setLoginError(null);
  }, []);

  useEffect(() => {
    void refresh()
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [refresh]);

  const login = useCallback(async (password: string) => {
    const response = await postJson<AuthSessionState>("/v1/auth/session", { password }, {
      credentials: "include",
    });
    setSession(response);
    setLoginError(null);
  }, []);

  const logout = useCallback(async () => {
    const response = await deleteJson<AuthSessionState>("/v1/auth/session", {
      credentials: "include",
    });
    setSession(response);
    setLoginError(null);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    loading,
    authenticated: session.authenticated,
    isAdmin: !session.password_configured || session.role === "admin",
    passwordConfigured: session.password_configured,
    csrfToken: session.csrf_token,
    loginError,
    login: async (password: string) => {
      try {
        await login(password);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Login failed";
        setLoginError(message);
        throw error;
      }
    },
    logout,
    refresh,
  }), [loading, session, loginError, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthSession(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuthSession must be used within AuthProvider");
  }
  return value;
}

export function AuthStatusControl() {
  const { loading, isAdmin, passwordConfigured, login, logout } = useAuthSession();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const statusLabel = loading ? "Checking access" : !passwordConfigured ? "Auth disabled" : isAdmin ? "Admin unlocked" : "Read-only";

  useEffect(() => {
    if (open && !isAdmin) {
      passwordInputRef.current?.focus();
      passwordInputRef.current?.select();
    }
  }, [open, isAdmin]);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password.trim()) {
      return;
    }
    setSubmitting(true);
    try {
      await login(password);
      setPassword("");
      setOpen(false);
    } catch {
      setPassword("");
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusClick = () => {
    if (loading || !passwordConfigured || submitting) {
      return;
    }
    if (isAdmin) {
      void logout();
      setOpen(false);
      setPassword("");
      return;
    }
    setOpen((value) => !value);
  };

  return (
    <div className="admin-control">
      {open && !isAdmin ? null : (
        <button
          className={`admin-pill ${isAdmin ? "admin-pill-live" : "admin-pill-locked"} ${!passwordConfigured ? "admin-pill-static" : ""}`}
          disabled={loading || !passwordConfigured || submitting}
          onClick={handleStatusClick}
          type="button"
        >
          {statusLabel}
        </button>
      )}
      {open && !isAdmin ? (
        <form className="admin-login" onSubmit={handleLogin}>
          <input
            ref={passwordInputRef}
            type="password"
            placeholder="Admin password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button className="secondary-button" disabled={submitting || !password.trim()} type="submit">
            {submitting ? "Unlocking..." : "Unlock"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
