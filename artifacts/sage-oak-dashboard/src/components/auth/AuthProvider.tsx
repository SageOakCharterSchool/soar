import { createContext, useContext, ReactNode } from "react";
import { useGetCurrentUser, getGetCurrentUserQueryKey, useLogin, useLogout } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import type { User, LoginInput } from "@workspace/api-client-react";

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (data: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: user, isLoading } = useGetCurrentUser({
    query: {
      queryKey: getGetCurrentUserQueryKey(),
      retry: false,
    },
  });

  const loginMutation = useLogin();
  const logoutMutation = useLogout();

  const login = async (data: LoginInput) => {
    await loginMutation.mutateAsync({ data });
    queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
  };

  const logout = async () => {
    await logoutMutation.mutateAsync();
    queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
    queryClient.clear(); // Clear all data on logout
  };

  const isAdmin = user?.role === "admin";

  return (
    <AuthContext.Provider value={{ user: user ?? null, isLoading, login, logout, isAdmin }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
