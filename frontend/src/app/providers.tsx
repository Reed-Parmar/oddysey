import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { ApiError } from "@/api/errors";
import { AuthProvider } from "@/auth/AuthProvider";
import { Toaster } from "@/components/shared/Toaster";

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // one retry after 2 s on network errors only; never on 4xx (frontend.md §5)
        retry: (count, err) => count < 1 && err instanceof ApiError && (err.status === 0 || err.status >= 500),
        retryDelay: 2000,
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Toaster>{children}</Toaster>
      </AuthProvider>
    </QueryClientProvider>
  );
}
