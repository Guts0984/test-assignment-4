"use client";

import type { HoldDto, OrderDto, OrderList } from "@app/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { describeError, isApiError } from "@/shared/lib/api-error";
import { apiRequest } from "@/shared/lib/client-api";
import { formatCountdown, formatDateTime } from "@/shared/lib/format";
import { queryKeys } from "@/shared/lib/query-keys";
import { Alert } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { Skeleton } from "@/shared/ui/skeleton";

// The clock, as something React can subscribe to: it ticks once a second, and the server's answer is "unknown" (null), so the
// server and the browser never disagree about the time during hydration.
const subscribeToClock = (onTick: () => void): (() => void) => {
  const timer = setInterval(onTick, 1000);
  return () => clearInterval(timer);
};
const readClock = (): number => Math.floor(Date.now() / 1000) * 1000;
const clockOnServer = (): null => null;

/** Seconds left until `expiresAt`; null while the page is not yet in the browser. */
function useSecondsLeft(expiresAt: string | undefined): number | null {
  const now = useSyncExternalStore<number | null>(subscribeToClock, readClock, clockOnServer);
  if (!expiresAt || now === null) return null;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

export function CheckoutPanel({ holdId }: { holdId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const holdKey = queryKeys.hold(holdId);
  const [message, setMessage] = useState<string | null>(null);

  const query = useQuery({
    queryKey: holdKey,
    queryFn: async ({ signal }) => (await apiRequest<{ hold: HoldDto }>(`/holds/${holdId}`, { signal })).hold,
    retry: false,
  });
  const hold = query.data;
  const secondsLeft = useSecondsLeft(hold?.expiresAt);
  const active = hold?.status === "active" && (secondsLeft === null || secondsLeft > 0);

  // After the time is up the seats are free for everybody: refresh what this page and the hall show.
  useEffect(() => {
    if (hold && secondsLeft === 0 && hold.status === "active") {
      void queryClient.invalidateQueries({ queryKey: holdKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.seats(hold.eventId) });
    }
  }, [hold, holdKey, queryClient, secondsLeft]);

  const pay = useMutation({
    mutationFn: () => apiRequest<{ order: OrderDto }>(`/holds/${holdId}/pay`, { method: "POST" }),
    // The orders counter in the header goes up at once ...
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.orders });
      const previous = queryClient.getQueryData<OrderList>(queryKeys.orders);
      if (previous && hold) {
        const placeholder: OrderDto = { id: `pending-${holdId}`, eventId: hold.eventId, event: hold.event, seats: hold.seats, createdAt: new Date().toISOString() };
        queryClient.setQueryData<OrderList>(queryKeys.orders, { items: [placeholder, ...previous.items] });
      }
      return { previous };
    },
    // ... and goes back if the payment fails.
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.orders, context.previous);
      setMessage(isApiError(error) && (error.code === "BOOKING_EXPIRED" || error.code === "BOOKING_CANCELLED") ? error.message : describeError(error));
      void queryClient.invalidateQueries({ queryKey: holdKey });
    },
    onSuccess: () => {
      // After a purchase: the hall, the orders list (and so the header counter) and this booking are all refreshed.
      if (hold) void queryClient.invalidateQueries({ queryKey: queryKeys.seats(hold.eventId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
      void queryClient.invalidateQueries({ queryKey: holdKey });
      router.push("/me/orders");
    },
  });

  const cancel = useMutation({
    mutationFn: () => apiRequest<void>(`/holds/${holdId}`, { method: "DELETE" }),
    // The booking looks cancelled at once; it is put back if the server refuses.
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: holdKey });
      const previous = queryClient.getQueryData<HoldDto>(holdKey);
      if (previous) queryClient.setQueryData<HoldDto>(holdKey, { ...previous, status: "cancelled" });
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(holdKey, context.previous);
      setMessage(describeError(error));
    },
    onSuccess: () => {
      if (hold) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.seats(hold.eventId) });
        router.push(`/events/${hold.eventId}/seats`);
      }
    },
  });

  if (query.isPending) return <Skeleton className="h-64 w-full" aria-label="Loading your booking" />;
  if (query.isError || !hold) {
    const notFound = isApiError(query.error) && query.error.status === 404;
    return (
      <Alert variant="destructive">
        {notFound ? "This booking does not exist." : describeError(query.error)}{" "}
        <Link href="/" className="underline">
          Back to events
        </Link>
      </Alert>
    );
  }

  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader>
        <CardTitle className="text-xl">Your booking</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="font-medium" data-testid="checkout-event">
            {hold.event.title}
          </p>
          <p className="text-sm text-muted-foreground">
            {hold.event.city} · {formatDateTime(hold.event.startsAt)}
          </p>
        </div>
        <p data-testid="checkout-seats">Seats: {hold.seats.map((seat) => `${seat.row}${seat.number}`).join(", ")}</p>

        {hold.status === "active" && secondsLeft !== 0 && (
          <p className="text-lg" role="timer" aria-live="off" data-testid="checkout-timer">
            Time left to pay: <span className="font-mono font-semibold">{secondsLeft === null ? "--:--" : formatCountdown(secondsLeft)}</span>
          </p>
        )}
        {(hold.status === "expired" || (hold.status === "active" && secondsLeft === 0)) && <Alert variant="destructive">The time ran out and the seats were released. You can choose them again.</Alert>}
        {hold.status === "cancelled" && <Alert>This booking was cancelled.</Alert>}
        {hold.status === "paid" && <Alert>Paid. Thank you!</Alert>}
        {message && <Alert variant="destructive">{message}</Alert>}

        <div className="flex flex-wrap gap-2">
          {active && (
            <>
              <Button onClick={() => (setMessage(null), pay.mutate())} disabled={pay.isPending || cancel.isPending} data-testid="pay-button">
                {pay.isPending ? "Paying…" : "Pay"}
              </Button>
              <Button variant="outline" onClick={() => (setMessage(null), cancel.mutate())} disabled={pay.isPending || cancel.isPending} data-testid="cancel-button">
                Cancel
              </Button>
            </>
          )}
          {!active && (
            <Button asChild variant="outline">
              <Link href={`/events/${hold.eventId}/seats`}>Choose seats again</Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
