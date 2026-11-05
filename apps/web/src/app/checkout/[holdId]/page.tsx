import type { Metadata } from "next";
import { CheckoutPanel } from "@/features/checkout";

export const metadata: Metadata = { title: "Payment" };

export default async function CheckoutPage({ params }: { params: Promise<{ holdId: string }> }) {
  return <CheckoutPanel holdId={(await params).holdId} />;
}
