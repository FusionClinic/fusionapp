// app/api/admin/bookings/update/route.ts
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
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
    }

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (profile?.role !== "admin") {
      return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }

    const body = await request.json();
    const { bookingId, agreedValueBrl, notes } = body;

    if (!bookingId) {
      return NextResponse.json(
        { error: "ID da reserva é obrigatório." },
        { status: 400 },
      );
    }

    const updatePayload: Record<string, any> = {};

    if (agreedValueBrl !== undefined) {
      if (agreedValueBrl === null || agreedValueBrl === "") {
        updatePayload.agreed_value_brl = null;
      } else {
        const parsedVal = Number(String(agreedValueBrl).replace(",", "."));
        if (isNaN(parsedVal) || parsedVal < 0) {
          return NextResponse.json(
            { error: "Valor informado é inválido." },
            { status: 400 },
          );
        }
        updatePayload.agreed_value_brl = Number(parsedVal.toFixed(2));
      }
    }

    if (notes !== undefined) {
      updatePayload.notes =
        typeof notes === "string" && notes.trim().length > 0
          ? notes.trim()
          : null;
    }

    const { data, error } = await supabaseAdmin
      .from("bookings")
      .update(updatePayload)
      .eq("id", bookingId)
      .select(
        "id, agreed_value_brl, notes, total_cost, status, start_time, end_time",
      )
      .single();

    if (error) throw error;

    return NextResponse.json({
      success: true,
      booking: data,
    });
  } catch (error: any) {
    console.error("Erro ao atualizar reserva pelo Admin:", error);
    return NextResponse.json(
      { error: error.message || "Erro interno ao atualizar reserva." },
      { status: 500 },
    );
  }
}