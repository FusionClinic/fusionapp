"use server";

import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient as createServerSupabase } from "@/utils/supabase/server";
import {
  checkRoomCheckinAvailability,
  notifyNextBookingRoomReady,
} from "@/utils/room-checkin-guard";
import { sendCheckoutReceiptEmail } from "@/app/actions/send-email";

const supabaseAdmin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

export interface BookingCheckinStatus {
  canCheckIn: boolean;
  reason: string;
  blockingEndTime?: string;
}

export async function getRoomCheckinAvailabilityMap(
  items: { id: string; room_id: string; start_time: string }[],
): Promise<Record<string, BookingCheckinStatus>> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !items || items.length === 0) return {};

  const nowMs = Date.now();
  const entries = await Promise.all(
    items.map(async (item) => {
      const result = await checkRoomCheckinAvailability(supabaseAdmin, {
        roomId: item.room_id,
        currentBookingId: item.id,
        currentUserId: user.id,
        sessionStartIso: item.start_time,
        nowMs,
      });

      if (result.canCheckIn) {
        return [
          item.id,
          { canCheckIn: true, reason: result.reason },
        ] as const;
      }

      return [
        item.id,
        {
          canCheckIn: false,
          reason: result.reason,
          blockingEndTime: result.blockingEndTime,
        },
      ] as const;
    }),
  );

  return Object.fromEntries(entries);
}

export async function performRoomCheckinAction(params: {
  bookingIds: string[];
  roomId: string;
}) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      success: false as const,
      code: "UNAUTHORIZED" as const,
      message: "Sessão expirada. Faça login novamente.",
    };
  }

  const cleanIds = Array.from(new Set(params.bookingIds.filter(Boolean)));
  if (cleanIds.length === 0) {
    return {
      success: false as const,
      code: "NOT_FOUND" as const,
      message: "Reserva não informada.",
    };
  }

  const { data: bookingsList, error: fetchError } = await supabaseAdmin
    .from("bookings")
    .select("id, user_id, room_id, start_time, end_time, status")
    .in("id", cleanIds)
    .eq("user_id", user.id)
    .order("start_time", { ascending: true });

  if (fetchError || !bookingsList || bookingsList.length === 0) {
    return {
      success: false as const,
      code: "NOT_FOUND" as const,
      message: "Reserva não localizada na sua conta.",
    };
  }

  const firstBooking = bookingsList[0];
  const lastBooking = bookingsList[bookingsList.length - 1];
  const nowMs = Date.now();
  const startMs = new Date(firstBooking.start_time).getTime();
  const endMs = new Date(lastBooking.end_time).getTime();

  if (nowMs >= endMs) {
    return {
      success: false as const,
      code: "EXPIRED" as const,
      message: "O horário desta reserva já foi encerrado.",
    };
  }

  const earlyWindowMs = 15 * 60 * 1000;
  if (nowMs < startMs - earlyWindowMs) {
    return {
      success: false as const,
      code: "TOO_EARLY" as const,
      message:
        "O check-in libera com até 15 minutos de antecedência quando a sala estiver livre.",
    };
  }

  const availability = await checkRoomCheckinAvailability(supabaseAdmin, {
    roomId: firstBooking.room_id,
    currentBookingId: firstBooking.id,
    currentUserId: user.id,
    sessionStartIso: firstBooking.start_time,
    nowMs,
  });

  if (!availability.canCheckIn) {
    return {
      success: false as const,
      code: "ROOM_OCCUPIED" as const,
      blockingEndTime: availability.blockingEndTime,
      message:
        "A sala está em atendimento anterior. Seu check-in será liberado automaticamente assim que o profissional anterior fizer o check-out.",
    };
  }

  const checkinTime = new Date(nowMs).toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("bookings")
    .update({ status: "in_progress", checkin_time: checkinTime })
    .in("id", cleanIds)
    .eq("user_id", user.id);

  if (updateError) {
    return {
      success: false as const,
      code: "UPDATE_ERROR" as const,
      message: updateError.message,
    };
  }

  return {
    success: true as const,
    checkinTime,
  };
}

export async function performRoomCheckoutAction(params: {
  bookingIds: string[];
  roomId: string;
}) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      success: false as const,
      message: "Sessão expirada. Faça login novamente.",
    };
  }

  const cleanIds = Array.from(new Set(params.bookingIds.filter(Boolean)));
  if (cleanIds.length === 0) {
    return {
      success: false as const,
      message: "Reserva não informada.",
    };
  }

  const { data: bookingsList, error: fetchError } = await supabaseAdmin
    .from("bookings")
    .select(
      "id, user_id, room_id, start_time, end_time, status, total_cost, agreed_value_brl, rooms(address_details)",
    )
    .in("id", cleanIds)
    .eq("user_id", user.id)
    .order("end_time", { ascending: true });

  if (fetchError || !bookingsList || bookingsList.length === 0) {
    return {
      success: false as const,
      message: "Reserva não localizada na sua conta.",
    };
  }

  const lastBooking: any = bookingsList[bookingsList.length - 1];
  const nowMs = Date.now();
  const endMs = new Date(lastBooking.end_time).getTime();

  let penaltyStatus: "none" | "warning" | "fined" = "none";
  let penaltyAmount = 0;

  if (nowMs >= endMs + 60 * 1000) {
    penaltyStatus = "fined";
    const roomData = Array.isArray(lastBooking.rooms)
      ? lastBooking.rooms[0]
      : lastBooking.rooms;
    let address: any = roomData?.address_details || {};
    if (typeof address === "string") {
      try {
        address = JSON.parse(address);
      } catch {
        address = {};
      }
    }
    const hourlyFallback = Number(address?.pricing?.hourly || 45);
    if (
      lastBooking.agreed_value_brl &&
      Number(lastBooking.agreed_value_brl) > 0
    ) {
      penaltyAmount = Number(lastBooking.agreed_value_brl);
    } else if (Number(lastBooking.total_cost || 0) >= 10) {
      penaltyAmount = Number(lastBooking.total_cost);
    } else {
      penaltyAmount = hourlyFallback;
    }
  } else if (nowMs >= endMs - 10 * 60 * 1000) {
    penaltyStatus = "warning";
  }

  const checkoutTime = new Date(nowMs).toISOString();

  const { error: updateError } = await supabaseAdmin
    .from("bookings")
    .update({
      status: "completed",
      checkout_time: checkoutTime,
      penalty_status: penaltyStatus,
      penalty_amount: penaltyAmount,
    })
    .in("id", cleanIds)
    .eq("user_id", user.id);

  if (updateError) {
    return {
      success: false as const,
      message: updateError.message,
    };
  }

  const [, nextNotifyRes] = await Promise.allSettled([
    sendCheckoutReceiptEmail(cleanIds),
    notifyNextBookingRoomReady(supabaseAdmin, {
      roomId: lastBooking.room_id || params.roomId,
      finishedUserId: user.id,
    }),
  ]);

  const nextNotified =
    nextNotifyRes.status === "fulfilled"
      ? nextNotifyRes.value.notified
      : false;

  return {
    success: true as const,
    checkoutTime,
    penaltyStatus,
    penaltyAmount,
    nextNotified,
  };
}