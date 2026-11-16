// app/api/admin/notifications/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

const supabaseAdmin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function verifyAdminUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.role !== "admin") return null;
  return user;
}

export async function GET() {
  try {
    const adminUser = await verifyAdminUser();
    if (!adminUser) {
      return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }

    // Listas persistentes de IDs lidos e limpos salvos nos metadados do Admin
    const readIdsSet = new Set<string>(
      Array.isArray(adminUser.user_metadata?.admin_read_notif_ids)
        ? adminUser.user_metadata.admin_read_notif_ids
        : [],
    );
    const clearedIdsSet = new Set<string>(
      Array.isArray(adminUser.user_metadata?.admin_cleared_notif_ids)
        ? adminUser.user_metadata.admin_cleared_notif_ids
        : [],
    );

    const [adminNotifsRes, bookingsRes, profilesRes, roomsRes] =
      await Promise.all([
        supabaseAdmin
          .from("admin_notifications")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100),
        supabaseAdmin
          .from("bookings")
          .select(
            "id, user_id, room_id, start_time, end_time, status, total_cost, agreed_value_brl, booking_origin, created_at",
          )
          .order("created_at", { ascending: false })
          .limit(60),
        supabaseAdmin
          .from("profiles")
          .select(
            "id, full_name, email, phone, whatsapp, cpf, role, specialty, created_at",
          )
          .order("created_at", { ascending: false })
          .limit(80),
        supabaseAdmin
          .from("rooms")
          .select("id, name, host_id, tier, is_active, created_at")
          .order("created_at", { ascending: false })
          .limit(40),
      ]);

    const dbNotifications = adminNotifsRes.data || [];
    const bookings = bookingsRes.data || [];
    const profiles = profilesRes.data || [];
    const rooms = roomsRes.data || [];

    const profilesMap = new Map<string, any>();
    profiles.forEach((p: any) => profilesMap.set(p.id, p));

    const roomsMap = new Map<string, any>();
    rooms.forEach((r: any) => roomsMap.set(r.id, r));

    // Caso alguma reserva referencie um perfil ou sala fora do lote inicial, busca complementar
    const missingUserIds = Array.from(
      new Set(
        bookings
          .map((b: any) => b.user_id)
          .filter((id: string) => id && !profilesMap.has(id)),
      ),
    );
    const missingRoomIds = Array.from(
      new Set(
        bookings
          .map((b: any) => b.room_id)
          .filter((id: string) => id && !roomsMap.has(id)),
      ),
    );

    if (missingUserIds.length > 0) {
      const { data: extraProfiles } = await supabaseAdmin
        .from("profiles")
        .select("id, full_name, email, phone, whatsapp, cpf, role, specialty")
        .in("id", missingUserIds);
      (extraProfiles || []).forEach((p: any) => profilesMap.set(p.id, p));
    }

    if (missingRoomIds.length > 0) {
      const { data: extraRooms } = await supabaseAdmin
        .from("rooms")
        .select("id, name, host_id, tier, is_active")
        .in("id", missingRoomIds);
      (extraRooms || []).forEach((r: any) => roomsMap.set(r.id, r));
    }

    const unifiedMap = new Map<string, any>();
    const coveredBookingEvents = new Set<string>();
    const coveredUserEvents = new Set<string>();
    const coveredRoomEvents = new Set<string>();

    // 1. Adiciona registros da tabela admin_notifications
    dbNotifications.forEach((n: any) => {
      const id = String(n.id);
      if (clearedIdsSet.has(id)) return;

      const meta =
        typeof n.metadata === "string"
          ? (() => {
              try {
                return JSON.parse(n.metadata);
              } catch {
                return {};
              }
            })()
          : n.metadata || {};

      if (meta.booking_id) {
        coveredBookingEvents.add(`${n.event_type}_${meta.booking_id}`);
      }
      if (meta.user_id && String(n.event_type).includes("registered")) {
        coveredUserEvents.add(String(meta.user_id));
      }
      if (meta.room_id && n.event_type === "room_created") {
        coveredRoomEvents.add(String(meta.room_id));
      }

      const isRead = Boolean(n.is_read) || readIdsSet.has(id);

      unifiedMap.set(id, {
        id,
        source: "table",
        event_type: n.event_type || "booking_created",
        title: n.title || "Notificação do Sistema",
        message: n.message || "",
        metadata: meta,
        is_read: isRead,
        read_at: n.read_at || (isRead ? new Date().toISOString() : null),
        created_at: n.created_at || new Date().toISOString(),
      });
    });

    // 2. Sintetiza eventos de Reservas e Cancelamentos (caso não estejam duplicados na tabela)
    bookings.forEach((b: any) => {
      if (
        b.booking_origin &&
        String(b.booking_origin).startsWith("contract_")
      ) {
        return;
      }

      const isCancelled = b.status === "cancelled";
      const eventType = isCancelled ? "booking_cancelled" : "booking_created";
      const dedupKey = `${eventType}_${b.id}`;
      if (coveredBookingEvents.has(dedupKey)) return;

      const synthId = `synth_booking_${b.id}_${isCancelled ? "canc" : "conf"}`;
      if (clearedIdsSet.has(synthId)) return;

      const spec = profilesMap.get(b.user_id);
      const room = roomsMap.get(b.room_id);
      const userName = spec?.full_name || "Profissional";
      const roomName = room?.name || "Consultório Fusion";

      const startObj = b.start_time ? new Date(b.start_time) : new Date();
      const dd = String(startObj.getDate()).padStart(2, "0");
      const mm = String(startObj.getMonth() + 1).padStart(2, "0");
      const yyyy = startObj.getFullYear();
      const hh = String(startObj.getHours()).padStart(2, "0");
      const min = String(startObj.getMinutes()).padStart(2, "0");
      const formattedDate = `${dd}/${mm}/${yyyy}`;
      const formattedHour = `${hh}:${min}`;

      const isRead = readIdsSet.has(synthId);

      unifiedMap.set(synthId, {
        id: synthId,
        source: "synthesized",
        event_type: eventType,
        title: isCancelled
          ? "Reserva Cancelada"
          : "📅 Nova Reserva Confirmada",
        message: isCancelled
          ? `${userName} cancelou a reserva da sala ${roomName} de ${formattedDate} às ${formattedHour}.`
          : `${userName} agendou a sala ${roomName} para ${formattedDate} às ${formattedHour}.`,
        metadata: {
          booking_id: b.id,
          user_id: b.user_id,
          room_id: b.room_id,
          user_name: userName,
          user_email: spec?.email || null,
          user_phone: spec?.whatsapp || spec?.phone || null,
          user_cpf: spec?.cpf || null,
          user_specialty: spec?.specialty || null,
          room_name: roomName,
          date: formattedDate,
          first_hour: formattedHour,
          status: b.status,
          amount_brl: Number(b.agreed_value_brl || b.total_cost || 0),
          target_tab: "agendamentos",
        },
        is_read: isRead,
        read_at: isRead ? new Date().toISOString() : null,
        created_at: b.created_at || b.start_time || new Date().toISOString(),
      });
    });

    // 3. Sintetiza eventos de Cadastros de Especialistas e Anfitriões
    profiles.forEach((p: any) => {
      if (p.role === "admin") return;
      if (coveredUserEvents.has(String(p.id))) return;

      const synthId = `synth_user_${p.id}`;
      if (clearedIdsSet.has(synthId)) return;

      const isHost = p.role === "host";
      const eventType = isHost ? "host_registered" : "specialist_registered";
      const userName = p.full_name || "Novo Usuário";
      const isRead = readIdsSet.has(synthId);

      unifiedMap.set(synthId, {
        id: synthId,
        source: "synthesized",
        event_type: eventType,
        title: isHost
          ? "🏢 Novo Parceiro Cadastrado"
          : "👨‍⚕️ Novo Especialista Cadastrado",
        message: isHost
          ? `${userName} cadastrou uma conta de anfitrião/clínica parceira.`
          : `${userName} (${p.specialty || "Saúde"}) criou uma conta na plataforma.`,
        metadata: {
          user_id: p.id,
          user_name: userName,
          user_email: p.email || null,
          user_phone: p.whatsapp || p.phone || null,
          user_cpf: p.cpf || null,
          user_specialty: p.specialty || null,
          target_tab: isHost ? "parceiros" : "especialistas",
        },
        is_read: isRead,
        read_at: isRead ? new Date().toISOString() : null,
        created_at: p.created_at || new Date().toISOString(),
      });
    });

    // 4. Sintetiza eventos de Novas Salas
    rooms.forEach((r: any) => {
      if (coveredRoomEvents.has(String(r.id))) return;

      const synthId = `synth_room_${r.id}`;
      if (clearedIdsSet.has(synthId)) return;

      const hostProfile = profilesMap.get(r.host_id);
      const hostName = hostProfile?.full_name || "Parceiro Fusion";
      const isRead = readIdsSet.has(synthId);

      unifiedMap.set(synthId, {
        id: synthId,
        source: "synthesized",
        event_type: "room_created",
        title: "🚪 Nova Sala Publicada",
        message: `${hostName} cadastrou o consultório ${r.name}.`,
        metadata: {
          room_id: r.id,
          room_name: r.name,
          host_name: hostName,
          tier: r.tier,
          target_tab: "salas",
        },
        is_read: isRead,
        read_at: isRead ? new Date().toISOString() : null,
        created_at: r.created_at || new Date().toISOString(),
      });
    });

    const sortedList = Array.from(unifiedMap.values())
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .slice(0, 120);

    return NextResponse.json({ notifications: sortedList });
  } catch (error: any) {
    console.error("Erro no GET /api/admin/notifications:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const adminUser = await verifyAdminUser();
    if (!adminUser) {
      return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }

    const body = await request.json();
    const { action, ids = [] } = body;

    const targetIds: string[] = Array.isArray(ids)
      ? ids.map(String).filter(Boolean)
      : [];

    const existingReadIds: string[] = Array.isArray(
      adminUser.user_metadata?.admin_read_notif_ids,
    )
      ? adminUser.user_metadata.admin_read_notif_ids
      : [];
    const existingClearedIds: string[] = Array.isArray(
      adminUser.user_metadata?.admin_cleared_notif_ids,
    )
      ? adminUser.user_metadata.admin_cleared_notif_ids
      : [];

    const realDbUuidIds = targetIds.filter((id) => !id.startsWith("synth_"));
    const nowIso = new Date().toISOString();

    if (action === "mark_read") {
      if (realDbUuidIds.length > 0) {
        await supabaseAdmin
          .from("admin_notifications")
          .update({ is_read: true, read_at: nowIso })
          .in("id", realDbUuidIds);
      } else if (targetIds.length === 0) {
        await supabaseAdmin
          .from("admin_notifications")
          .update({ is_read: true, read_at: nowIso })
          .eq("is_read", false);
      }

      const nextRead = Array.from(
        new Set([...existingReadIds, ...targetIds]),
      ).slice(-500);

      await supabaseAdmin.auth.admin.updateUserById(adminUser.id, {
        user_metadata: {
          ...adminUser.user_metadata,
          admin_read_notif_ids: nextRead,
        },
      });

      return NextResponse.json({ success: true });
    }

    if (action === "clear_read" || action === "clear_all" || action === "delete_one") {
      if (realDbUuidIds.length > 0) {
        await supabaseAdmin
          .from("admin_notifications")
          .delete()
          .in("id", realDbUuidIds);
      } else if (action === "clear_read") {
        await supabaseAdmin
          .from("admin_notifications")
          .delete()
          .eq("is_read", true);
      } else if (action === "clear_all") {
        await supabaseAdmin
          .from("admin_notifications")
          .delete()
          .neq("id", "00000000-0000-0000-0000-000000000000");
      }

      const nextCleared = Array.from(
        new Set([...existingClearedIds, ...targetIds]),
      ).slice(-600);

      await supabaseAdmin.auth.admin.updateUserById(adminUser.id, {
        user_metadata: {
          ...adminUser.user_metadata,
          admin_cleared_notif_ids: nextCleared,
        },
      });

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
  } catch (error: any) {
    console.error("Erro no PATCH /api/admin/notifications:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}