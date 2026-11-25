import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkRoomCheckinAvailability } from "@/utils/room-checkin-guard";

export const dynamic = "force-dynamic";

const APP_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://www.fusionapp.com.br";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

function formatBrazilTime(isoOrDate: string | Date): string {
  const date = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function isAuthorized(request: Request): boolean {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return true;

  const authHeader = request.headers.get("authorization") || "";
  if (authHeader === `Bearer ${secret}`) return true;

  const { searchParams } = new URL(request.url);
  if (searchParams.get("secret") === secret) return true;

  return false;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  }

  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const sixteenMinsFromNow = new Date(nowMs + 16 * 60000).toISOString();

    const { data: checkinBookings } = await supabase
      .from("bookings")
      .select("id, user_id, room_id, start_time, end_time, rooms(name)")
      .eq("status", "confirmed")
      .is("contract_id", null)
      .eq("notified_checkin", false)
      .lte("start_time", sixteenMinsFromNow)
      .gte("end_time", nowIso);

    if (checkinBookings && checkinBookings.length > 0) {
      for (const booking of checkinBookings) {
        const availability = await checkRoomCheckinAvailability(supabase, {
          roomId: booking.room_id,
          currentBookingId: booking.id,
          currentUserId: booking.user_id,
          sessionStartIso: booking.start_time,
          nowMs,
        });

        if (!availability.canCheckIn) continue;

        const roomData = booking.rooms as any;
        const roomName = Array.isArray(roomData)
          ? roomData[0]?.name
          : roomData?.name;

        await fetch(`${APP_URL}/api/push`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: booking.user_id,
            title: "Sala livre! Check-in liberado 🔓",
            body: `A ${roomName} já está pronta para seu atendimento. Faça seu check-in agora!`,
            url: "/dashboard#bookings",
          }),
        }).catch((err) => console.error(err));

        await supabase
          .from("bookings")
          .update({ notified_checkin: true })
          .eq("id", booking.id);
      }
    }

    const { data: activeBookings } = await supabase
      .from("bookings")
      .select(
        "id, user_id, room_id, start_time, end_time, rooms(name), notified_checkout_45min, notified_checkout_warning",
      )
      .eq("status", "in_progress")
      .is("contract_id", null)
      .order("start_time", { ascending: true });

    if (activeBookings && activeBookings.length > 0) {
      const byUserRoom = new Map<string, any[]>();
      for (const b of activeBookings) {
        const key = `${b.user_id}_${b.room_id}`;
        const list = byUserRoom.get(key) || [];
        list.push(b);
        byUserRoom.set(key, list);
      }

      for (const [, list] of byUserRoom.entries()) {
        const lastBooking = list[list.length - 1];
        const endMs = new Date(lastBooking.end_time).getTime();
        const minsUntilEnd = (endMs - nowMs) / 60000;
        const endFmt = formatBrazilTime(lastBooking.end_time);
        const fineStartFmt = formatBrazilTime(new Date(endMs + 60 * 1000));

        const roomData = lastBooking.rooms as any;
        const roomName = Array.isArray(roomData)
          ? roomData[0]?.name
          : roomData?.name;

        if (
          minsUntilEnd <= 11.5 &&
          minsUntilEnd > 5.5 &&
          !lastBooking.notified_checkout_45min
        ) {
          await fetch(`${APP_URL}/api/push`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: lastBooking.user_id,
              title: "Faltam 10 minutos para encerrar ⏳",
              body: `Seu horário na ${roomName} termina às ${endFmt}. Prepare-se para finalizar e fazer o check-out.`,
              url: "/dashboard#bookings",
            }),
          }).catch((err) => console.error(err));

          await supabase
            .from("bookings")
            .update({ notified_checkout_45min: true })
            .in(
              "id",
              list.map((b: any) => b.id),
            );
        }

        if (minsUntilEnd <= 5.5 && !lastBooking.notified_checkout_warning) {
          await fetch(`${APP_URL}/api/push`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: lastBooking.user_id,
              title: "Últimos minutos — Faça seu Check-out ⚠️",
              body: `Tolerância máxima na ${roomName} até ${endFmt}. A partir das ${fineStartFmt} sem check-out há cobrança de multa.`,
              url: "/dashboard#bookings",
            }),
          }).catch((err) => console.error(err));

          await supabase
            .from("bookings")
            .update({ notified_checkout_warning: true })
            .in(
              "id",
              list.map((b: any) => b.id),
            );
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: "Varredura do Cron finalizada",
    });
  } catch (error: any) {
    console.error("Erro no Cron Job:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}