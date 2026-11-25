import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import {
  normalizeBrazilWhatsApp,
  sendEvolutionWhatsAppMessage,
} from "@/utils/evolution-whatsapp";
import { checkRoomCheckinAvailability } from "@/utils/room-checkin-guard";

export const dynamic = "force-dynamic";

const APP_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://www.fusionapp.com.br";

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

function formatBrazilTime(isoOrDate: string | Date): string {
  const date = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
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
        sent: {
          checkinReady: 0,
          checkinWaiting: 0,
          checkout10m: 0,
          checkout5m: 0,
          checkoutOverdue: 0,
        },
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

    const counters = {
      checkinReady: 0,
      checkinWaiting: 0,
      checkout10m: 0,
      checkout5m: 0,
      checkoutOverdue: 0,
    };
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
      const fineStartFmt = formatBrazilTime(new Date(endMs + 60 * 1000));

      // -----------------------------------------------------------------------
      // 1) AVISO PRÉ-ATENDIMENTO (15 min antes até 10 min após início sem check-in)
      // -----------------------------------------------------------------------
      if (
        !hasCheckin &&
        !hasCheckout &&
        firstBooking.status === "confirmed" &&
        minsUntilStart <= 16 &&
        minsUntilStart >= -10 &&
        minsSinceCreated >= 1
      ) {
        const availability = await checkRoomCheckinAvailability(supabaseAdmin, {
          roomId: session.roomId,
          currentBookingId: firstBooking.id,
          currentUserId: session.userId,
          sessionStartIso: session.startTime,
          nowMs,
        });

        if (availability.canCheckIn) {
          // Sala livre: libera check-in (antecipado se ainda antes do horário)
          const locked = await claimNotificationLock(
            firstBooking.id,
            "reminder_15m_checkin_ready",
            phone,
          );

          if (locked) {
            const isEarly = minsUntilStart > 1;
            const headline = isEarly
              ? `✅ *Sala livre! Check-in antecipado liberado — Fusion Clinic*`
              : `✅ *Seu horário começou! Check-in liberado — Fusion Clinic*`;

            const intro = isEarly
              ? `Olá, *${firstName}*! A *${roomName}* está livre antes do seu horário (*${startFmt} às ${endFmt}*), então seu check-in já está liberado.`
              : `Olá, *${firstName}*! A *${roomName}* já está liberada para o seu atendimento (*${startFmt} às ${endFmt}*).`;

            const text = [
              headline,
              ``,
              intro,
              ``,
              `📲 *Faça seu Check-in agora:*`,
              `${doorLink}`,
              ``,
              `Ao chegar, toque no link acima ou encoste o celular na *Tag NFC / QR Code* da porta.`,
              `⏱️ *Lembrete:* o encerramento e check-out devem ser feitos até *${endFmt}* (multa por atraso a partir das *${fineStartFmt}*).`,
            ].join("\n");

            const result = await sendEvolutionWhatsAppMessage({
              phone,
              text,
              delayMs: 1200 + messageIndex * 1200,
            });
            messageIndex += 1;

            if (result.success) {
              counters.checkinReady += 1;
            } else {
              await releaseNotificationLock(
                firstBooking.id,
                "reminder_15m_checkin_ready",
              );
            }
          }
        } else {
          // Sala ocupada ou reservada no horário anterior: avisa transparência sem link liberado
          const locked = await claimNotificationLock(
            firstBooking.id,
            "reminder_15m_waiting_checkout",
            phone,
          );

          if (locked) {
            const prevEndFmt = formatBrazilTime(availability.blockingEndTime);
            const text = [
              `⏰ *Seu atendimento começa às ${startFmt} — ${roomName}*`,
              ``,
              `Olá, *${firstName}*! Há outro profissional com horário agendado antes do seu (término previsto às *${prevEndFmt}*).`,
              ``,
              `🔒 *Como funciona a liberação:*`,
              `Para respeitar o atendimento anterior, seu check-in será liberado *automaticamente assim que o profissional anterior registrar o check-out*.`,
              ``,
              `Fique tranquilo(a): *assim que a sala for liberada, enviaremos o link de check-in aqui no seu WhatsApp na hora!*`,
            ].join("\n");

            const result = await sendEvolutionWhatsAppMessage({
              phone,
              text,
              delayMs: 1200 + messageIndex * 1200,
            });
            messageIndex += 1;

            if (result.success) {
              counters.checkinWaiting += 1;
            } else {
              await releaseNotificationLock(
                firstBooking.id,
                "reminder_15m_waiting_checkout",
              );
            }
          }
        }
      }

      // -----------------------------------------------------------------------
      // 2) AVISO DE 10 MINUTOS ANTES DO ENCERRAMENTO (ex: 08:50)
      // -----------------------------------------------------------------------
      if (
        hasCheckin &&
        !hasCheckout &&
        minsUntilEnd <= 11.5 &&
        minsUntilEnd > 6.5
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
            `Ao finalizar o atendimento, lembre-se:`,
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

      // -----------------------------------------------------------------------
      // 3) AVISO DE 5 MINUTOS ANTES DO ENCERRAMENTO (ex: 08:55)
      // -----------------------------------------------------------------------
      if (
        hasCheckin &&
        !hasCheckout &&
        minsUntilEnd <= 6.5 &&
        minsUntilEnd > 0
      ) {
        const locked = await claimNotificationLock(
          lastBooking.id,
          "reminder_5m_checkout",
          phone,
        );
        if (locked) {
          const text = [
            `🔔 *Últimos 5 minutos — Prepare seu Check-out (${roomName})*`,
            ``,
            `Olá, *${firstName}*! A tolerância máxima para saída e registro de check-out é às *${endFmt}*.`,
            ``,
            `⚠️ A partir das *${fineStartFmt}*, a permanência sem check-out registrado está sujeita à *cobrança de multa por atraso*.`,
            ``,
            `📲 *Faça seu Check-out agora:*`,
            `${doorLink}`,
          ].join("\n");

          const result = await sendEvolutionWhatsAppMessage({
            phone,
            text,
            delayMs: 1200 + messageIndex * 1200,
          });
          messageIndex += 1;

          if (result.success) {
            counters.checkout5m += 1;
          } else {
            await releaseNotificationLock(
              lastBooking.id,
              "reminder_5m_checkout",
            );
          }
        }
      }

      // -----------------------------------------------------------------------
      // 4) HORÁRIO ENCERRADO SEM CHECK-OUT (ex: 09:00+)
      // -----------------------------------------------------------------------
      if (
        hasCheckin &&
        !hasCheckout &&
        minsPastEnd >= 0 &&
        minsPastEnd <= 25
      ) {
        const locked = await claimNotificationLock(
          lastBooking.id,
          "alert_checkout_overdue",
          phone,
        );
        if (locked) {
          const text = [
            `⚠️ *Horário encerrado — Check-out pendente (${roomName})*`,
            ``,
            `Olá, *${firstName}*! Seu horário encerrou às *${endFmt}* e ainda não identificamos o registro da sua saída.`,
            ``,
            `Lembramos que a tolerância máxima é até *${endFmt}*, com *cobrança de multa a partir das ${fineStartFmt}* caso o check-out não seja realizado.`,
            ``,
            `📲 *Finalize seu Check-out imediatamente:*`,
            `${doorLink}`,
          ].join("\n");

          const result = await sendEvolutionWhatsAppMessage({
            phone,
            text,
            delayMs: 1200 + messageIndex * 1200,
          });
          messageIndex += 1;

          if (result.success) {
            counters.checkoutOverdue += 1;
          } else {
            await releaseNotificationLock(
              lastBooking.id,
              "alert_checkout_overdue",
            );
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