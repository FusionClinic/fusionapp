import { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeBrazilWhatsApp,
  sendEvolutionWhatsAppMessage,
} from "@/utils/evolution-whatsapp";

const APP_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://www.fusionapp.com.br";

export type RoomCheckinAvailability =
  | { canCheckIn: true; reason: "ROOM_FREE" | "PREVIOUS_CHECKED_OUT" }
  | {
      canCheckIn: false;
      reason: "PREVIOUS_IN_PROGRESS" | "PREVIOUS_RESERVED_SLOT";
      blockingBookingId: string;
      blockingStartTime: string;
      blockingEndTime: string;
      previousCheckedIn: boolean;
    };

function formatBrazilTime(isoString: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoString));
}

/**
 * Verifica se uma sala está livre para check-in ou travada por uma reserva anterior
 * de outro profissional que ainda não concluiu o check-out.
 */
export async function checkRoomCheckinAvailability(
  supabase: SupabaseClient,
  params: {
    roomId: string;
    currentBookingId: string;
    currentUserId: string;
    sessionStartIso: string;
    nowMs?: number;
  },
): Promise<RoomCheckinAvailability> {
  const nowMs = params.nowMs ?? Date.now();
  const sessionStartMs = new Date(params.sessionStartIso).getTime();

  // Busca reservas anteriores da mesma sala que terminem até 45 min antes do início
  // (ou ainda estejam abertas em atraso)
  const lookbackStartIso = new Date(
    sessionStartMs - 6 * 60 * 60 * 1000,
  ).toISOString();
  const minEndIso = new Date(sessionStartMs - 45 * 60 * 1000).toISOString();

  const { data: candidates, error } = await supabase
    .from("bookings")
    .select("id, user_id, start_time, end_time, status, checkin_time, checkout_time")
    .eq("room_id", params.roomId)
    .neq("id", params.currentBookingId)
    .neq("user_id", params.currentUserId)
    .in("status", ["confirmed", "in_progress"])
    .is("checkout_time", null)
    .gte("start_time", lookbackStartIso)
    .lt("start_time", params.sessionStartIso)
    .gte("end_time", minEndIso)
    .order("end_time", { ascending: false });

  if (error) {
    console.error("[RoomCheckinGuard] Erro ao verificar sala anterior:", error.message);
    return { canCheckIn: true, reason: "ROOM_FREE" };
  }

  if (!candidates || candidates.length === 0) {
    return { canCheckIn: true, reason: "ROOM_FREE" };
  }

  // 1) Prioridade máxima: alguém já fez check-in e ainda não deu check-out (mesmo em atraso)
  const inProgressBlocker = candidates.find(
    (b: any) => b.status === "in_progress" || Boolean(b.checkin_time),
  );

  if (inProgressBlocker) {
    return {
      canCheckIn: false,
      reason: "PREVIOUS_IN_PROGRESS",
      blockingBookingId: inProgressBlocker.id,
      blockingStartTime: inProgressBlocker.start_time,
      blockingEndTime: inProgressBlocker.end_time,
      previousCheckedIn: true,
    };
  }

  // 2) Reserva anterior confirmada sem check-in: bloqueia apenas enquanto o horário dela não acabou.
  // Se já passou do end_time e o anterior nunca apareceu (no-show), libera a sala.
  const activeSlotBlocker = candidates.find(
    (b: any) => new Date(b.end_time).getTime() > nowMs,
  );

  if (activeSlotBlocker) {
    return {
      canCheckIn: false,
      reason: "PREVIOUS_RESERVED_SLOT",
      blockingBookingId: activeSlotBlocker.id,
      blockingStartTime: activeSlotBlocker.start_time,
      blockingEndTime: activeSlotBlocker.end_time,
      previousCheckedIn: false,
    };
  }

  return { canCheckIn: true, reason: "PREVIOUS_CHECKED_OUT" };
}

/**
 * Chamado imediatamente após o check-out de um profissional.
 * Se houver um próximo profissional na janela de check-in (até 16 min antes ou já no horário)
 * aguardando a sala, dispara o WhatsApp de liberação na hora sem duplicar com o Cron.
 */
export async function notifyNextBookingRoomReady(
  supabase: SupabaseClient,
  params: {
    roomId: string;
    finishedUserId: string;
  },
): Promise<{ notified: boolean; bookingId?: string }> {
  const nowMs = Date.now();
  const minStartIso = new Date(nowMs - 30 * 60 * 1000).toISOString();
  const maxStartIso = new Date(nowMs + 16 * 60 * 1000).toISOString();

  const { data: nextBookings, error } = await supabase
    .from("bookings")
    .select(
      "id, user_id, room_id, start_time, end_time, status, checkin_time, checkout_time, contract_id, booking_origin",
    )
    .eq("room_id", params.roomId)
    .neq("user_id", params.finishedUserId)
    .eq("status", "confirmed")
    .is("checkin_time", null)
    .is("checkout_time", null)
    .is("contract_id", null)
    .gte("start_time", minStartIso)
    .lte("start_time", maxStartIso)
    .order("start_time", { ascending: true });

  if (error || !nextBookings || nextBookings.length === 0) {
    return { notified: false };
  }

  const eligible = nextBookings.filter(
    (b: any) => !String(b.booking_origin || "").startsWith("contract"),
  );

  if (eligible.length === 0) {
    return { notified: false };
  }

  const nextBooking = eligible[0];

  // Confirma que não há outra reserva bloqueando
  const availability = await checkRoomCheckinAvailability(supabase, {
    roomId: params.roomId,
    currentBookingId: nextBooking.id,
    currentUserId: nextBooking.user_id,
    sessionStartIso: nextBooking.start_time,
    nowMs,
  });

  if (!availability.canCheckIn) {
    return { notified: false };
  }

  const [profileRes, roomRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, phone, whatsapp")
      .eq("id", nextBooking.user_id)
      .single(),
    supabase
      .from("rooms")
      .select("id, name")
      .eq("id", params.roomId)
      .single(),
  ]);

  const phone = normalizeBrazilWhatsApp(
    profileRes.data?.whatsapp || profileRes.data?.phone,
  );
  if (!phone || !roomRes.data) {
    return { notified: false };
  }

  // Usa o MESMO event_type do Cron ("reminder_15m_checkin_ready") para garantir 0 duplicidade
  const { error: lockErr } = await supabase
    .from("whatsapp_notification_logs")
    .insert({
      booking_id: nextBooking.id,
      event_type: "reminder_15m_checkin_ready",
      phone,
    });

  if (lockErr) {
    // 23505 = já foi enviado anteriormente (pelo Cron ou por outra chamada)
    if (lockErr.code !== "23505") {
      console.error("[RoomCheckinGuard] Erro ao travar log de liberação:", lockErr.message);
    }
    return { notified: false };
  }

  const firstName =
    String(profileRes.data?.full_name || "Doutor(a)")
      .trim()
      .split(" ")[0] || "Doutor(a)";
  const roomName = roomRes.data.name || "Consultório Fusion";
  const shortRoomCode = String(params.roomId).slice(0, 6);
  const doorLink = `${APP_URL}/dashboard?scan=${shortRoomCode}`;
  const startFmt = formatBrazilTime(nextBooking.start_time);

  const text = [
    `✅ *Sala liberada! Check-in disponível — Fusion Clinic*`,
    ``,
    `Olá, *${firstName}*! O atendimento anterior na *${roomName}* acabou de ser encerrado e a sala já está livre para o seu horário das *${startFmt}*.`,
    ``,
    `📲 *Faça seu Check-in agora:*`,
    `${doorLink}`,
    ``,
    `Você também pode encostar o celular na *Tag NFC / QR Code* da porta ao entrar.`,
  ].join("\n");

  const result = await sendEvolutionWhatsAppMessage({
    phone,
    text,
    delayMs: 800,
  });

  if (!result.success) {
    await supabase
      .from("whatsapp_notification_logs")
      .delete()
      .eq("booking_id", nextBooking.id)
      .eq("event_type", "reminder_15m_checkin_ready");
    return { notified: false };
  }

  return { notified: true, bookingId: nextBooking.id };
}