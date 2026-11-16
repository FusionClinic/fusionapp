// app/api/admin/notifications/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

const supabaseAdmin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

export async function PATCH(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profile?.role !== "admin") {
      return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }

    const body = await request.json();
    const { action, ids } = body;

    if (action === "mark_read") {
      const nowIso = new Date().toISOString();
      let query = supabaseAdmin.from("admin_notifications").update({
        is_read: true,
        read_at: nowIso,
      });

      if (Array.isArray(ids) && ids.length > 0) {
        query = query.in("id", ids);
      } else {
        query = query.eq("is_read", false);
      }

      const { error } = await query;
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    if (action === "clear_read") {
      const { error } = await supabaseAdmin
        .from("admin_notifications")
        .delete()
        .eq("is_read", true);

      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
  } catch (error: any) {
    console.error("Erro na API de notificações admin:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}