"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiRequest } from "@/shared/lib/client-api";
import { queryKeys } from "@/shared/lib/query-keys";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { useOrders } from "@/features/orders";
import { useMe } from "./use-me";

/** Right side of the header: login links for a visitor; email, orders counter and "Log out" for a user. */
export function UserMenu() {
  const me = useMe();
  const user = me.data;
  const orders = useOrders(Boolean(user));
  const router = useRouter();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => apiRequest<void>("/auth/logout", { method: "POST" }),
    onSettled: () => {
      // Whatever the answer, this browser forgets everything private at once.
      queryClient.setQueryData(queryKeys.me, null);
      queryClient.removeQueries({ queryKey: queryKeys.orders });
      queryClient.removeQueries({ queryKey: ["hold"] });
      router.replace("/");
      router.refresh();
    },
  });

  if (me.isPending) return <div aria-hidden className="h-8 w-40 animate-pulse rounded-md bg-muted" />;
  if (!user) {
    return (
      <nav aria-label="Account" className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/login">Log in</Link>
        </Button>
        <Button asChild size="sm">
          <Link href="/register">Register</Link>
        </Button>
      </nav>
    );
  }
  const count = orders.data?.items.length;
  return (
    <nav aria-label="Account" className="flex items-center gap-2">
      {user.role === "admin" && <Badge variant="secondary">admin</Badge>}
      <Button asChild variant="ghost" size="sm">
        <Link href="/me/orders" aria-label={count === undefined ? "My orders" : `My orders, ${count}`}>
          My orders
          <Badge data-testid="orders-count" variant="outline" className="ml-1.5">
            {count ?? "…"}
          </Badge>
        </Link>
      </Button>
      <span className="hidden text-sm text-muted-foreground sm:inline" data-testid="user-email">
        {user.email}
      </span>
      <Button variant="outline" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
        Log out
      </Button>
    </nav>
  );
}
