"use client";

import Link from "next/link";
import { describeError } from "@/shared/lib/api-error";
import { formatDateTime } from "@/shared/lib/format";
import { Alert } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";
import { Skeleton } from "@/shared/ui/skeleton";
import { useOrders } from "./use-orders";

export function OrdersList() {
  const orders = useOrders();
  if (orders.isPending) return <Skeleton className="h-32 w-full" aria-label="Loading your orders" />;
  if (orders.isError) {
    return (
      <Alert variant="destructive" className="flex items-center justify-between gap-3">
        <span>{describeError(orders.error)}</span>
        <Button size="sm" variant="outline" onClick={() => void orders.refetch()}>
          Try again
        </Button>
      </Alert>
    );
  }
  if (orders.data.items.length === 0) {
    return (
      <p className="py-10 text-center text-muted-foreground">
        You have no orders yet.{" "}
        <Link href="/" className="underline">
          Find an event
        </Link>
      </p>
    );
  }
  return (
    <ul className="space-y-3" data-testid="orders">
      {orders.data.items.map((order) => (
        <li key={order.id}>
          <Card>
            <CardContent className="space-y-1 pt-4">
              <p className="font-medium">
                <Link href={`/events/${order.eventId}`} className="hover:underline">
                  {order.event.title}
                </Link>
              </p>
              <p className="text-sm text-muted-foreground">
                {order.event.city} · {formatDateTime(order.event.startsAt)}
              </p>
              <p className="text-sm">Seats: {order.seats.map((seat) => `${seat.row}${seat.number}`).join(", ")}</p>
              <p className="text-xs text-muted-foreground">Ordered {formatDateTime(order.createdAt)}</p>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
