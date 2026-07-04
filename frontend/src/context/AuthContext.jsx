import { createContext, useContext, useEffect, useState } from "react";
import { getMe } from "../api/client.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("cpc_token");
    if (!token) {
      setLoading(false);
      return;
    }
    getMe()
      .then((data) => setUser(data.user))
      .catch(() => localStorage.removeItem("cpc_token"))
      .finally(() => setLoading(false));
  }, []);

  const signIn = (token, userData) => {
    localStorage.setItem("cpc_token", token);
    setUser(userData);
  };

  const signOut = () => {
    localStorage.removeItem("cpc_token");
    setUser(null);
    window.location.href = "/login";
  };

  const patchPreferences = (preferences) => {
    setUser((curr) => {
      if (!curr) return curr;
      return {
        ...curr,
        preferences: {
          ...(curr.preferences || {}),
          ...(preferences || {}),
        },
      };
    });
  };

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, patchPreferences, isAdmin: user?.role === "admin" }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
