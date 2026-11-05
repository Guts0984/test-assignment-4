import type { Metadata } from "next";
import { OrdersList } from "@/features/orders";

export const metadata: Metadata = { title: "My orders" };

export default function OrdersPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">My orders</h1>
      <OrdersList />
    </div>
  );
}
