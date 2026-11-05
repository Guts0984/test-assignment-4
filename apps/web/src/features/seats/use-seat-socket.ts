"use client";

import { SOCKET_EVENTS, seatMapSchema, seatsChangedSchema, type SeatMap, type SeatsChanged } from "@app/shared";
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

export type LiveStatus = "connecting" | "live" | "offline";

type Handlers = {
  /** The whole current map: sent when the page connects and again after EVERY reconnect. */
  onSnapshot: (map: SeatMap, changesReceivedMeanwhile: SeatsChanged["changes"]) => void;
  onChanges: (changes: SeatsChanged["changes"]) => void;
};

/**
 * Keeps one hall in sync over Socket.IO (WebSocket only; the address is relative, nginx forwards /socket.io to the api).
 * On every connect - the first one and each automatic reconnect - it asks for the whole map again, so whatever happened
 * while the connection was down is picked up. Changes that arrive while that answer is on its way are kept and applied
 * on top of it, because they may be newer than the map.
 */
export function useSeatSocket(eventId: number, handlers: Handlers): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const socket = io({ path: "/socket.io", transports: ["websocket"], withCredentials: true, reconnectionDelay: 500, reconnectionDelayMax: 5000 });
    let waitingForSnapshot = false;
    let buffered: SeatsChanged["changes"] = [];

    const subscribe = () => {
      waitingForSnapshot = true;
      buffered = [];
      socket.emit(SOCKET_EVENTS.watch, { eventId }, (reply: unknown) => {
        const ack = reply as { ok?: boolean; map?: unknown } | null;
        const map = ack?.ok ? seatMapSchema.safeParse(ack.map) : null;
        const meanwhile = buffered;
        waitingForSnapshot = false;
        buffered = [];
        if (map?.success) {
          latest.current.onSnapshot(map.data, meanwhile);
          setStatus("live");
        }
      });
    };
    socket.on("connect", subscribe);
    socket.on("disconnect", () => setStatus("offline"));
    socket.on("connect_error", () => setStatus("offline"));
    socket.on(SOCKET_EVENTS.seatsChanged, (raw: unknown) => {
      const message = seatsChangedSchema.safeParse(raw);
      if (!message.success || message.data.eventId !== eventId) return;
      if (waitingForSnapshot) buffered = [...buffered, ...message.data.changes];
      latest.current.onChanges(message.data.changes);
    });
    return () => {
      socket.emit(SOCKET_EVENTS.unwatch, { eventId });
      socket.disconnect();
    };
  }, [eventId]);

  return status;
}
