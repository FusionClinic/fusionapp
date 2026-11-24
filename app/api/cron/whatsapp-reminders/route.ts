import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import {
  normalizeBrazilWhatsApp,
  sendEvolutionWhatsAppMessage,
} from "@/utils/evolution-whatsapp";

export const dynamic = "force-dynamic";

const APP_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://fusionapp.com.br";

const supabaseAdmin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

interface SessionBucket {
  userId: string;
  roomId: string;
  bookings: any[];
  startTime: string;
  endTime: string;
  hoursCount: number;
}

function formatBrazilTime(isoString: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoString));
}

function groupUserRoomBookingsIntoSessions(bookings: any[]): SessionBucket[] {
  const byUserRoom = new Map<string, any[]>();

  for (const b of bookings) {
    if (!b.user_id || !b.room_id) continue;
    const key = `${b.user_id}_${b.room_id}`;
    const list = byUserRoom.get(key) || [];
    list.push(b);
    byUserRoom.set(key, list);
  }

  const sessions: SessionBucket[] = [];
  const MAX_CONTIGUOUS_GAP_MS = 15 * 60 * 1000;

  for (const [, userRoomList] of byUserRoom.entries()) {
    const sorted = [...userRoomList].sort(
      (a, b) =>
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    );

    const groups: any[][] = [];
    for (const item of sorted) {
      if (groups.length === 0) {
        groups.push([item]);
        continue;
      }
      const current = groups[groups.length - 1];
      const prev = current[current.length - 1];
      const gapMs =
        new Date(item.start_time).getTime() - new Date(prev.end_time).getTime();

      if (gapMs <= MAX_CONTIGUOUS_GAP_MS && gapMs >= -5 * 60 * 1000) {
        current.push(item);
      } else {
        groups.push([item]);
      }
    }

    for (const group of groups) {
      const first = group[0];
      const last = group[group.length - 1];
      sessions.push({
        userId: first.user_id,
        roomId: first.room_id,
        bookings: group,
        startTime: first.start_time,
        endTime: last.end_time,
        hoursCount: group.length,
      });
    }
  }

  return sessions;
}

async function claimNotificationLock(
  bookingId: string,
  eventType: string,
  phone: string,
): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("whatsapp_notification_logs")
    .insert({
      booking_id: bookingId,
      event_type: eventType,
      phone,
    });

  if (error) {
    if (error.code === "23505") {
      return false;
    }
    console.error(
      `[Cron WhatsApp] Erro ao travar log (${eventType} / ${bookingId}):`,
      error.message,
    );
    return false;
  }

  return true;
}

async function releaseNotificationLock(bookingId: string, eventType: string) {
  await supabaseAdmin
    .from("whatsapp_notification_logs")
    .delete()
    .eq("booking_id", bookingId)
    .eq("event_type", eventType);
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

async function runReminders(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  }

  try {
    const nowMs = Date.now();
    const minStartIso = new Date(nowMs - 8 * 60 * 60 * 1000).toISOString();
    const maxStartIso = new Date(nowMs + 2 * 60 * 60 * 1000).toISOString();

    const { data: rawBookings, error: bErr } = await supabaseAdmin
      .from("bookings")
      .select(
        "id, user_id, room_id, start_time, end_time, status, checkin_time, checkout_time, created_at, contract_id, booking_origin",
      )
      .in("status", ["confirmed", "in_progress"])
      .is("contract_id", null)
      .gte("start_time", minStartIso)
      .lte("start_time", maxStartIso)
      .order("start_time", { ascending: true });

    if (bErr) throw bErr;

    const eligibleBookings = (rawBookings || []).filter(
      (b: any) => !String(b.booking_origin || "").startsWith("contract"),
    );

    if (eligibleBookings.length === 0) {
      return NextResponse.json({
        success: true,
        sessionsChecked: 0,
        sent: { checkin15m: 0, checkout10m: 0, overtime5m: 0 },
      });
    }

    const sessions = groupUserRoomBookingsIntoSessions(eligibleBookings);

    const userIds = Array.from(new Set(sessions.map((s) => s.userId)));
    const roomIds = Array.from(new Set(sessions.map((s) => s.roomId)));

    const [profilesRes, roomsRes] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, full_name, phone, whatsapp")
        .in("id", userIds),
      supabaseAdmin
        .from("rooms")
        .select("id, name, address_details")
        .in("id", roomIds),
    ]);

    const profilesMap = new Map<string, any>(
      (profilesRes.data || []).map((p: any) => [p.id, p]),
    );
    const roomsMap = new Map<string, any>(
      (roomsRes.data || []).map((r: any) => [r.id, r]),
    );

    const counters = { checkin15m: 0, checkout10m: 0, overtime5m: 0 };
    let messageIndex = 0;

    for (const session of sessions) {
      const specialist = profilesMap.get(session.userId);
      const room = roomsMap.get(session.roomId);
      const phone = normalizeBrazilWhatsApp(
        specialist?.whatsapp || specialist?.phone,
      );

      if (!phone || !room) continue;

      const firstName =
        String(specialist?.full_name || "Doutor(a)")
          .trim()
          .split(" ")[0] || "Doutor(a)";
      const roomName = room.name || "Consultório Fusion";
      const shortRoomCode = String(session.roomId).slice(0, 6);
      const doorLink = `${APP_URL}/dashboard?scan=${shortRoomCode}`;

      const firstBooking = session.bookings[0];
      const lastBooking = session.bookings[session.bookings.length - 1];

      const startMs = new Date(session.startTime).getTime();
      const endMs = new Date(session.endTime).getTime();
      const minsUntilStart = (startMs - nowMs) / 60000;
      const minsUntilEnd = (endMs - nowMs) / 60000;
      const minsPastEnd = (nowMs - endMs) / 60000;
      const minsSinceCreated = firstBooking.created_at
        ? (nowMs - new Date(firstBooking.created_at).getTime()) / 60000
        : 999;

      const hasCheckin = session.bookings.some(
        (b: any) => b.status === "in_progress" || Boolean(b.checkin_time),
      );
      const hasCheckout = session.bookings.every(
        (b: any) => b.status === "completed" || Boolean(b.checkout_time),
      );

      const startFmt = formatBrazilTime(session.startTime);
      const endFmt = formatBrazilTime(session.endTime);

      if (
        !hasCheckin &&
        !hasCheckout &&
        firstBooking.status === "confirmed" &&
        minsUntilStart <= 16 &&
        minsUntilStart >= -5 &&
        minsSinceCreated >= 3
      ) {
        const locked = await claimNotificationLock(
          firstBooking.id,
          "reminder_15m_checkin",
          phone,
        );
        if (locked) {
          const text = [
            `⏰ *Seu atendimento começa em breve — Fusion Clinic*`,
            ``,
            `Olá, *${firstName}*! Seu horário na *${roomName}* começa às *${startFmt}* (término às ${endFmt}).`,
            ``,
            `📲 *Check-in já liberado:*`,
            `${doorLink}`,
            ``,
            `Ao chegar na clínica, toque no link acima ou encoste seu celular na *Tag NFC / QR Code* da porta para iniciar sua sessão.`,
          ].join("\n");

          const result = await sendEvolutionWhatsAppMessage({
            phone,
            text,
            delayMs: 1200 + messageIndex * 1200,
          });
          messageIndex += 1;

          if (result.success) {
            counters.checkin15m += 1;
          } else {
            await releaseNotificationLock(
              firstBooking.id,
              "reminder_15m_checkin",
            );
          }
        }
      }

      if (
        hasCheckin &&
        !hasCheckout &&
        minsUntilEnd <= 12 &&
        minsUntilEnd >= 1
      ) {
        const locked = await claimNotificationLock(
          lastBooking.id,
          "reminder_10m_checkout",
          phone,
        );
        if (locked) {
          const text = [
            `⏳ *Faltam 10 minutos para o encerramento — ${roomName}*`,
            ``,
            `Olá, *${firstName}*! Seu horário encerra às *${endFmt}*.`,
            ``,
            `Antes de sair da sala, lembre-se:`,
            `❄️ *Desligue o ar-condicionado*`,
            `💡 *Apague as luzes*`,
            `📲 *Registre seu Check-out obrigatório:*`,
            `${doorLink}`,
            ``,
            `_(Você também pode encostar o celular na Tag NFC / QR Code na porta ao sair)_`,
          ].join("\n");

          const result = await sendEvolutionWhatsAppMessage({
            phone,
            text,
            delayMs: 1200 + messageIndex * 1200,
          });
          messageIndex += 1;

          if (result.success) {
            counters.checkout10m += 1;
          } else {
            await releaseNotificationLock(
              lastBooking.id,
              "reminder_10m_checkout",
            );
          }
        }
      }

      if (
        hasCheckin &&
        !hasCheckout &&
        minsPastEnd >= 4 &&
        minsPastEnd <= 25
      ) {
        const locked = await claimNotificationLock(
          lastBooking.id,
          "alert_5m_overtime",
          phone,
        );
        if (locked) {
          const text = [
            `⚠️ *Atenção: Check-out Pendente — ${roomName}*`,
            ``,
            `Olá, *${firstName}*! Seu horário encerrou às *${endFmt}* e ainda não identificamos o registro da sua saída.`,
            ``,
            `📲 *Finalize seu Check-out agora:*`,
            `${doorLink}`,
            ``,
            `A tolerância máxima é de *15 minutos*. Registre a saída pelo link acima (ou na Tag NFC da porta) para evitar a cobrança automática de hora extra.`,
          ].join("\n");

          const result = await sendEvolutionWhatsAppMessage({
            phone,
            text,
            delayMs: 1200 + messageIndex * 1200,
          });
          messageIndex += 1;

          if (result.success) {
            counters.overtime5m += 1;
          } else {
            await releaseNotificationLock(lastBooking.id, "alert_5m_overtime");
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      sessionsChecked: sessions.length,
      sent: counters,
    });
  } catch (error: any) {
    console.error("[Cron WhatsApp] Erro crítico:", error);
    return NextResponse.json(
      { error: error.message || "Erro ao processar lembretes." },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return runReminders(request);
}

export async function POST(request: Request) {
  return runReminders(request);
}