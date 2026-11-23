// app/api/admin/coupons/sync/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

const supabaseAdmin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

function getBrazilDateParts(isoString: string) {
  const date = new Date(isoString);
  const brDate = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  const year = brDate.getUTCFullYear();
  const month = String(brDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(brDate.getUTCDate()).padStart(2, "0");
  const hour = brDate.getUTCHours();
  const dow = brDate.getUTCDay();
  return {
    dateIso: `${year}-${month}-${day}`,
    dow,
    hour,
  };
}

function parseScheduleRules(coupon: any) {
  let parsed = coupon?.schedule_rules;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  const showCal =
    typeof coupon?.show_on_calendar === "boolean"
      ? coupon.show_on_calendar
      : Boolean(parsed?.show_on_calendar);
  const isCampaign =
    Boolean(parsed?.is_campaign) || Boolean(parsed?.enabled) || Boolean(showCal);

  const dayHours: Record<string, number[]> = {
    "0": [],
    "1": [],
    "2": [],
    "3": [],
    "4": [],
    "5": [],
    "6": [],
  };

  if (parsed?.day_hours && typeof parsed.day_hours === "object") {
    Object.keys(dayHours).forEach((k) => {
      const arr = parsed.day_hours[k];
      if (Array.isArray(arr)) {
        dayHours[k] = arr.map(Number).filter((n: number) => !isNaN(n));
      }
    });
  } else if (
    Array.isArray(parsed?.days_of_week) &&
    Array.isArray(parsed?.allowed_hours)
  ) {
    const hrs = parsed.allowed_hours
      .map(Number)
      .filter((n: number) => !isNaN(n));
    parsed.days_of_week.forEach((d: any) => {
      const k = String(Number(d));
      if (dayHours[k] !== undefined) dayHours[k] = [...hrs];
    });
  }

  return {
    isCampaign,
    campaignName:
      coupon?.campaign_name || parsed?.campaign_name || coupon?.code || "",
    startDate: parsed?.start_date ? String(parsed.start_date).slice(0, 10) : null,
    dayHours,
    hasScheduleRestriction: Object.values(dayHours).some((a) => a.length > 0),
  };
}

function getRoomBaseSlotPrice(room: any, dow: number, hour: number): number {
  let addr = room?.address_details || {};
  if (typeof addr === "string") {
    try {
      addr = JSON.parse(addr);
    } catch {
      addr = {};
    }
  }
  const pricing = addr?.pricing || {};
  const commercial = Number(pricing.hourly || 45);
  const afterHours = pricing.afterHours ? Number(pricing.afterHours) : commercial;
  const weekend = pricing.weekend ? Number(pricing.weekend) : commercial;

  if (dow === 0 || dow === 6) return weekend;
  if (hour >= 18 || hour < 8) return afterHours;
  return commercial;
}

function computeExpectedPromoPrice(
  basePrice: number,
  type: string,
  discountValue: number,
): number {
  if (type === "percentage") {
    return Number(Math.max(0, basePrice * (1 - discountValue / 100)).toFixed(2));
  }
  if (type === "fixed") {
    return Number(Math.max(0, basePrice - discountValue).toFixed(2));
  }
  return basePrice;
}

export async function POST() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
    }

    const { data: adminProfile } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (adminProfile?.role !== "admin") {
      return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }

    const [couponsRes, roomsRes, bookingsRes, existingUsesRes] =
      await Promise.all([
        supabaseAdmin
          .from("coupons")
          .select("*, profiles:affiliate_id (id, full_name, email)")
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("rooms")
          .select("id, name, tier, address_details, host_id, profiles:host_id (full_name)"),
        supabaseAdmin
          .from("bookings")
          .select(
            "id, user_id, room_id, start_time, end_time, status, total_cost, agreed_value_brl, asaas_payment_id, contract_id, booking_origin, created_at",
          )
          .in("status", ["confirmed", "in_progress", "completed"])
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("coupon_uses")
          .select("id, coupon_id, user_id, booking_id, discount_applied, used_at")
          .order("used_at", { ascending: false }),
      ]);

    if (couponsRes.error) throw couponsRes.error;

    const coupons = couponsRes.data || [];
    const rooms = roomsRes.data || [];
    const validBookings = bookingsRes.data || [];
    const existingUses = existingUsesRes.data || [];

    const roomsMap = new Map<string, any>(rooms.map((r: any) => [r.id, r]));
    const validBookingsMap = new Map<string, any>(
      validBookings.map((b: any) => [b.id, b]),
    );

    const parsedCoupons = coupons.map((c: any) => ({
      raw: c,
      parsed: parseScheduleRules(c),
    }));

    // Prioriza campanhas específicas de sala antes de campanhas globais
    const orderedCampaigns = parsedCoupons
      .filter((item) => item.parsed.isCampaign)
      .sort((a, b) => {
        const aSpecific =
          Array.isArray(a.raw.valid_room_ids) && a.raw.valid_room_ids.length > 0
            ? 1
            : 0;
        const bSpecific =
          Array.isArray(b.raw.valid_room_ids) && b.raw.valid_room_ids.length > 0
            ? 1
            : 0;
        if (bSpecific !== aSpecific) return bSpecific - aSpecific;
        return (
          new Date(b.raw.created_at || 0).getTime() -
          new Date(a.raw.created_at || 0).getTime()
        );
      });

    // Mapa de usos já registrados válidos (ignora usos cujo booking foi cancelado ou abandonado em pending_payment)
    const existingUseByBookingAndCoupon = new Set<string>();
    const matchedBookingIds = new Set<string>();

    interface SyncedUseEntry {
      id: string;
      coupon_id: string;
      booking_id: string | null;
      user_id: string;
      room_id: string | null;
      room_name: string;
      clinic_name: string;
      start_time: string | null;
      end_time: string | null;
      booking_status: string;
      paid_brl: number;
      base_price_brl: number;
      discount_applied: number;
      used_at: string;
      is_campaign: boolean;
      campaign_name: string;
    }

    const usesByCouponId = new Map<string, SyncedUseEntry[]>();
    coupons.forEach((c: any) => usesByCouponId.set(c.id, []));

    const couponsById = new Map<string, { raw: any; parsed: ReturnType<typeof parseScheduleRules> }>(
      parsedCoupons.map((p) => [p.raw.id, p]),
    );

    // 1. Aproveita todos os registros existentes em coupon_uses cujas reservas estão válidas
    for (const u of existingUses) {
      const couponEntry = couponsById.get(u.coupon_id);
      if (!couponEntry) continue;

      const linkedBooking = u.booking_id
        ? validBookingsMap.get(u.booking_id)
        : null;

      // Se tinha booking_id, mas o booking não está entre confirmed/in_progress/completed (ex: cancelado ou PIX expirado), ignora
      if (u.booking_id && !linkedBooking) {
        continue;
      }

      if (u.booking_id) {
        existingUseByBookingAndCoupon.add(`${u.coupon_id}_${u.booking_id}`);
        matchedBookingIds.add(u.booking_id);
      }

      const room = linkedBooking ? roomsMap.get(linkedBooking.room_id) : null;
      const roomHost = Array.isArray(room?.profiles)
        ? room?.profiles[0]?.full_name
        : room?.profiles?.full_name;
      const brParts = linkedBooking?.start_time
        ? getBrazilDateParts(linkedBooking.start_time)
        : null;
      const basePrice =
        room && brParts
          ? getRoomBaseSlotPrice(room, brParts.dow, brParts.hour)
          : 0;
      const rawTotal = Number(linkedBooking?.total_cost || 0);
      const rawAgreed = Number(linkedBooking?.agreed_value_brl || 0);
      const paidBrl = rawTotal >= 10 ? rawTotal : rawAgreed;

      usesByCouponId.get(u.coupon_id)?.push({
        id: u.id,
        coupon_id: u.coupon_id,
        booking_id: u.booking_id || null,
        user_id: u.user_id || linkedBooking?.user_id || "",
        room_id: linkedBooking?.room_id || null,
        room_name: room?.name || "Sala não identificada",
        clinic_name: roomHost || "Fusion Clinic",
        start_time: linkedBooking?.start_time || null,
        end_time: linkedBooking?.end_time || null,
        booking_status: linkedBooking?.status || "confirmed",
        paid_brl: Number(paidBrl.toFixed(2)),
        base_price_brl: Number(basePrice.toFixed(2)),
        discount_applied: Number(u.discount_applied || 0),
        used_at: u.used_at || linkedBooking?.created_at || new Date().toISOString(),
        is_campaign: couponEntry.parsed.isCampaign,
        campaign_name: couponEntry.parsed.campaignName,
      });
    }

    // 2. Identifica reservas confirmadas/concluídas que usaram campanha ou cupom e não foram gravadas por conta do RLS
    const newCouponUsesToInsert: Array<{
      coupon_id: string;
      user_id: string;
      booking_id: string;
      discount_applied: number;
      used_at: string;
    }> = [];

    for (const b of validBookings) {
      if (matchedBookingIds.has(b.id)) continue;
      if (b.contract_id) continue;
      const origin = String(b.booking_origin || "");
      if (origin.startsWith("contract") || origin.startsWith("wallet_")) {
        continue;
      }

      const room = roomsMap.get(b.room_id);
      if (!room || !b.start_time) continue;

      const brStart = getBrazilDateParts(b.start_time);
      const baseSlotPrice = getRoomBaseSlotPrice(room, brStart.dow, brStart.hour);
      const rawTotal = Number(b.total_cost || 0);
      const rawAgreed = Number(b.agreed_value_brl || 0);
      const paidBrl = rawTotal >= 10 ? rawTotal : rawAgreed;

      let matchedCoupon: {
        raw: any;
        parsed: ReturnType<typeof parseScheduleRules>;
      } | null = null;

      // Caso A: Marcado explicitamente no booking_origin (campaign_<id> ou coupon_<id>)
      if (origin.startsWith("campaign_") || origin.startsWith("coupon_")) {
        const refId = origin.replace(/^campaign_|^coupon_/, "");
        const found = couponsById.get(refId);
        if (found) matchedCoupon = found;
      }

      // Caso B: Reconciliação retroativa por sala + grade da campanha + preço com desconto real
      if (!matchedCoupon && paidBrl > 0 && paidBrl < baseSlotPrice * 0.95) {
        const bookingCreatedMs = b.created_at
          ? new Date(b.created_at).getTime()
          : new Date(b.start_time).getTime();

        for (const campEntry of orderedCampaigns) {
          const camp = campEntry.raw;
          const rules = campEntry.parsed;

          // Valida sala participante
          if (
            Array.isArray(camp.valid_room_ids) &&
            camp.valid_room_ids.length > 0 &&
            !camp.valid_room_ids.includes(b.room_id)
          ) {
            continue;
          }

          // Valida janela de criação/compra (com folga de 7 dias para edições/recriações da campanha)
          const campRefStartMs = rules.startDate
            ? new Date(`${rules.startDate}T00:00:00-03:00`).getTime()
            : camp.created_at
              ? new Date(camp.created_at).getTime() - 7 * 24 * 60 * 60 * 1000
              : 0;

          if (campRefStartMs > 0 && bookingCreatedMs < campRefStartMs - 24 * 60 * 60 * 1000) {
            continue;
          }

          const dayAllowedHours = rules.dayHours[String(brStart.dow)] || [];
          const matchesSchedule =
            !rules.hasScheduleRestriction ||
            dayAllowedHours.includes(brStart.hour);

          const expectedPromo = computeExpectedPromoPrice(
            baseSlotPrice,
            camp.type,
            Number(camp.discount_value || 0),
          );
          const matchesExpectedPrice =
            Math.abs(paidBrl - expectedPromo) <= 2.5 ||
            (matchesSchedule && paidBrl <= baseSlotPrice - 1);

          if (matchesSchedule && matchesExpectedPrice) {
            matchedCoupon = campEntry;
            break;
          }
        }
      }

      if (!matchedCoupon) continue;

      const couponId = matchedCoupon.raw.id;
      const key = `${couponId}_${b.id}`;
      if (existingUseByBookingAndCoupon.has(key)) continue;

      const discountApplied = Math.max(
        0,
        Number((baseSlotPrice - paidBrl).toFixed(2)),
      );
      const usedAtIso = b.created_at || b.start_time;

      existingUseByBookingAndCoupon.add(key);
      matchedBookingIds.add(b.id);

      newCouponUsesToInsert.push({
        coupon_id: couponId,
        user_id: b.user_id,
        booking_id: b.id,
        discount_applied: discountApplied,
        used_at: usedAtIso,
      });

      const roomHost = Array.isArray(room?.profiles)
        ? room?.profiles[0]?.full_name
        : room?.profiles?.full_name;

      usesByCouponId.get(couponId)?.push({
        id: `sync_${b.id}`,
        coupon_id: couponId,
        booking_id: b.id,
        user_id: b.user_id,
        room_id: b.room_id,
        room_name: room?.name || "Sala",
        clinic_name: roomHost || "Fusion Clinic",
        start_time: b.start_time,
        end_time: b.end_time,
        booking_status: b.status,
        paid_brl: Number(paidBrl.toFixed(2)),
        base_price_brl: Number(baseSlotPrice.toFixed(2)),
        discount_applied: discountApplied,
        used_at: usedAtIso,
        is_campaign: matchedCoupon.parsed.isCampaign,
        campaign_name: matchedCoupon.parsed.campaignName,
      });
    }

    // 3. Persiste no banco os novos usos sincronizados (via supabaseAdmin, sem bloqueio de RLS)
    if (newCouponUsesToInsert.length > 0) {
      const { error: insertErr } = await supabaseAdmin
        .from("coupon_uses")
        .insert(newCouponUsesToInsert);

      if (insertErr) {
        console.warn(
          "[Coupons Sync] Tentando inserção item a item em coupon_uses:",
          insertErr.message,
        );
        for (const item of newCouponUsesToInsert) {
          await supabaseAdmin.from("coupon_uses").insert(item);
        }
      }
    }

    // 4. Atualiza `coupons.current_uses` no banco para ficar 100% sincronizado
    for (const c of coupons) {
      const syncedList = usesByCouponId.get(c.id) || [];
      const realUsesCount = syncedList.length;
      if (Number(c.current_uses || 0) !== realUsesCount) {
        await supabaseAdmin
          .from("coupons")
          .update({ current_uses: realUsesCount })
          .eq("id", c.id);
        c.current_uses = realUsesCount;
      }
    }

    // 5. Enriquece com os dados dos profissionais (nome, e-mail, telefone/WhatsApp)
    const allUserIds = Array.from(
      new Set(
        Array.from(usesByCouponId.values())
          .flat()
          .map((u) => u.user_id)
          .filter(Boolean),
      ),
    );

    const profilesMap = new Map<string, any>();
    if (allUserIds.length > 0) {
      const { data: profs } = await supabaseAdmin
        .from("profiles")
        .select("id, full_name, email, phone, whatsapp, specialty")
        .in("id", allUserIds);
      (profs || []).forEach((p: any) => profilesMap.set(p.id, p));
    }

    // 6. Monta Ranking por Sala (exclusivo para Campanhas de Horário / Black Friday)
    const roomRankingMap = new Map<
      string,
      {
        room_id: string;
        room_name: string;
        clinic_name: string;
        uses_count: number;
        total_revenue_brl: number;
        total_discount_brl: number;
        unique_users: Set<string>;
        campaigns_names: Set<string>;
      }
    >();

    const allCampaignUsesEnriched: any[] = [];

    const enrichedCoupons = coupons.map((c: any) => {
      const rawUses = (usesByCouponId.get(c.id) || []).sort(
        (a, b) =>
          new Date(b.used_at).getTime() - new Date(a.used_at).getTime(),
      );

      const detailedUses = rawUses.map((u) => {
        const prof = profilesMap.get(u.user_id);
        const enrichedEntry = {
          ...u,
          specialist_name: prof?.full_name || "Profissional",
          specialist_email: prof?.email || "",
          specialist_phone: prof?.whatsapp || prof?.phone || "",
          specialist_specialty: prof?.specialty || "",
        };

        if (u.is_campaign) {
          allCampaignUsesEnriched.push(enrichedEntry);
          if (u.room_id) {
            const existing = roomRankingMap.get(u.room_id) || {
              room_id: u.room_id,
              room_name: u.room_name,
              clinic_name: u.clinic_name,
              uses_count: 0,
              total_revenue_brl: 0,
              total_discount_brl: 0,
              unique_users: new Set<string>(),
              campaigns_names: new Set<string>(),
            };
            existing.uses_count += 1;
            existing.total_revenue_brl += u.paid_brl;
            existing.total_discount_brl += u.discount_applied;
            if (u.user_id) existing.unique_users.add(u.user_id);
            if (u.campaign_name) existing.campaigns_names.add(u.campaign_name);
            roomRankingMap.set(u.room_id, existing);
          }
        }

        return enrichedEntry;
      });

      const totalRevenueBrl = detailedUses.reduce(
        (acc, u) => acc + u.paid_brl,
        0,
      );
      const totalDiscountBrl = detailedUses.reduce(
        (acc, u) => acc + u.discount_applied,
        0,
      );
      const uniqueSpecialistsCount = new Set(
        detailedUses.map((u) => u.user_id).filter(Boolean),
      ).size;

      const roomNames =
        Array.isArray(c.valid_room_ids) && c.valid_room_ids.length > 0
          ? c.valid_room_ids
              .map((rid: string) => roomsMap.get(rid)?.name)
              .filter(Boolean)
          : [];

      return {
        ...c,
        current_uses: detailedUses.length,
        synced_revenue_brl: Number(totalRevenueBrl.toFixed(2)),
        synced_discount_brl: Number(totalDiscountBrl.toFixed(2)),
        unique_specialists_count: uniqueSpecialistsCount,
        room_names: roomNames,
        synced_uses: detailedUses,
      };
    });

    // Inclui também salas participantes com 0 usos no ranking para o admin ter visão completa
    for (const campEntry of orderedCampaigns) {
      const rIds = Array.isArray(campEntry.raw.valid_room_ids)
        ? campEntry.raw.valid_room_ids
        : [];
      for (const rid of rIds) {
        if (!roomRankingMap.has(rid)) {
          const rObj = roomsMap.get(rid);
          if (rObj) {
            const roomHost = Array.isArray(rObj?.profiles)
              ? rObj?.profiles[0]?.full_name
              : rObj?.profiles?.full_name;
            roomRankingMap.set(rid, {
              room_id: rid,
              room_name: rObj.name || "Sala",
              clinic_name: roomHost || "Fusion Clinic",
              uses_count: 0,
              total_revenue_brl: 0,
              total_discount_brl: 0,
              unique_users: new Set<string>(),
              campaigns_names: new Set<string>([campEntry.parsed.campaignName]),
            });
          }
        }
      }
    }

    const roomRanking = Array.from(roomRankingMap.values())
      .map((item) => ({
        room_id: item.room_id,
        room_name: item.room_name,
        clinic_name: item.clinic_name,
        uses_count: item.uses_count,
        total_revenue_brl: Number(item.total_revenue_brl.toFixed(2)),
        total_discount_brl: Number(item.total_discount_brl.toFixed(2)),
        unique_specialists_count: item.unique_users.size,
        campaigns_names: Array.from(item.campaigns_names),
      }))
      .sort((a, b) => {
        if (b.uses_count !== a.uses_count) return b.uses_count - a.uses_count;
        return b.total_revenue_brl - a.total_revenue_brl;
      });

    allCampaignUsesEnriched.sort(
      (a, b) =>
        new Date(b.used_at).getTime() - new Date(a.used_at).getTime(),
    );

    return NextResponse.json({
      success: true,
      newlySyncedCount: newCouponUsesToInsert.length,
      coupons: enrichedCoupons,
      roomRanking,
      allCampaignUses: allCampaignUsesEnriched,
    });
  } catch (error: any) {
    console.error("[Coupons Sync] Erro:", error);
    return NextResponse.json(
      { error: error.message || "Erro ao sincronizar campanhas e cupons." },
      { status: 500 },
    );
  }
}