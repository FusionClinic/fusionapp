import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { sendBookingNotificationEmails } from "@/app/actions/send-email";
import {
  getBrazilDatePartsFromIso,
  isBookingSlotBlockedByHoliday,
} from "@/utils/brazil-holidays";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAdmin = createAdminClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
  },
);

const MONTHLY_UPSELL_LIMIT = 2;
const CLOSING_HOUR_BRT = 18;
const DISCOUNT_RATE = 0.3;
const PIX_EXPIRATION_MINUTES = 5;

function validateTotemSecret(request: Request): boolean {
  const configured = (process.env.TOTEM_API_SECRET || "").trim();
  if (!configured) return false;
  const provided = (request.headers.get("x-totem-secret") || "").trim();
  return provided === configured;
}

function getAsaasConfig() {
  const rawKey =
    process.env.ASAAS_API_KEY ||
    process.env.ASAAS_ACCESS_TOKEN ||
    process.env.ASAAS_TOKEN ||
    "";
  let apiKey = rawKey.trim().replace(/^["']|["']$/g, "");
  if (!apiKey) {
    throw new Error("ASAAS_API_KEY não configurada no servidor.");
  }
  if (apiKey.startsWith("\\$")) {
    apiKey = apiKey.slice(1);
  }
  const isSandboxKey = apiKey.toLowerCase().includes("hmlg");
  const envUrl = (process.env.ASAAS_API_URL || "").trim().replace(/\/+$/, "");
  let apiUrl = envUrl;
  if (!apiUrl) {
    apiUrl = isSandboxKey
      ? "https://sandbox.asaas.com/api/v3"
      : "https://api.asaas.com/v3";
  } else if (isSandboxKey && !apiUrl.includes("sandbox")) {
    apiUrl = "https://sandbox.asaas.com/api/v3";
  } else if (
    !isSandboxKey &&
    apiUrl.includes("sandbox") &&
    apiKey.includes("prod")
  ) {
    apiUrl = "https://api.asaas.com/v3";
  }
  return { apiKey, apiUrl };
}

function formatBrtHHMM(ms: number): string {
  const brt = new Date(ms - 3 * 60 * 60 * 1000);
  const hh = String(brt.getUTCHours()).padStart(2, "0");
  const mm = String(brt.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function getBrtMonthRangeIso(now = new Date()) {
  const brtNow = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const year = brtNow.getUTCFullYear();
  const month = brtNow.getUTCMonth();
  const startUtcMs = Date.UTC(year, month, 1, 3, 0, 0, 0);
  const endUtcMs = Date.UTC(year, month + 1, 1, 3, 0, 0, 0);
  return {
    monthStartIso: new Date(startUtcMs).toISOString(),
    monthEndIso: new Date(endUtcMs).toISOString(),
  };
}

function resolveBaseHourlyPrice(roomAddressDetails: any, startIso: string): number {
  let addr = roomAddressDetails || {};
  if (typeof addr === "string") {
    try {
      addr = JSON.parse(addr);
    } catch {
      addr = {};
    }
  }
  const pricing = addr?.pricing || {};
  const brDate = new Date(new Date(startIso).getTime() - 3 * 60 * 60 * 1000);
  const dow = brDate.getUTCDay();
  const hour = brDate.getUTCHours();
  const commercial = Number(pricing.hourly || 45);
  if (dow === 0 || dow === 6) {
    return Number(pricing.weekend || commercial);
  }
  if (hour >= 18 || hour < 8) {
    return Number(pricing.afterHours || commercial);
  }
  return commercial;
}

async function getOrCreateAsaasCustomer(params: {
  apiKey: string;
  apiUrl: string;
  profile: any;
}) {
  const { apiKey, apiUrl, profile } = params;
  const cleanCpf = String(profile?.cpf || "").replace(/\D/g, "");
  if (!cleanCpf || (cleanCpf.length !== 11 && cleanCpf.length !== 14)) {
    throw new Error(
      "CPF não cadastrado no perfil do profissional. Solicite atualização na recepção ou no app.",
    );
  }

  let asaasCustomerId = "";
  const searchRes = await fetch(`${apiUrl}/customers?cpfCnpj=${cleanCpf}`, {
    headers: {
      access_token: apiKey,
      "User-Agent": "FusionClinic/1.0",
    },
  });

  if (searchRes.ok) {
    const searchData = await searchRes.json();
    if (searchData.data && searchData.data.length > 0) {
      asaasCustomerId = searchData.data[0].id;
    }
  }

  if (!asaasCustomerId) {
    const createRes = await fetch(`${apiUrl}/customers`, {
      method: "POST",
      headers: {
        access_token: apiKey,
        "Content-Type": "application/json",
        "User-Agent": "FusionClinic/1.0",
      },
      body: JSON.stringify({
        name: profile?.full_name || "Especialista Fusion",
        email: profile?.email || undefined,
        cpfCnpj: cleanCpf,
        mobilePhone:
          String(profile?.whatsapp || profile?.phone || "").replace(/\D/g, "") ||
          undefined,
        notificationDisabled: true,
      }),
    });
    const customerResult = await createRes.json();
    if (!createRes.ok) {
      throw new Error(
        customerResult.errors?.[0]?.description ||
          "Erro ao registrar cliente no Asaas.",
      );
    }
    asaasCustomerId = customerResult.id;
  }

  return asaasCustomerId;
}

export async function GET(request: Request) {
  try {
    if (!validateTotemSecret(request)) {
      return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const bookingId = searchParams.get("bookingId");
    if (!bookingId) {
      return NextResponse.json(
        { error: "bookingId é obrigatório." },
        { status: 400 },
      );
    }

    const { data: booking, error } = await supabaseAdmin
      .from("bookings")
      .select("id, status, asaas_payment_id")
      .eq("id", bookingId)
      .single();

    if (error || !booking) {
      return NextResponse.json(
        { error: "Reserva não encontrada." },
        { status: 404 },
      );
    }

    if (booking.status === "confirmed" || booking.status === "in_progress") {
      return NextResponse.json({ confirmed: true, status: booking.status });
    }

    if (booking.status === "cancelled") {
      return NextResponse.json({ confirmed: false, status: "cancelled" });
    }

    if (booking.asaas_payment_id) {
      const { apiKey, apiUrl } = getAsaasConfig();
      const asaasRes = await fetch(
        `${apiUrl}/payments/${booking.asaas_payment_id}`,
        {
          headers: {
            access_token: apiKey,
            "User-Agent": "FusionClinic/1.0",
          },
          cache: "no-store",
        },
      );

      if (asaasRes.ok) {
        const paymentData = await asaasRes.json();
        if (
          paymentData.status === "RECEIVED" ||
          paymentData.status === "CONFIRMED"
        ) {
          await supabaseAdmin
            .from("bookings")
            .update({ status: "confirmed" })
            .eq("id", booking.id);

          sendBookingNotificationEmails(booking.id).catch(console.error);
          return NextResponse.json({ confirmed: true, status: "confirmed" });
        }
      }
    }

    return NextResponse.json({ confirmed: false, status: booking.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Erro ao verificar pagamento." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    if (!validateTotemSecret(request)) {
      return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
    }

    const body = await request.json();
    const { bookingId, currentEndIso } = body as {
      bookingId?: string;
      currentEndIso?: string;
    };

    if (!bookingId) {
      return NextResponse.json(
        { error: "bookingId é obrigatório." },
        { status: 400 },
      );
    }

    const { data: baseBooking, error: baseErr } = await supabaseAdmin
      .from("bookings")
      .select("id, user_id, room_id, start_time, end_time, status")
      .eq("id", bookingId)
      .single();

    if (baseErr || !baseBooking) {
      return NextResponse.json(
        { error: "Reserva atual não encontrada." },
        { status: 404 },
      );
    }

    if (!["confirmed", "in_progress"].includes(baseBooking.status || "")) {
      return NextResponse.json(
        { error: "Esta reserva não está elegível para prorrogação." },
        { status: 409 },
      );
    }

    if (!baseBooking.user_id) {
      return NextResponse.json(
        { error: "Profissional não vinculado à reserva." },
        { status: 400 },
      );
    }

    const referenceEndMs = Math.max(
      new Date(baseBooking.end_time).getTime(),
      currentEndIso ? new Date(currentEndIso).getTime() : 0,
    );
    const refBrt = new Date(referenceEndMs - 3 * 60 * 60 * 1000);
    const nextStartMs =
      refBrt.getUTCMinutes() === 0
        ? referenceEndMs
        : Date.UTC(
            refBrt.getUTCFullYear(),
            refBrt.getUTCMonth(),
            refBrt.getUTCDate(),
            refBrt.getUTCHours() + 1 + 3,
            0,
            0,
            0,
          );

    const nextEndMs = nextStartMs + 50 * 60 * 1000;
    const nextBlockEndMs = nextStartMs + 60 * 60 * 1000;
    const nextStartBrt = new Date(nextStartMs - 3 * 60 * 60 * 1000);
    const nextBlockEndHourBrt = nextStartBrt.getUTCHours() + 1;

    if (nextBlockEndHourBrt > CLOSING_HOUR_BRT) {
      return NextResponse.json(
        {
          error:
            "A oferta de última hora está disponível apenas para horários com encerramento até as 18:00.",
        },
        { status: 409 },
      );
    }

    if (Date.now() > nextStartMs + 35 * 60 * 1000) {
      return NextResponse.json(
        { error: "A janela para contratar este horário já foi encerrada." },
        { status: 409 },
      );
    }

    const nextStartIso = new Date(nextStartMs).toISOString();
    const nextEndIso = new Date(nextEndMs).toISOString();

    const { data: room, error: roomErr } = await supabaseAdmin
      .from("rooms")
      .select("id, name, host_id, address_details, availability, blocked_dates")
      .eq("id", baseBooking.room_id)
      .single();

    if (roomErr || !room) {
      return NextResponse.json(
        { error: "Sala não encontrada." },
        { status: 404 },
      );
    }

    const brParts = getBrazilDatePartsFromIso(nextStartIso);
    if (
      brParts &&
      Array.isArray(room.blocked_dates) &&
      room.blocked_dates.includes(brParts.dateKey)
    ) {
      return NextResponse.json(
        { error: "Esta data está bloqueada pela clínica." },
        { status: 409 },
      );
    }

    const holidayCheck = isBookingSlotBlockedByHoliday(
      room.availability,
      nextStartIso,
    );
    if (holidayCheck.blocked) {
      return NextResponse.json(
        {
          error: `Consultório fechado no feriado (${holidayCheck.holidayName}).`,
        },
        { status: 409 },
      );
    }

    const { monthStartIso, monthEndIso } = getBrtMonthRangeIso();
    const { count: monthlyUses } = await supabaseAdmin
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("user_id", baseBooking.user_id)
      .eq("booking_origin", "totem_30off")
      .in("status", ["confirmed", "in_progress", "completed"])
      .gte("start_time", monthStartIso)
      .lt("start_time", monthEndIso);

    if ((monthlyUses || 0) >= MONTHLY_UPSELL_LIMIT) {
      return NextResponse.json(
        {
          error: `Você já utilizou o limite de ${MONTHLY_UPSELL_LIMIT} horas promocionais no totem este mês.`,
        },
        { status: 409 },
      );
    }

    const { data: conflicts } = await supabaseAdmin
      .from("bookings")
      .select("id, status, user_id, created_at, asaas_payment_id, booking_origin")
      .eq("room_id", baseBooking.room_id)
      .not("status", "in", "(cancelled,no_show)")
      .lt("start_time", nextEndIso)
      .gt("end_time", nextStartIso);

    const nowMs = Date.now();
    const { apiKey, apiUrl } = getAsaasConfig();

    for (const c of conflicts || []) {
      if (["confirmed", "in_progress", "completed"].includes(c.status || "")) {
        return NextResponse.json(
          { error: "O próximo horário desta sala acabou de ser reservado." },
          { status: 409 },
        );
      }

      if (c.status === "pending_payment") {
        if (c.user_id === baseBooking.user_id && c.booking_origin === "totem_30off") {
          if (c.asaas_payment_id) {
            await fetch(`${apiUrl}/payments/${c.asaas_payment_id}`, {
              method: "DELETE",
              headers: {
                access_token: apiKey,
                "User-Agent": "FusionClinic/1.0",
              },
            }).catch(() => {});
          }
          await supabaseAdmin
            .from("bookings")
            .update({ status: "cancelled" })
            .eq("id", c.id);
          continue;
        }

        const lockTime = c.created_at ? new Date(c.created_at).getTime() : 0;
        const maxLockMs = c.asaas_payment_id ? 10 * 60 * 1000 : 5 * 60 * 1000;
        if (nowMs - lockTime <= maxLockMs) {
          return NextResponse.json(
            {
              error:
                "Outro profissional está finalizando o pagamento para este horário.",
            },
            { status: 409 },
          );
        }
      }
    }

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, email, cpf, phone, whatsapp")
      .eq("id", baseBooking.user_id)
      .single();

    const asaasCustomerId = await getOrCreateAsaasCustomer({
      apiKey,
      apiUrl,
      profile,
    });

    const basePrice = resolveBaseHourlyPrice(room.address_details, nextStartIso);
    const discountedPrice = Number((basePrice * (1 - DISCOUNT_RATE)).toFixed(2));

    const bookingDateStr = brParts
      ? brParts.dateKey
      : nextStartIso.split("T")[0];

    const { data: activeCohostContract } = await supabaseAdmin
      .from("room_contracts")
      .select("id, specialist_id, cohost_split_pct")
      .eq("room_id", room.id)
      .eq("status", "active")
      .eq("contract_type", "monthly_exclusive")
      .eq("allow_sublease", true)
      .lte("start_date", bookingDateStr)
      .gte("end_date", bookingDateStr)
      .maybeSingle();

    let recipientWalletId: string | null = null;
    if (activeCohostContract?.specialist_id) {
      const { data: cohostProfile } = await supabaseAdmin
        .from("profiles")
        .select("asaas_wallet_id")
        .eq("id", activeCohostContract.specialist_id)
        .single();
      recipientWalletId = cohostProfile?.asaas_wallet_id || null;
    } else if (room.host_id) {
      const { data: hostProfile } = await supabaseAdmin
        .from("profiles")
        .select("asaas_wallet_id")
        .eq("id", room.host_id)
        .single();
      recipientWalletId = hostProfile?.asaas_wallet_id || null;
    }

    const { data: newBooking, error: insertErr } = await supabaseAdmin
      .from("bookings")
      .insert({
        user_id: baseBooking.user_id,
        room_id: room.id,
        start_time: nextStartIso,
        end_time: nextEndIso,
        status: "pending_payment",
        total_cost: discountedPrice,
        agreed_value_brl: discountedPrice,
        booking_origin: "totem_30off",
        notes: `Hora extra adquirida via Totem (30% OFF - Base R$ ${basePrice.toFixed(2)})`,
      })
      .select("id")
      .single();

    if (insertErr || !newBooking) {
      throw new Error(insertErr?.message || "Erro ao criar reserva pendente.");
    }

    const paymentPayload: Record<string, any> = {
      customer: asaasCustomerId,
      billingType: "PIX",
      value: discountedPrice,
      dueDate: bookingDateStr,
      description: `Hora Extra Totem (30% OFF) - ${room.name}`,
      externalReference: newBooking.id,
    };

    if (recipientWalletId) {
      const splitPct = activeCohostContract
        ? Number(activeCohostContract.cohost_split_pct || 80)
        : 80.0;
      paymentPayload.split = [
        { walletId: recipientWalletId, percentualValue: splitPct },
      ];
    }

    const createPaymentRes = await fetch(`${apiUrl}/payments`, {
      method: "POST",
      headers: {
        access_token: apiKey,
        "Content-Type": "application/json",
        "User-Agent": "FusionClinic/1.0",
      },
      body: JSON.stringify(paymentPayload),
    });

    const paymentResult = await createPaymentRes.json();
    if (!createPaymentRes.ok) {
      await supabaseAdmin
        .from("bookings")
        .update({ status: "cancelled" })
        .eq("id", newBooking.id);
      throw new Error(
        paymentResult.errors?.[0]?.description ||
          "Erro ao gerar cobrança PIX no Asaas.",
      );
    }

    await supabaseAdmin
      .from("bookings")
      .update({ asaas_payment_id: paymentResult.id })
      .eq("id", newBooking.id);

    const pixRes = await fetch(
      `${apiUrl}/payments/${paymentResult.id}/pixQrCode`,
      {
        headers: {
          access_token: apiKey,
          "User-Agent": "FusionClinic/1.0",
        },
      },
    );
    const pixData = await pixRes.json();
    if (!pixRes.ok || !pixData.encodedImage) {
      await supabaseAdmin
        .from("bookings")
        .update({ status: "cancelled" })
        .eq("id", newBooking.id);
      throw new Error("Erro ao obter QR Code PIX do Asaas.");
    }

    const expiresAt = new Date(
      Date.now() + PIX_EXPIRATION_MINUTES * 60 * 1000,
    ).toISOString();

    return NextResponse.json({
      success: true,
      bookingId: newBooking.id,
      paymentId: paymentResult.id,
      roomName: room.name,
      basePrice,
      discountedPrice,
      discountPercent: 30,
      startTime: formatBrtHHMM(nextStartMs),
      endTime: formatBrtHHMM(nextEndMs),
      blockEndHour: formatBrtHHMM(nextBlockEndMs),
      pixQrCode: pixData.encodedImage,
      pixCopyPaste: pixData.payload,
      expiresAt,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Erro ao gerar oferta PIX." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    if (!validateTotemSecret(request)) {
      return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const bookingId = searchParams.get("bookingId");
    if (!bookingId) {
      return NextResponse.json(
        { error: "bookingId é obrigatório." },
        { status: 400 },
      );
    }

    const { data: booking } = await supabaseAdmin
      .from("bookings")
      .select("id, status, asaas_payment_id, booking_origin")
      .eq("id", bookingId)
      .maybeSingle();

    if (
      !booking ||
      booking.status !== "pending_payment" ||
      booking.booking_origin !== "totem_30off"
    ) {
      return NextResponse.json({ cancelled: false });
    }

    if (booking.asaas_payment_id) {
      const { apiKey, apiUrl } = getAsaasConfig();
      await fetch(`${apiUrl}/payments/${booking.asaas_payment_id}`, {
        method: "DELETE",
        headers: {
          access_token: apiKey,
          "User-Agent": "FusionClinic/1.0",
        },
      }).catch(() => {});
    }

    await supabaseAdmin
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("id", booking.id);

    return NextResponse.json({ cancelled: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Erro ao cancelar cobrança." },
      { status: 500 },
    );
  }
}