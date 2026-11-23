// app/api/webhook/asaas/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  sendBookingNotificationEmails,
  sendPaymentNotificationEmails,
} from "@/app/actions/send-email";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

async function syncCouponUsesForConfirmedBookings(bookingIds: string[]) {
  try {
    if (!bookingIds || bookingIds.length === 0) return;

    const { data: confirmedBookings } = await supabaseAdmin
      .from("bookings")
      .select(
        "id, user_id, room_id, start_time, total_cost, agreed_value_brl, booking_origin, status, created_at",
      )
      .in("id", bookingIds)
      .in("status", ["confirmed", "in_progress", "completed"]);

    if (!confirmedBookings || confirmedBookings.length === 0) return;

    const taggedBookings = confirmedBookings.filter((b: any) => {
      const origin = String(b.booking_origin || "");
      return origin.startsWith("campaign_") || origin.startsWith("coupon_");
    });

    if (taggedBookings.length === 0) return;

    const roomIds = Array.from(
      new Set(taggedBookings.map((b: any) => b.room_id).filter(Boolean)),
    );
    const { data: roomsData } = await supabaseAdmin
      .from("rooms")
      .select("id, address_details")
      .in("id", roomIds);
    const roomsMap = new Map<string, any>(
      (roomsData || []).map((r: any) => [r.id, r]),
    );

    const affectedCouponIds = new Set<string>();

    for (const b of taggedBookings) {
      const origin = String(b.booking_origin || "");
      const couponId = origin.replace(/^campaign_|^coupon_/, "").trim();
      if (!couponId) continue;

      const { data: existingUse } = await supabaseAdmin
        .from("coupon_uses")
        .select("id")
        .eq("coupon_id", couponId)
        .eq("booking_id", b.id)
        .limit(1);

      if (existingUse && existingUse.length > 0) {
        affectedCouponIds.add(couponId);
        continue;
      }

      const room = roomsMap.get(b.room_id);
      let addr = room?.address_details || {};
      if (typeof addr === "string") {
        try {
          addr = JSON.parse(addr);
        } catch {
          addr = {};
        }
      }
      const pricing = addr?.pricing || {};
      const brDate = new Date(
        new Date(b.start_time).getTime() - 3 * 60 * 60 * 1000,
      );
      const dow = brDate.getUTCDay();
      const hour = brDate.getUTCHours();
      const commercial = Number(pricing.hourly || 45);
      const basePrice =
        dow === 0 || dow === 6
          ? Number(pricing.weekend || commercial)
          : hour >= 18 || hour < 8
            ? Number(pricing.afterHours || commercial)
            : commercial;

      const rawTotal = Number(b.total_cost || 0);
      const rawAgreed = Number(b.agreed_value_brl || 0);
      const paidBrl = rawTotal >= 10 ? rawTotal : rawAgreed;
      const discountApplied = Math.max(
        0,
        Number((basePrice - paidBrl).toFixed(2)),
      );

      await supabaseAdmin.from("coupon_uses").insert({
        coupon_id: couponId,
        user_id: b.user_id,
        booking_id: b.id,
        discount_applied: discountApplied,
        used_at: b.created_at || new Date().toISOString(),
      });

      affectedCouponIds.add(couponId);
    }

    for (const cid of affectedCouponIds) {
      const { count } = await supabaseAdmin
        .from("coupon_uses")
        .select("id", { count: "exact", head: true })
        .eq("coupon_id", cid);

      if (typeof count === "number") {
        await supabaseAdmin
          .from("coupons")
          .update({ current_uses: count })
          .eq("id", cid);
      }
    }
  } catch (err) {
    console.error("[Asaas Webhook] Erro ao sincronizar uso de campanha:", err);
  }
}

export async function POST(request: Request) {
  try {
    const asaasToken = request.headers.get("asaas-access-token");
    const configuredSecret =
      process.env.ASAAS_WEBHOOK_SECRET || process.env.ASAAS_WEBHOOK_TOKEN;
    if (configuredSecret && asaasToken !== configuredSecret) {
      console.error("[Asaas Webhook] Token de webhook inválido ou ausente.");
      return NextResponse.json(
        { error: "Acesso não autorizado." },
        { status: 401 },
      );
    }

    const payload = await request.json();
    const { event, payment } = payload;
    if (!payment || !payment.id) {
      return NextResponse.json(
        { error: "Payload inválido: objeto payment ausente." },
        { status: 400 },
      );
    }

    const paymentId = String(payment.id);
    const externalRef = String(payment.externalReference || "");
    const isSubscriptionPayment =
      Boolean(payment.subscription) || externalRef.startsWith("sub_");

    console.log(
      `[Asaas Webhook] Evento: ${event} | Pagamento: ${paymentId} | Tipo: ${isSubscriptionPayment ? "Assinatura" : "Reserva"}`,
    );

    if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") {
      // CENÁRIO A: ASSINATURA RECORRENTE FUSION PASS+
      if (isSubscriptionPayment) {
        const idempotencyTag = `[Asaas:${paymentId}]`;
        const { data: existingTx } = await supabaseAdmin
          .from("wallet_transactions")
          .select("id")
          .or(
            `description.ilike.%${idempotencyTag}%,description.ilike.%(${paymentId})%`,
          )
          .limit(1);

        if (existingTx && existingTx.length > 0) {
          console.log(
            `[Asaas Webhook] Fatura de assinatura ${paymentId} já creditada anteriormente. Ignorando duplicidade.`,
          );
          return NextResponse.json({
            success: true,
            status: "already_credited",
          });
        }

        let userId = "";
        let tier = "start";
        let hours = 0;

        if (externalRef.startsWith("sub_")) {
          const parts = externalRef.split("_");
          if (parts.length >= 4) {
            userId = parts[1];
            tier = parts[2].toLowerCase().trim();
            hours = Number(parts[3].replace(/\D/g, "")) || 0;
          }
        }

        if ((!userId || hours <= 0) && payment.subscription) {
          const { data: subRecord } = await supabaseAdmin
            .from("subscriptions")
            .select("user_id, tier, hours")
            .eq("asaas_subscription_id", payment.subscription)
            .maybeSingle();
          if (subRecord) {
            userId = subRecord.user_id;
            tier = String(subRecord.tier || "start").toLowerCase().trim();
            hours = Number(subRecord.hours || 0);
          }
        }

        if (!userId || hours <= 0) {
          console.warn(
            `[Asaas Webhook] Não foi possível identificar o usuário/horas para a assinatura ${payment.subscription || externalRef}`,
          );
          return NextResponse.json({
            received: true,
            warning: "Assinatura sem referência de usuário identificada.",
          });
        }

        const priceBrl = Number(payment.value || 0);
        const unitHourlyRate =
          hours > 0 && priceBrl > 0 ? (priceBrl / hours).toFixed(2) : "0.00";
        const rateTag =
          Number(unitHourlyRate) > 0 ? `[Rate:${unitHourlyRate}]` : "";
        const viaTag =
          String(payment.billingType || "").toUpperCase() === "PIX"
            ? "[Via:PIX]"
            : "[Via:CARTAO]";

        await supabaseAdmin
          .from("subscriptions")
          .update({ status: "INACTIVE" })
          .eq("user_id", userId)
          .eq("status", "ACTIVE");

        await supabaseAdmin.from("subscriptions").insert({
          user_id: userId,
          tier,
          hours,
          status: "ACTIVE",
        });

        const expiresAt = new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const { error: walletErr } = await supabaseAdmin
          .from("wallet_transactions")
          .insert({
            user_id: userId,
            amount: hours,
            type: "package_purchase",
            tier,
            description: `Assinatura Fusion Pass (${tier.toUpperCase()}) - +${hours}h ${viaTag} ${rateTag} ${idempotencyTag}`,
            expires_at: expiresAt,
          });
        if (walletErr) {
          console.error(
            "[Asaas Webhook] Erro ao inserir créditos da assinatura:",
            walletErr,
          );
          throw walletErr;
        }

        try {
          await supabaseAdmin.from("notifications").insert({
            user_id: userId,
            type: "subscription_active",
            title: "Créditos do Fusion Pass+ Liberados!",
            content: `Seu pagamento foi confirmado e adicionamos +${hours}h (${tier.toUpperCase()}) na sua carteira.`,
            link: "/dashboard",
            is_read: false,
          });
        } catch {}

        await sendPaymentNotificationEmails({
          userId,
          amountBrl: priceBrl,
          creditsAdded: hours,
          tier,
          paymentMethod: payment.billingType || "Assinatura Asaas",
          description: `Assinatura Fusion Pass+ (${hours}h - ${tier.toUpperCase()})`,
        }).catch(console.error);

        console.log(
          `[Asaas Webhook] +${hours}h (${tier}) creditadas com sucesso para o usuário ${userId}.`,
        );
        return NextResponse.json({
          success: true,
          message: "Assinatura processada e horas creditadas com sucesso.",
        });
      }

      // CENÁRIO B: RESERVA AVULSA DE SALA
      let bookingId = externalRef || null;
      if (!bookingId) {
        const { data: existingBooking } = await supabaseAdmin
          .from("bookings")
          .select("id, status")
          .eq("asaas_payment_id", paymentId)
          .maybeSingle();
        if (existingBooking) {
          bookingId = existingBooking.id;
        }
      }

      if (bookingId) {
        const { data: beforeBooking } = await supabaseAdmin
          .from("bookings")
          .select("id, status")
          .eq("id", bookingId)
          .maybeSingle();
        const wasAlreadyConfirmed = beforeBooking?.status === "confirmed";

        const { data: updatedBooking, error: updateError } = await supabaseAdmin
          .from("bookings")
          .update({
            status: "confirmed",
            asaas_payment_id: paymentId,
          })
          .eq("id", bookingId)
          .select("id, user_id, room_id, start_time, end_time, status")
          .single();
        if (updateError) {
          console.error(
            "[Asaas Webhook] Erro ao confirmar reserva no banco:",
            updateError,
          );
          throw updateError;
        }

        const { data: samePayBookings } = await supabaseAdmin
          .from("bookings")
          .select("id")
          .eq("asaas_payment_id", paymentId);

        const allConfirmedIds = Array.from(
          new Set([
            bookingId,
            ...(samePayBookings || []).map((x: any) => x.id),
          ]),
        );

        await supabaseAdmin
          .from("bookings")
          .update({ status: "confirmed" })
          .in("id", allConfirmedIds);

        await syncCouponUsesForConfirmedBookings(allConfirmedIds);

        if (!wasAlreadyConfirmed) {
          if (updatedBooking?.user_id) {
            await supabaseAdmin.from("notifications").insert({
              user_id: updatedBooking.user_id,
              type: "booking_confirmed",
              title: "Reserva Confirmada!",
              content:
                "Seu pagamento foi confirmado. Seu horário já está garantido.",
              link: "/dashboard",
              is_read: false,
            });
          }

          let hostId: string | undefined = undefined;
          let roomName = "Consultório Fusion";
          if (updatedBooking?.room_id) {
            const { data: roomInfo } = await supabaseAdmin
              .from("rooms")
              .select("name, host_id")
              .eq("id", updatedBooking.room_id)
              .maybeSingle();
            if (roomInfo) {
              hostId = roomInfo.host_id;
              roomName = roomInfo.name || roomName;
            }
          }

          await Promise.allSettled([
            sendBookingNotificationEmails(bookingId),
            updatedBooking?.user_id
              ? sendPaymentNotificationEmails({
                  userId: updatedBooking.user_id,
                  amountBrl: Number(payment.value || 0),
                  paymentMethod: payment.billingType || "PIX / Cartão",
                  description: `Reserva de Sala: ${roomName}`,
                  hostId,
                })
              : Promise.resolve(),
          ]);
        }

        return NextResponse.json({
          success: true,
          message: "Reserva confirmada com sucesso.",
        });
      }
    }

    if (
      event === "PAYMENT_OVERDUE" ||
      event === "PAYMENT_DELETED" ||
      event === "PAYMENT_REFUNDED"
    ) {
      if (!isSubscriptionPayment) {
        await supabaseAdmin
          .from("bookings")
          .update({ status: "cancelled" })
          .eq("asaas_payment_id", paymentId);
        console.log(
          `[Asaas Webhook] Pagamento de reserva ${paymentId} cancelado/vencido. Reservas liberadas.`,
        );
      }
    }

    return NextResponse.json({ received: true });
  } catch (error: any) {
    console.error("[Asaas Webhook] Erro crítico no processamento:", error);
    return NextResponse.json(
      { error: error.message || "Erro interno no servidor." },
      { status: 500 },
    );
  }
}